/**
 * Executor JSONL audit ledger.
 *
 * Every verb invocation writes one line with the timing, redacted request,
 * full response envelope, and chain metadata. Also carries the standing line
 * types: executor_started, executor_stream_gap, policy_rejected,
 * rpc_failover.
 *
 * Private keys, KMS material, signed transaction bytes, and environment dumps
 * are stripped before anything is written. Wallet public keys and signatures
 * pass through.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ExecutorConfig } from './config.js';
import { initLogger, logger } from './vendor/lp-monitor/logger.js';
import type { RawAmount } from './protocol.js';

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

// Public-key-shaped base58 is safe to log; secrets (64-byte) are 87-88 chars
// while pubkeys/signatures are 43-45 or 88 chars — indistinguishable by
// shape, so the filter keys primarily on field names, with a length-floor
// heuristic only where field names give no hint. Known-safe field names
// (wallet pubkey + signatures) always pass.
const SECRET_FIELD_RE =
  /(secret|privat|priv|seed_pair|mnemonic|bip39|wallet_secret|kms_plaintext|signing_key)/i;
const TX_BYTES_FIELD_RE = /(tx_bytes|signed_transaction|serialized_tx|payload_bytes)/i;
const ENV_FIELD_RE = /^(env|environment|process_env|env_dump|kms_material)$/i;
// 64-byte seeds encode to 87-88 base58 chars, but a secret may also ride in
// an unknown field at 64+ chars; pubkeys (43-45) are always below the floor,
// and declared-safe fields short-circuit above anyway.
const SECRET_SHAPED_RE = /^[1-9A-HJ-NP-Za-km-z]{64,}$/;
const HEX_BYTES_RE = /^(0x)?[0-9a-f]{200,}$/;
const ENV_VALUE_RE =
  /\b(SOLANA_RPC_URL|KMS_KEY_ARN|WALLET_SECRET_ARN|PRIVATE_KEY|SECRET_ACCESS_KEY|PASSWORD)["']?\s*[:=]/;

// Field names whose values are declared safe by the spec: wallet pubkey +
// signatures pass redaction.
const PUBLIC_FIELD_RE =
  /^(tx_signatures|tx_signature|signature|from_signature|to_signature|signer_pubkey|wallet_pubkey|pubkey)$/i;

const REDACTED = '[REDACTED]';

function redactLeaf(key: string, value: Json): Json {
  if (typeof value !== 'string') return value;
  if (PUBLIC_FIELD_RE.test(key)) return value;
  if (key === 'policy_hash' && /^[a-f0-9]{64}$/.test(value)) return value;
  if (SECRET_FIELD_RE.test(key)) return REDACTED;
  if (TX_BYTES_FIELD_RE.test(key)) return REDACTED;
  if (HEX_BYTES_RE.test(value)) return REDACTED;
  if (SECRET_SHAPED_RE.test(value)) return REDACTED;
  if (ENV_VALUE_RE.test(value)) return REDACTED;
  // Catch secret-shaped values embedded in prose (e.g. exception details).
  return value.replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, REDACTED);
}

export function redact(value: Json, keyHint = ''): Json {
  // Redact the entire field before descending into arrays/objects.
  if (
    SECRET_FIELD_RE.test(keyHint) ||
    TX_BYTES_FIELD_RE.test(keyHint) ||
    ENV_FIELD_RE.test(keyHint)
  ) {
    return REDACTED;
  }
  if (
    /^(rpc_.*url|rpc_endpoint|from_endpoint|to_endpoint)$/.test(keyHint) &&
    typeof value === 'string'
  ) {
    return redactEndpoint(value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, keyHint));
  if (value === null || typeof value !== 'object') return redactLeaf(keyHint, value);
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = redact(v, key);
  }
  return out;
}

/** Keep the provider identifiable without publishing URL credentials or keys. */
export function redactEndpoint(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return REDACTED;
  }
}

export function logError(detail: string): void {
  logger.error(redact(detail));
}

export { initLogger };

export interface VerbLine {
  kind: 'verb';
  req_seq: number;
  method: string;
  received_at: number;
  responded_at: number;
  duration_ms: number;
  /** Parallel get_state component latencies, recorded for read-tail diagnosis. */
  read_timings_ms?: Record<string, number>;
  rpc_cu_wait_ms?: Record<string, number>;
  rpc_http_ms?: Record<string, number>;
  request: Json;
  response: Json;
  attempt: number;
  rpc_endpoint: string | null;
  blockhash: string | null;
  simulation_ok: boolean | null;
  simulation_logs?: string[];
  policy_decision: string | null;
  /** sha256 of every message this verb validated for signing, in signing order. */
  message_hashes: string[];
  signer_id: string | null;
  bundle_id: string | null;
}

