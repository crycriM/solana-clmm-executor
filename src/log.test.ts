import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ExecutorLog, gzipOlderThan, newRunId, redact } from './log.js';
import { loadConfig } from './config.js';
import { baseEnv } from './testing.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exlog-'));
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function secretRequest(): Record<string, unknown> {
  // A 64-char base58 secret in an unexpected field, exactly the redaction-test
  // case called for by plan T0.4.
  return {
    method: 'swap',
    in_mint: 'mintA',
    out_mint: 'mintB',
    amount: 12.5,
    unexpected_note: '5Kd3CDSU4VYfNHNV49Gn7A8YYyfYmzYh4W4xzUsvqmVuFmmAvymvqPFqZmuNyxGMoLNA',
  };
}

describe('executor log', () => {
  it('redacts a base58 secret in an unexpected request field', () => {
    const log = new ExecutorLog(loadConfig(baseEnv({ EXECUTOR_LOG_DIR: tmp })), newRunId());
    log.write({
      kind: 'verb',
      req_seq: 1,
      method: 'swap',
      received_at: 1,
      responded_at: 2,
      duration_ms: 1,
      request: secretRequest() as never,
      response: { ok: true } as never,
      attempt: 1,
      rpc_endpoint: null,
      blockhash: null,
      simulation_ok: null,
      policy_decision: null,
      signer_id: null,
      bundle_id: null,
    });
    log.close();
    const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { request: { unexpected_note: string } };
    expect(parsed.request.unexpected_note).toBe('[REDACTED]');
  });

  it('keeps wallet pubkey and signature fields pass-through', () => {
    const log = new ExecutorLog(loadConfig(baseEnv({ EXECUTOR_LOG_DIR: tmp })), newRunId());
    const signature =
      '4w2wWSfWkcVzzkBriLxRUBeyaLPNBt3mC7eeSxDAhYhDDbWk4EbLDAXfLxPLD8VHt9zAPwLBPUhMXS9DYECJnEQrb';
    log.write({
      kind: 'verb',
      req_seq: 2,
      method: 'get_state',
      received_at: 1,
      responded_at: 2,
      duration_ms: 1,
      request: { method: 'get_state', pool: 'poolAAA' } as never,
      response: {
        ok: true,
        wallet_pubkey: '9hwyZku17mtdVAKVHtXWA116DCdFsmUFAw3zrdZqzBNw',
        tx_signatures: [signature],
      } as never,
      attempt: 1,
      rpc_endpoint: null,
      blockhash: null,
      simulation_ok: null,
      policy_decision: null,
      signer_id: null,
      bundle_id: null,
    });
    log.close();
    const parsed = JSON.parse(fs.readFileSync(log.path, 'utf8').trim()) as {
      request: { pool: string };
      response: { wallet_pubkey: string; tx_signatures: string[] };
    };
    expect(parsed.request.pool).toBe('poolAAA');
    expect(parsed.response.wallet_pubkey).toBe('9hwyZku17mtdVAKVHtXWA116DCdFsmUFAw3zrdZqzBNw');
    expect(parsed.response.tx_signatures).toEqual([signature]);
  });

  it('gzipOlderThan touches stale non-swap logs only', () => {
    const mainDir = path.join(tmp, 'rot');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'executor-stale.jsonl'), '{}\n');
    fs.writeFileSync(path.join(mainDir, 'swaps-fresh.jsonl'), '{}\n');
    fs.writeFileSync(path.join(mainDir, 'keeper-stale.jsonl'), '{}\n');
    oldify(path.join(mainDir, 'keeper-stale.jsonl'));
    oldify(path.join(mainDir, 'executor-stale.jsonl'));
    expect(gzipOlderThan(mainDir)).toBe(1);
    expect(fs.existsSync(path.join(mainDir, 'executor-stale.jsonl.gz'))).toBe(true);
    expect(fs.existsSync(path.join(mainDir, 'executor-stale.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(mainDir, 'swaps-fresh.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(mainDir, 'keeper-stale.jsonl'))).toBe(true);
  });

  it('redacts structured secrets, env dumps, RPC credentials, and embedded base58 secrets', () => {
    const secret = '5'.repeat(88);
    expect(
      redact({
        privateKey: Array(64).fill(23),
        signed_transaction: { bytes: [1, 2, 3] },
        env: { PASSWORD: 'short-secret' },
        kms_material: { plaintext: 'abc' },
        rpc_read_url: 'https://user:password@rpc.test/private-key?api-key=short-secret',
        detail: `provider failed with ${secret}`,
        tx_signatures: [secret],
      }),
    ).toEqual({
      privateKey: '[REDACTED]',
      signed_transaction: '[REDACTED]',
      env: '[REDACTED]',
      kms_material: '[REDACTED]',
      rpc_read_url: 'https://rpc.test',
      detail: 'provider failed with [REDACTED]',
      tx_signatures: [secret],
    });
  });

  it('preserves policy hashes even when all characters resemble base58', () => {
    expect(redact({ policy_hash: 'a'.repeat(64) })).toEqual({ policy_hash: 'a'.repeat(64) });
    expect(redact('missing required env var: SOLANA_RPC_URL')).toBe(
      'missing required env var: SOLANA_RPC_URL',
    );
    expect(redact('SOLANA_RPC_URL=https://secret.test')).toBe('[REDACTED]');
  });

  it('reinitializes human logging without duplicates or stdout at any level', () => {
    const dir = path.join(tmp, 'human');
    fs.mkdirSync(dir);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { initLogger, logger } from './dist/vendor/lp-monitor/logger.js';
      initLogger(process.env.EXECUTOR_LOG_DIR);
      initLogger(process.env.EXECUTOR_LOG_DIR);
      logger.level = 'silly';
      for (const level of ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']) {
        logger.log(level, 'fixture-' + level);
      }
    `,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, EXECUTOR_LOG_DIR: dir },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(7);
    expect(fs.readFileSync(path.join(dir, 'executor.log'), 'utf8').trim().split('\n')).toHaveLength(
      7,
    );
  });

  it('rotates on the UTC date boundary and keeps writing to the new file', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T23:59:59Z'));
    const log = new ExecutorLog(loadConfig(baseEnv({ EXECUTOR_LOG_DIR: tmp })), 'rotation-test');
    const entry = {
      kind: 'rpc_failover' as const,
      ts: 1,
      from_endpoint: 'https://a.test',
      to_endpoint: 'https://b.test',
      error: 'rpc_timeout',
    };
    try {
      log.write(entry);
      const before = log.path;
      vi.setSystemTime(new Date('2026-09-10T00:00:01Z'));
      log.write(entry);
      expect(log.path).not.toBe(before);
      expect(fs.readFileSync(before, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(fs.readFileSync(log.path, 'utf8').trim().split('\n')).toHaveLength(1);
      oldify(log.path);
      expect(gzipOlderThan(tmp, undefined, log.path)).toBe(0);
    } finally {
      log.close();
      vi.useRealTimers();
    }
  });
});

function oldify(file: string): void {
  const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(file, longAgo, longAgo);
}
