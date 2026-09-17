/** Component coverage for configuration enforcement at subprocess startup. */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { requestsByVerb } from '../helpers/requests.js';
import { BRIDGE_PATH, requireBuiltBridge, scratchEnv, subprocessEnv } from '../helpers/stdioClient.js';

requireBuiltBridge();

type Overrides = Record<string, string | undefined>;

function run(overrides: Overrides, input = requestsByVerb.get_state!): { status: number; stdout: string; stderr: string } {
  const scratch = scratchEnv(overrides);
  try {
    const result = spawnSync(process.execPath, [BRIDGE_PATH], {
      input: JSON.stringify(input) + '\n', encoding: 'utf8', timeout: 10000,
      env: subprocessEnv(scratch),
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  } finally {
    scratch.dispose();
  }
}

describe('§9 fail-closed startup', () => {
  it.each([
    { SOLANA_RPC_URL: undefined },
    { POOL_ALLOWLIST: undefined },
    { MINT_ALLOWLIST: undefined },
    { SWAP_STREAM_PATH: undefined },
    { WALLET_SIGNER: 'hardware' },
    { MAX_SLIPPAGE_BPS: '10001' },
    { JITO_ENABLED: 'true' },
    { SOLANA_RPC_URL: 'not-a-url' },
    { WALLET_PUBKEY: 'not-a-pubkey' },
  ])('refuses to start and leaks no stdout when %j is invalid', (overrides) => {
    const result = run(overrides);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
  });

  it('requires signer configuration before enabling the M4 write handlers', () => {
    // Write mode resolves the signer at startup; missing custody fails closed.
    const result = run({ DRY_RUN: 'false', KMS_KEY_ARN: undefined });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('KMS_KEY_ARN');
  });

  it('rejects the file arm at startup without WALLET_KEYPAIR_PATH when not dry-run', () => {
    const result = run({ WALLET_SIGNER: 'file', DRY_RUN: 'false' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('WALLET_KEYPAIR_PATH');
  });

  it('enforces the mint allowlist on swap routing targets', () => {
    const offAllowlist = { ...requestsByVerb.swap!, in_mint: 'mParen9x8yZ2zuHddbzZ9Z2x6vBmvnd2JEZHSTV9t', out_mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkM595XACZCAMgCm3gt' };
    const result = run({}, offAllowlist as never);
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout.trim()) as { ok: boolean; error: string | null };
    expect(response.ok).toBe(false);
    expect(response.error).toBe('bad_request');
  });
});
