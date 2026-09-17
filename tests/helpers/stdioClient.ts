/**
 * Functional test harness.
 *
 * Drives the same compiled subprocess (`dist/bridge.js`) the keeper uses via
 * its ExecBridge pattern — never an assumed HTTP service. Also carries the
 * live-run guards (DRY_RUN=false + LIVE_WRITE_CONFIRM=yes + run ID) and the
 * JSON artifact writer required for every live run.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ExecRequest, ExecResponse } from '../../src/protocol.js';
import { baseEnv } from '../../src/testing.js';

export const BRIDGE_PATH = fileURLToPath(new URL('../../dist/bridge.js', import.meta.url));
export const STUB_BRIDGE_PATH = fileURLToPath(
  new URL('../../fixtures/stub-runner.mjs', import.meta.url),
);

/** Offline suites still need the compiled CLI; fail with a fixable message. */
export function requireBuiltBridge(): string {
  if (!fs.existsSync(BRIDGE_PATH)) {
    throw new Error('dist/bridge.js is missing — run `npm run build` before the harness');
  }
  return STUB_BRIDGE_PATH;
}

/** The production entrypoint, used only by opt-in live-chain suites. */
export function requireProductionBridge(): string {
  if (!fs.existsSync(BRIDGE_PATH)) {
    throw new Error('dist/bridge.js is missing — run `npm run build` before the harness');
  }
  return BRIDGE_PATH;
}

// ------------------------------------------------------------------- guards

/** Collection flag for tests/functional; ordinary `npm test` never sets it. */
export const LIVE_COLLECTION_ENABLED = process.env['RUN_LIVE'] === '1';

const SECRET_ENV_RE = /(PRIVATE_KEY|WALLET_SECRET(?!_ARN)|MNEMONIC|SEED|KMS_PLAINTEXT)/i;
const STATIC_AWS_CREDENTIAL_RE = /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)$/;

/**
 * Hard rule: the private key or seed must never be a test
 * environment variable. The subprocess gets only ARN references.
 */
export function assertNoSecretEnvs(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if ((SECRET_ENV_RE.test(key) || STATIC_AWS_CREDENTIAL_RE.test(key)) && value) {
      throw new Error(`refusing to pass secret-bearing env var to subprocess: ${key}`);
    }
  }
}

const WRITE_GATEWAY_KEYS = [
  'SOLANA_RPC_URL', 'SOLANA_RPC_WRITE_URL', 'SOLANA_WS_URL', 'SOLANA_RPC_MAX_CU_PER_SECOND',
  'SOLANA_COMMITMENT', 'WALLET_SIGNER', 'KMS_KEY_ARN', 'WALLET_KEYPAIR_PATH',
  'WALLET_PUBKEY', 'FILE_SIGNER_ALLOW_MAINNET', 'POOL_ALLOWLIST', 'MINT_ALLOWLIST',
  'MAX_SOL_PER_TX', 'MAX_SOL_PER_RUN', 'MAX_SLIPPAGE_BPS', 'MAX_PRIORITY_FEE_LAMPORTS',
  'MAX_ACTIVE_BIN_SLIPPAGE_BINS',
  'JITO_ENABLED', 'JITO_BLOCK_ENGINE_URL', 'JITO_TIP_LAMPORTS',
  'JITO_TIP_ACCOUNT', 'JITO_TIP_ACCOUNTS',
] as const;

/**
 * Explicitly copy the safe gateway configuration for a live write campaign.
 * `scratchEnv` has fixture defaults; writes must never inherit those defaults
 * for a real wallet, especially not the fixture KMS ARN or pool allow-lists.
 */
