/** Read-only `quote_swap` scouting across POOL_ALLOWLIST (offline). */
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createReadHandlers } from '../../src/handlers.js';
import { RpcReadError } from '../../src/meteora.js';
import { loadConfig } from '../../src/config.js';
import type { QuoteSwapData, QuoteSwapRequest } from '../../src/protocol.js';
import { baseEnv, TEST_BASE_MINT, TEST_QUOTE_MINT } from '../../src/testing.js';

const POOL_A = '11111111111111111111111111111111';
const POOL_B = Keypair.generate().publicKey.toBase58();
const POOL_OTHER = Keypair.generate().publicKey.toBase58();
const FOREIGN_MINT = Keypair.generate().publicKey.toBase58();

/** tokenX = base (9 decimals), tokenY = quote (6 decimals). */
function reader(outAmountRaw: string, tokenY = TEST_QUOTE_MINT) {
  return {
    pubkey: new PublicKey(POOL_A),
    lbPair: { binStep: 20 },
    tokenX: {
      publicKey: new PublicKey(TEST_BASE_MINT),
      reserve: Keypair.generate().publicKey,
      mint: { decimals: 9 },
    },
    tokenY: {
      publicKey: new PublicKey(tokenY),
      reserve: Keypair.generate().publicKey,
      mint: { decimals: 6 },
    },
    async getActiveBin() { return { binId: 100 }; },
    getFeeInfo() {
      return { baseFeeRatePercentage: { mul: () => ({ toString: () => '0.25' }) } };
    },
    async getPosition() { return null as never; },
    binArrayBitmapExtension: null,
    async getBinArrayForSwap() {
      return [{ account: {}, publicKey: Keypair.generate().publicKey }];
    },
    swapQuote: () => ({
      consumedInAmount: { toString: () => '1000000000' },
      outAmount: { toString: () => outAmountRaw },
      // 50 bps below the quoted output, matching the request's cap.
      minOutAmount: { toString: () => (BigInt(outAmountRaw) * 9950n / 10000n).toString() },
      binArraysPubkey: [Keypair.generate().publicKey],
    }),
    swap: async () => ({}) as never,
  };
}

function request(overrides: Partial<QuoteSwapRequest> = {}): QuoteSwapRequest {
  return {
    method: 'quote_swap',
    in_mint: TEST_BASE_MINT,
    out_mint: TEST_QUOTE_MINT,
    amount: 1,
    max_slippage_bps: 50,
    ...overrides,
  };
}

function handlers(getSwapPoolReader: ReturnType<typeof vi.fn>, pools = [POOL_A, POOL_B]) {
  return createReadHandlers(
    {
      getState: vi.fn(),
      getPosition: vi.fn(),
      getSwapPoolReader,
    } as never,
    loadConfig(baseEnv({ POOL_ALLOWLIST: pools.join(',') })),
  );
}

describe('quote_swap', () => {
  it('ranks allow-listed pools best output first and names the winner', async () => {
    const getSwapPoolReader = vi.fn(async (pool: string) =>
      (pool === POOL_A ? reader('150000000') : reader('151000000')));
    const response = await handlers(getSwapPoolReader).quote_swap(request());
    const data = response.data as QuoteSwapData;
    expect(response.ok).toBe(true);
    expect(data.quotes.map((quote) => quote.pool)).toEqual([POOL_B, POOL_A]);
    expect(data.best_pool).toBe(POOL_B);
    expect(data.quotes[0]).toMatchObject({
      amount_out: 151, amount_out_raw: '151000000', min_out_raw: '150245000', price: 151,
    });
    expect(data.rejected).toEqual([]);
    expect(response.transactions).toEqual([]);
  });

  it('skips pools that do not hold the requested pair', async () => {
    const getSwapPoolReader = vi.fn(async (pool: string) =>
      (pool === POOL_A ? reader('150000000') : reader('150000000', FOREIGN_MINT)));
    const data = (await handlers(getSwapPoolReader, [POOL_A, POOL_OTHER])
      .quote_swap(request())).data as QuoteSwapData;
    expect(data.quotes.map((quote) => quote.pool)).toEqual([POOL_A]);
    expect(data.rejected).toEqual([]);
  });

  it('reports an unquotable pool instead of dropping it silently', async () => {
    const getSwapPoolReader = vi.fn(async (pool: string) => {
      if (pool === POOL_B) throw new RpcReadError('endpoints exhausted');
      return reader('150000000');
    });
    const data = (await handlers(getSwapPoolReader)
      .quote_swap(request())).data as QuoteSwapData;
    expect(data.best_pool).toBe(POOL_A);
    expect(data.rejected).toEqual([{ pool: POOL_B, error: 'rpc_timeout' }]);
  });

  it('rejects mints outside the allow-list before reading any pool', async () => {
    const getSwapPoolReader = vi.fn(async () => reader('150000000'));
    const response = await handlers(getSwapPoolReader)
      .quote_swap(request({ in_mint: FOREIGN_MINT }));
    expect(response).toMatchObject({ ok: false, error: 'bad_request' });
    expect(getSwapPoolReader).not.toHaveBeenCalled();
  });
});