export interface ExecutorStartedLine {
  kind: 'executor_started';
  ts: number;
  node_version: string;
  dlmm_sdk_version: string;
  git_sha: string | null;
  rpc_read_url: string;
  rpc_write_url: string;
  rpc_ws_url: string | null;
  rpc_max_cu_per_second: number;
  pool_allowlist: string[];
  mint_allowlist: string[];
  wallet_pubkey: string;
  policy_hash: string;
  dry_run: boolean;
  run_counter_note: string;
}

export interface ExecutorStreamGapLine {
  kind: 'executor_stream_gap';
  ts: number;
  pool: string;
  from_signature: string | null;
  to_signature: string | null;
  from_slot: number | null;
  to_slot: number | null;
  backfilled: number;
  recovery_source?: 'slot' | 'history' | 'none';
  recovery_complete?: boolean;
}

export interface PolicyRejectedLine {
  kind: 'policy_rejected';
  ts: number;
  method: string;
  rule: string;
  detail: string;
}

export interface RpcFailoverLine {
  kind: 'rpc_failover';
  ts: number;
  from_endpoint: string;
  to_endpoint: string;
  error: string;
}

/**
 * One Jito bundle attempt (plan T5.3): the ordered component signatures, the
 * shared block-height bound, every observed status transition, and the final
 * classification. Serialized transactions themselves never appear here.
 */
export interface JitoBundleLine {
  kind: 'jito_bundle';
  ts: number;
  method: string;
  bundle_id: string | null;
  component_signatures: string[];
  last_valid_block_height: number | null;
  statuses: string[];
  outcome: 'landed' | 'dropped' | 'ambiguous';
}

export type ExecutorLine =
  | VerbLine
  | ExecutorStartedLine
  | ExecutorStreamGapLine
  | PolicyRejectedLine
  | RpcFailoverLine
  | JitoBundleLine;

function redactLine(line: ExecutorLine): JsonObject {
  const clone = redact(line as unknown as Json) as JsonObject;
  return clone;
}

/** Daily rotation + gzip after 24h. Files rotate per run anyway. */
export interface Rotator {
  maybeGzipOlder(dir: string, pattern: RegExp): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Gzip rotated logs older than 24h, in place (.jsonl.gz). */
export function gzipOlderThan(dir: string, ageMs = DAY_MS, activeFile?: string): number {
  const now = Date.now();
  let done = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^executor-.+\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      if (file === activeFile) continue;
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > ageMs) {
          fs.writeFileSync(file + '.gz', gzipSync(fs.readFileSync(file)), { flag: 'wx' });
          fs.unlinkSync(file);
          done += 1;
        }
      } catch {
        // a locked/empty file just survives this pass
      }
    }
  } catch {
    // unreadable dir: skip
  }
  return done;
}

export class ExecutorLog {
  private readonly runId: string;
  private readonly dir: string;
  private file: string;
  private fd: number | null;
  private day: string;
  private lastGzipCheck = 0;

  constructor(config: ExecutorConfig, runId: string) {
    this.runId = runId;
    this.dir = path.resolve(config.executorLogDir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, `executor-${this.runId}.jsonl`);
    this.fd = fs.openSync(this.file, 'a');
    this.day = new Date().toISOString().slice(0, 10);
  }

  get path(): string {
    return this.file;
  }

  write(line: ExecutorLine): void {
    if (this.fd === null) throw new Error('Executor log is closed');
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) {
      const file = path.join(this.dir, `executor-${this.runId}-${day}.jsonl`);
      const fd = fs.openSync(file, 'a');
      fs.closeSync(this.fd);
      this.fd = fd;
      this.file = file;
      this.day = day;
    }
    const payload = redactLine(line);
    const bytes = Buffer.from(JSON.stringify(payload) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error('Executor log write made no progress');
      offset += written;
    }
    const now = Date.now();
    if (now - this.lastGzipCheck > 60_000) {
      this.lastGzipCheck = now;
      gzipOlderThan(this.dir, DAY_MS, this.file);
    }
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export function newRunId(): string {
  return `${Date.now().toString(36)}${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export type { RawAmount };
