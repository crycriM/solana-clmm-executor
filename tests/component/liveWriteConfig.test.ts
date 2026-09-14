/** Write-suite configuration must never silently use fixture signer settings. */
import { describe, expect, it } from 'vitest';
import { liveWriteGatewayEnv } from '../helpers/stdioClient.js';
import { baseEnv, TEST_BASE_MINT, TEST_POOL, TEST_QUOTE_MINT } from '../../src/testing.js';

function writeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    WALLET_SIGNER: 'file', KMS_KEY_ARN: undefined,
    WALLET_KEYPAIR_PATH: '/etc/clmm-executor/wallet.json',
    WALLET_PUBKEY: TEST_POOL,
    LIVE_POOL: TEST_POOL, LIVE_BASE_MINT: TEST_BASE_MINT, LIVE_QUOTE_MINT: TEST_QUOTE_MINT,
    MAX_SOL_PER_TX: '0.01', MAX_SOL_PER_RUN: '0.02',
    ...overrides,
  });
}

describe('liveWriteGatewayEnv', () => {
  it('copies a configured file-wallet campaign without exposing key material', () => {
    const configured = liveWriteGatewayEnv(writeEnv());
    expect(configured).toMatchObject({
      DRY_RUN: 'false', WALLET_SIGNER: 'file', WALLET_KEYPAIR_PATH: '/etc/clmm-executor/wallet.json',
      POOL_ALLOWLIST: `${TEST_POOL},${TEST_BASE_MINT}`,
      MINT_ALLOWLIST: `${TEST_BASE_MINT},${TEST_QUOTE_MINT}`,
    });
    expect(configured['KMS_KEY_ARN']).toBeUndefined();
  });

  it('rejects the public-only M3 read configuration', () => {
    expect(() => liveWriteGatewayEnv({
      SOLANA_RPC_URL: 'https://rpc.example', WALLET_PUBKEY: TEST_POOL,
      LIVE_POOL: TEST_POOL, LIVE_BASE_MINT: TEST_BASE_MINT, LIVE_QUOTE_MINT: TEST_QUOTE_MINT,
    })).toThrow('WALLET_SIGNER');
  });

  it('rejects static AWS credentials instead of passing a signing bearer credential through', () => {
    expect(() => liveWriteGatewayEnv(writeEnv({ AWS_ACCESS_KEY_ID: 'not-allowed' })))
      .toThrow('AWS_ACCESS_KEY_ID');
  });
});
