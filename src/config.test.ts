import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigValidationError, policyHash, ExecutorConfig } from './config.js';
import type { RawAmount } from './protocol.js';
import { baseEnv, TEST_POOL, TEST_BASE_MINT } from './testing.js';

describe('config fail-closed', () => {
  const required = [
    'SOLANA_RPC_URL',
    'WALLET_SIGNER',
    'POOL_ALLOWLIST',
    'MINT_ALLOWLIST',
    'MAX_SOL_PER_TX',
    'MAX_SOL_PER_RUN',
    'MAX_SLIPPAGE_BPS',
    'MAX_ACTIVE_BIN_SLIPPAGE_BINS',
    'MAX_PRIORITY_FEE_LAMPORTS',
    'SWAP_STREAM_PATH',
  ];

  for (const key of required) {
    it(`rejects when ${key} missing`, () => {
      const env = baseEnv();
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigValidationError);
      expect(() => loadConfig(env)).toThrow(key);
    });
  }

  it('rejects signer arn missing when not dry-run', () => {
    const env = baseEnv({ KMS_KEY_ARN: undefined });
    expect(() => loadConfig(env)).toThrow('KMS_KEY_ARN');
  });

  it('permits dummy signer shape only in dry-run (no KMS key needed)', () => {
    const cfg = loadConfig(baseEnv({ KMS_KEY_ARN: undefined, DRY_RUN: 'true' }));
    expect(cfg.dryRun).toBe(true);
  });

  it.each([
    ['POOL_ALLOWLIST', ', ,'],
    ['MINT_ALLOWLIST', 'not-a-public-key'],
    ['SOLANA_RPC_URL', 'file:///tmp/rpc'],
    ['SOLANA_RPC_WRITE_URL', 'no-url'],
    ['SOLANA_WS_URL', 'https://not-a-websocket.test'],
    ['SOLANA_COMMITMENT', 'processed'],
    ['SOLANA_COMMITMENT', 'oops'],
    ['DRY_RUN', 'TRUE'],
    ['JITO_ENABLED', 'yes'],
    ['WALLET_SIGNER', 'dummy'],
    ['MAX_SOL_PER_TX', '-1'],
    ['MAX_SOL_PER_RUN', 'NaN'],
    ['MAX_SLIPPAGE_BPS', '10001'],
    ['MAX_ACTIVE_BIN_SLIPPAGE_BINS', '-1'],
    ['MAX_ACTIVE_BIN_SLIPPAGE_BINS', '2147483648'],
    ['MAX_PRIORITY_FEE_LAMPORTS', '9007199254740992'],
    ['SOLANA_RPC_MAX_CU_PER_SECOND', '0'],
    ['JITO_TIP_LAMPORTS', '-1'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadConfig(baseEnv({ [key]: value }))).toThrow(key);
  });

  it('rejects blank keypair custody and missing Jito endpoint', () => {
    expect(() => loadConfig(baseEnv({ WALLET_SIGNER: 'keypair', WALLET_SECRET_ARN: ' ' }))).toThrow(
      'WALLET_SECRET_ARN',
    );
    expect(() => loadConfig(baseEnv({ JITO_ENABLED: 'true' }))).toThrow('JITO_BLOCK_ENGINE_URL');
  });

  it('rejects file-arm custody without WALLET_KEYPAIR_PATH when not dry-run', () => {
    expect(() => loadConfig(baseEnv({ WALLET_SIGNER: 'file', KMS_KEY_ARN: undefined })))
      .toThrow('WALLET_KEYPAIR_PATH');
  });

  it('requires a public-key pin for a live file signer', () => {
    expect(() => loadConfig(baseEnv({
      WALLET_SIGNER: 'file', KMS_KEY_ARN: undefined,
      WALLET_KEYPAIR_PATH: '/etc/clmm-executor/wallet.json', WALLET_PUBKEY: undefined,
    }))).toThrow('WALLET_PUBKEY');
  });

  it('permits file arm in dry-run without a keypair file', () => {
    const cfg = loadConfig(baseEnv({ WALLET_SIGNER: 'file', KMS_KEY_ARN: undefined, DRY_RUN: 'true' }));
    expect(cfg.walletSigner).toBe('file');
    expect(cfg.walletKeypairPath).toBeNull();
  });

  it('makes the file signer local/devnet-only unless explicitly overridden', () => {
    expect(loadConfig(baseEnv()).fileSignerAllowMainnet).toBe(false);
    expect(loadConfig(baseEnv({ FILE_SIGNER_ALLOW_MAINNET: 'true' })).fileSignerAllowMainnet)
      .toBe(true);
    expect(() => loadConfig(baseEnv({ FILE_SIGNER_ALLOW_MAINNET: 'yes' })))
      .toThrow('FILE_SIGNER_ALLOW_MAINNET');
  });

  it('rejects a malformed WALLET_PUBKEY pin on any signer arm', () => {
    expect(() => loadConfig(baseEnv({ WALLET_PUBKEY: 'not-a-pubkey' }))).toThrow('WALLET_PUBKEY');
  });

  it('hashes the keypair path out of the policy hash input identity', () => {
    const a = loadConfig(
      baseEnv({ WALLET_SIGNER: 'file', KMS_KEY_ARN: undefined, WALLET_KEYPAIR_PATH: '/etc/clmm-executor/wallet.json' }),
    );
    const b = loadConfig(
      baseEnv({ WALLET_SIGNER: 'file', KMS_KEY_ARN: undefined, WALLET_KEYPAIR_PATH: '/tmp/other.json' }),
    );
    expect(a.walletKeypairPath).toBe('/etc/clmm-executor/wallet.json');
    expect(policyHash(a)).not.toBe(policyHash(b));
  });
});