export function liveWriteGatewayEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertNoSecretEnvs(env);
  const signer = env['WALLET_SIGNER'];
  if (signer !== 'kms' && signer !== 'file') throw new Error('WALLET_SIGNER=kms|file required');
  for (const key of [
    'SOLANA_RPC_URL', 'WALLET_PUBKEY', 'MAX_SOL_PER_TX', 'MAX_SOL_PER_RUN',
    'MAX_SLIPPAGE_BPS', 'MAX_ACTIVE_BIN_SLIPPAGE_BINS', 'MAX_PRIORITY_FEE_LAMPORTS',
  ]) {
    if (!env[key]) throw new Error(`${key} required for live writes`);
  }
  if (signer === 'kms' && !env['KMS_KEY_ARN']) throw new Error('KMS_KEY_ARN required for kms writes');
  if (signer === 'file' && !env['WALLET_KEYPAIR_PATH']) {
    throw new Error('WALLET_KEYPAIR_PATH required for file writes');
  }
  const poolAllowlist = env['POOL_ALLOWLIST'] ?? env['LIVE_POOL'];
  const mintAllowlist = env['MINT_ALLOWLIST'] ?? (
    env['LIVE_BASE_MINT'] && env['LIVE_QUOTE_MINT']
      ? `${env['LIVE_BASE_MINT']},${env['LIVE_QUOTE_MINT']}`
      : undefined
  );
  if (!poolAllowlist || !mintAllowlist) throw new Error('POOL_ALLOWLIST/LIVE_POOL and mints required');
  const picked: NodeJS.ProcessEnv = {
    DRY_RUN: 'false', POOL_ALLOWLIST: poolAllowlist, MINT_ALLOWLIST: mintAllowlist,
  };
  for (const key of WRITE_GATEWAY_KEYS) {
    if (env[key] !== undefined) picked[key] = env[key];
  }
  return picked;
}

export interface LiveWriteGuard {
  runId: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Write campaigns need three independent switches: RUN_LIVE=1 to collect the
 * suite, DRY_RUN=false in the subprocess env, and LIVE_WRITE_CONFIRM=yes plus
 * a LIVE_RUN_ID so an ordinary production configuration can never activate a
 * test campaign by accident.
 */
export function requireLiveWriteConfig(): LiveWriteGuard {
  if (!LIVE_COLLECTION_ENABLED) throw new Error('live suite collected without RUN_LIVE=1');
  const runId = process.env['LIVE_RUN_ID'] ?? '';
  if (process.env['LIVE_WRITE_CONFIRM'] !== 'yes' || runId.trim() === '') {
    throw new Error('live writes require LIVE_WRITE_CONFIRM=yes and LIVE_RUN_ID');
  }
  if (process.env['DRY_RUN'] !== 'false') {
    throw new Error('live writes require the runner env to set DRY_RUN=false');
  }
  return { runId, env: {} };
}

// ----------------------------------------------------------------- env / fs

export interface ScratchEnv {
  env: NodeJS.ProcessEnv;
  logDir: string;
  swapStreamPath: string;
  dispose(): void;
}

/** Full §9 configuration surface for the subprocess, with temp filesystem. */
export function scratchEnv(overrides: NodeJS.ProcessEnv = {}): ScratchEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-harness-'));
  const logDir = path.join(dir, 'executor-logs');
  const swapStreamPath = path.join(dir, 'swaps.jsonl');
  fs.mkdirSync(logDir);
  const env = {
    ...baseEnv({
      DRY_RUN: 'true',
      EXECUTOR_LOG_DIR: logDir,
      SWAP_STREAM_PATH: swapStreamPath,
      ...overrides,
    }),
  };
  assertNoSecretEnvs(env);
  return {
    env,
    logDir,
    swapStreamPath,
    dispose() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Shell env for a spawned subprocess: inherits the runner environment minus
 * any secret-bearing variables — the key/seed must never ride the env.
 */
export function subprocessEnv(scratch: ScratchEnv, runnerEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(runnerEnv)) {
    if (value === undefined || SECRET_ENV_RE.test(key)) continue;
    safe[key] = value;
  }
  return { ...safe, ...scratch.env };
}

// ------------------------------------------------------------- stdio client

export interface TranscriptEntry {
  direction: 'req' | 'resp';
  line: unknown;
  at: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One JSON request line in, one JSON response line out. The executor answers
 * strictly in request order, so correlation is positional.
 */
export class StdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private iterator: AsyncIterator<string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stderr = '';
  readonly transcript: TranscriptEntry[] = [];
  exitCode: number | null = null;

