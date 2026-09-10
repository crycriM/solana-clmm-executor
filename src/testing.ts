/** Offline values shared by tests; no test suite is imported by another suite. */
export const TEST_POOL = '11111111111111111111111111111111';
export const TEST_BASE_MINT = 'So11111111111111111111111111111111111111112';
export const TEST_QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SOLANA_RPC_URL: 'https://rpc.test',
    WALLET_SIGNER: 'kms',
    KMS_KEY_ARN: 'arn:aws:kms:us-east-1:1:key/x',
    POOL_ALLOWLIST: `${TEST_POOL},${TEST_BASE_MINT}`,
    MINT_ALLOWLIST: `${TEST_BASE_MINT},${TEST_QUOTE_MINT}`,
    MAX_SOL_PER_TX: '0.5',
    MAX_SOL_PER_RUN: '2',
    MAX_SLIPPAGE_BPS: '50',
    MAX_PRIORITY_FEE_LAMPORTS: '100000',
    SWAP_STREAM_PATH: 'logs/swaps.jsonl',
    ...overrides,
  };
}