describe('policyHash', () => {
  it('is stable under allow-list reordering', () => {
    const a = policyHash(loadConfig(baseEnv()));
    const b = policyHash(
      loadConfig(baseEnv({ POOL_ALLOWLIST: `${TEST_BASE_MINT},${TEST_POOL},${TEST_POOL}` })),
    );
    expect(a).toBe(b);
  });

  it.each([
    ['MAX_SOL_PER_TX', '1'],
    ['MAX_SOL_PER_RUN', '3'],
    ['MAX_SLIPPAGE_BPS', '51'],
    ['MAX_ACTIVE_BIN_SLIPPAGE_BINS', '4'],
    ['MAX_PRIORITY_FEE_LAMPORTS', '100001'],
    ['JITO_TIP_LAMPORTS', '1'],
    ['FILE_SIGNER_ALLOW_MAINNET', 'true'],
  ])('changes when %s changes', (key, value) => {
    const a = policyHash(loadConfig(baseEnv()));
    const b = policyHash(loadConfig(baseEnv({ [key]: value })));
    expect(a).not.toBe(b);
  });

  it('stays stable for nominate-derived raw shapes (RawAmount strings pass through)', () => {
    const raw: RawAmount = '12345678901';
    expect(typeof raw).toBe('string');
    expect(policyHash(loadConfig(baseEnv()))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('default config smoke load', () => {
    const cfg: ExecutorConfig = loadConfig(baseEnv());
    expect(cfg.rpcWriteUrl).toBe(cfg.rpcReadUrl);
    expect(cfg.rpcWsUrl).toBeNull();
    expect(cfg.rpcMaxCuPerSecond).toBe(240);
    expect(cfg.commitment).toBe('confirmed');
  });

  it('allows a lower explicit RPC throughput budget', () => {
    expect(loadConfig(baseEnv({ SOLANA_RPC_MAX_CU_PER_SECOND: '120' })).rpcMaxCuPerSecond)
      .toBe(120);
  });

  it('accepts an explicit secure websocket endpoint', () => {
    const cfg = loadConfig(baseEnv({ SOLANA_WS_URL: 'wss://rpc.example/ws/key' }));
    expect(cfg.rpcWsUrl).toBe('wss://rpc.example/ws/key');
  });
});