  constructor(
    private readonly bridgePath: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  start(): void {
    if (this.child) throw new Error('client already started');
    this.child = spawn(process.execPath, [this.bridgePath], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr += String(chunk); });
    this.iterator = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  }

  /** Serialized: each request waits for the previous exchange to finish. */
  request(request: ExecRequest): Promise<ExecResponse> {
    const next = this.chain.then(() => this.exchange(request));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Queue a raw line without consuming a response; the next request() reads it. */
  writeRaw(line: string): void {
    if (!this.child) throw new Error('client not started');
    this.transcript.push({ direction: 'req', line, at: Date.now() });
    this.child.stdin.write(line + '\n');
  }

  private async exchange(request: ExecRequest): Promise<ExecResponse> {
    if (!this.child || !this.iterator) throw new Error('client not started');
    this.transcript.push({ direction: 'req', line: request, at: Date.now() });
    this.child.stdin.write(JSON.stringify(request) + '\n');
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout waiting for response to ${request.method}`)), this.timeoutMs);
    });
    const { value, done } = await Promise.race([this.iterator.next(), timer]);
    if (done) throw new Error('subprocess closed stdout before responding');
    const response = JSON.parse(value) as ExecResponse;
    this.transcript.push({ direction: 'resp', line: response, at: Date.now() });
    return response;
  }

  /** Close stdin and wait for a clean exit; captures the exit code. */
  async close(): Promise<number> {
    if (!this.child) return 0;
    const child = this.child;
    this.child = null;
    this.iterator = null;
    child.stdin.end();
    return new Promise((resolve) => {
      child.once('exit', (code) => { this.exitCode = code; resolve(code ?? -1); });
    });
  }

  lastStderr(): string {
    return this.stderr;
  }

  /** Raw stdin access for framing tests that must send non-JSON lines. */
  raw(): ChildProcessWithoutNullStreams {
    if (!this.child) throw new Error('client not started');
    return this.child;
  }
}

// --------------------------------------------------------- executor log I/O

export interface ExecutorAuditLine {
  kind: string;
  duration_ms?: number;
  req_seq?: number;
  method?: string;
  request?: unknown;
  response?: unknown;
  node_version?: string;
  dlmm_sdk_version?: string;
  git_sha?: string | null;
  wallet_pubkey?: string;
  policy_hash?: string;
  dry_run?: boolean;
  rpc_read_url?: string;
  rpc_write_url?: string;
  rpc_ws_url?: string | null;
  rpc_max_cu_per_second?: number;
  pool_allowlist?: string[];
  mint_allowlist?: string[];
}

/** All JSONL audit records from the run, in write order. */
export function readExecutorLog(logDir: string): ExecutorAuditLine[] {
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const lines: ExecutorAuditLine[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(logDir, file), 'utf8').trim();
    if (text === '') continue;
    for (const line of text.split('\n')) lines.push(JSON.parse(line) as ExecutorAuditLine);
  }
  return lines;
}

// ------------------------------------------------------------ run artifacts

export interface RunArtifact {
  run_id: string;
  generated_at: string;
  gateway: { node_version: string | null; git_sha: string | null; dry_run: boolean | null };
  connector: { dlmm_sdk_version: string | null };
  network: {
    rpc_read_url: string | null;
    rpc_write_url: string | null;
    rpc_ws_url: string | null;
    rpc_max_cu_per_second: number | null;
    wallet_pubkey: string | null;
    policy_hash: string | null;
    pools: string[];
    mints: string[];
  };
  exchanges: { request: unknown; response: unknown }[];
  req_seqs: number[];
  tx_signatures: string[];
  positions: Record<string, unknown>;
  before_after: Record<string, { before: unknown; after: unknown }>;
  decisions: string[];
  cleanup: { operations: string[]; final_status: 'clean' | 'failed' | 'not_started' };
  evidence_files: string[];
}

/**
 * Accumulates everything §7 requires of a live-run artifact: versions, env
 * identifiers, sanitized stdio transcript, executor req_seqs, signatures,
 * position IDs, before/after state, retry/reconciliation decisions, and the
 * final cleanup status.
 */
export class RunRecorder {
  private readonly artifact: RunArtifact;

  constructor(readonly runId: string) {
    this.artifact = {
      run_id: runId,
      generated_at: '',
      gateway: { node_version: null, git_sha: null, dry_run: null },
      connector: { dlmm_sdk_version: null },
      network: {
        rpc_read_url: null,
        rpc_write_url: null,
        rpc_ws_url: null,
        rpc_max_cu_per_second: null,
        wallet_pubkey: null,
        policy_hash: null,
        pools: [],
        mints: [],
      },
      exchanges: [],
      req_seqs: [],
      tx_signatures: [],
      positions: {},
      before_after: {},
      decisions: [],
      cleanup: { operations: [], final_status: 'not_started' },
      evidence_files: [],
    };
  }

  /** Seed versions + network identifiers from the executor_started line. */
  ingestStarted(lines: ExecutorAuditLine[]): void {
    const started = lines.find((line) => line.kind === 'executor_started');
    if (!started) return;
    this.artifact.gateway = {
      node_version: started.node_version ?? null,
      git_sha: started.git_sha ?? null,
      dry_run: started.dry_run ?? null,
    };
    this.artifact.connector.dlmm_sdk_version = started.dlmm_sdk_version ?? null;
    this.artifact.network = {
      // Executor logging redacts credential-bearing URLs to provider origins.
      rpc_read_url: started.rpc_read_url ?? null,
      rpc_write_url: started.rpc_write_url ?? null,
      rpc_ws_url: started.rpc_ws_url ?? null,
      rpc_max_cu_per_second: started.rpc_max_cu_per_second ?? null,
      wallet_pubkey: started.wallet_pubkey ?? null,
      policy_hash: started.policy_hash ?? null,
      pools: started.pool_allowlist ?? [],
      mints: started.mint_allowlist ?? [],
    };
  }

  exchange(request: ExecRequest, response: ExecResponse): void {
    this.artifact.exchanges.push({ request: structuredClone(request), response: structuredClone(response) });
    if (response.tx_signatures) this.artifact.tx_signatures.push(...response.tx_signatures);
    if (response.ok && response.data && typeof response.data === 'object' && 'position_id' in response.data) {
      const id = (response.data as { position_id: unknown }).position_id;
      if (typeof id === 'string' && id !== '') this.artifact.positions[id] = response.data;
    }
  }

  ingestAudit(lines: ExecutorAuditLine[]): void {
    for (const line of lines) {
      if (line.kind === 'verb' && typeof line.req_seq === 'number') this.artifact.req_seqs.push(line.req_seq);
    }
  }

  /** A position ID observed live — readback or creation data. */
  setPosition(positionId: string, data: unknown): void {
    this.artifact.positions[positionId] = structuredClone(data);
  }

  decision(note: string): void {
    this.artifact.decisions.push(note);
  }

  beforeAfter(key: string, before: unknown, after: unknown): void {
    const current = this.artifact.before_after[key] ?? { before: null, after: null };
    if (before !== null && before !== undefined) current.before = before;
    if (after !== null && after !== undefined) current.after = after;
    this.artifact.before_after[key] = current;
  }

  cleanupOperation(operation: string): void {
    this.artifact.cleanup.operations.push(operation);
  }

  evidenceFile(file: string): void {
    this.artifact.evidence_files.push(file);
  }

  finish(status: RunArtifact['cleanup']['final_status']): void {
    this.artifact.cleanup.final_status = status;
    this.artifact.generated_at = new Date().toISOString();
  }

  write(outputDir: string): string {
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, `artifact-${this.artifact.run_id}.json`);
    fs.writeFileSync(file, JSON.stringify(this.artifact, null, 2) + '\n');
    return file;
  }

  snapshot(): RunArtifact {
    return structuredClone(this.artifact);
  }
}
