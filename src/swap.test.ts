import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  SwapValidationError,
  WSOL_MINT,
  assertQuotedSlippage,
  assertRealizedBounds,
  buildSwapData,
  realizedSwapDeltas,
  swapAmountToRaw,
  validateSwapRequest,
} from './swap.js';
import type { SwapRequest } from './protocol.js';
import { TEST_POOL } from './testing.js';

const MINTS = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
];
const QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER_MINT = Keypair.generate().publicKey.toBase58();

function request(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    method: 'swap', in_mint: MINTS[1]!, out_mint: WSOL_MINT,
    amount: 150, max_slippage_bps: 50, pool: TEST_POOL, ...overrides,
  };
}

describe('validateSwapRequest', () => {
  it('rejects symbolic base/quote spellings instead of guessing', () => {
    for (const mint of ['base', 'quote']) {
      expect(() => validateSwapRequest(request({ in_mint: mint }), MINTS))
        .toThrow(SwapValidationError);
      expect(() => validateSwapRequest(request({ in_mint: mint }), MINTS))
        .toThrow('symbolic');
    }
  });

  it('rejects mints outside the allow-list, identical mints, and bad amounts', () => {
    expect(() => validateSwapRequest(request({ in_mint: OTHER_MINT }), MINTS))
      .toThrow('allow-listed');
    expect(() => validateSwapRequest(request({ in_mint: WSOL_MINT }), MINTS))
      .toThrow('must differ');
    for (const amount of [0, -1, Number.NaN]) {
      expect(() => validateSwapRequest(request({ amount }), MINTS)).toThrow('valid');
    }
    expect(() => validateSwapRequest(request({ max_slippage_bps: 10_001 }), MINTS))
      .toThrow('valid');
  });

  it('rejects the stand-by aggregator route before any other check', () => {
    expect(() => validateSwapRequest(request({ pool: null }), MINTS)).toThrow('stand-by');
  });

  it('accepts a real allow-listed pair within range', () => {
    expect(() => validateSwapRequest(request(), MINTS)).not.toThrow();
  });
});

describe('swapAmountToRaw', () => {
  it('converts decimal units exactly', () => {
    expect(swapAmountToRaw(1.5, 6)).toBe(1_500_000n);
    expect(swapAmountToRaw(0.01, 9)).toBe(10_000_000n);
  });

  it('refuses sub-lamport dust rather than truncating it', () => {
    expect(() => swapAmountToRaw(0.0000000001, 9)).toThrow(SwapValidationError);
  });
});

describe('assertQuotedSlippage', () => {
  it('accepts a bound within the cap and rejects a looser one', () => {
    expect(() => assertQuotedSlippage(1_000_000n, 995_000n, 50)).not.toThrow();
    expect(() => assertQuotedSlippage(1_000_000n, 900_000n, 50))
      .toThrow('slippage cap');
    expect(() => assertQuotedSlippage(1_000_000n, 1_000_001n, 50))
      .toThrow(SwapValidationError);
  });

  it('accepts the SDK rounding of an exactly-at-cap bound', () => {
    // Live mainnet quote: 25 bps of 968748 is 2421.87, so the SDK bakes
    // minOut 2422 raw below the output. The one-unit rounding is accepted;
    // a genuinely looser bound is not.
    expect(() => assertQuotedSlippage(968_748n, 966_326n, 25)).not.toThrow();
    expect(() => assertQuotedSlippage(968_748n, 964_000n, 25))
      .toThrow('slippage cap');
  });
});

describe('realizedSwapDeltas', () => {
  const wallet = Keypair.generate().publicKey;
  const inMint = QUOTE_MINT;
  const outMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

  it('sums wallet-owned token accounts across both mints', () => {
    const realized = realizedSwapDeltas({
      meta: {
        fee: 5_000,
        preTokenBalances: [
          { accountIndex: 1, mint: inMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '200' } },
          { accountIndex: 2, mint: inMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '100' } },
          { accountIndex: 3, mint: outMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '0' } },
          { accountIndex: 4, mint: inMint, owner: Keypair.generate().publicKey.toBase58(), uiTokenAmount: { amount: '999' } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: inMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '0' } },
          { accountIndex: 2, mint: inMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '50' } },
          { accountIndex: 3, mint: outMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '250' } },
        ],
      },
      wallet, inMint, outMint, walletIndex: 0,
    });
    expect(realized.amountInRaw).toBe(250n);
    expect(realized.amountOutRaw).toBe(250n);
  });

  it('derives wrapped-SOL sides from the wallet lamports delta plus the fee', () => {
    const splMint = QUOTE_MINT;
    const input = realizedSwapDeltas({
      meta: { fee: 5_000, preBalances: [1_000_000, 0], postBalances: [844_000, 156_000] },
      wallet, inMint: WSOL_MINT, outMint: splMint, walletIndex: 0,
    });
    expect(input.amountInRaw).toBe(151_000n);
    const output = realizedSwapDeltas({
      meta: {
        fee: 5_000,
        preBalances: [1_000_000],
        postBalances: [1_100_000],
        preTokenBalances: [{ accountIndex: 1, mint: splMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '100' } }],
        postTokenBalances: [{ accountIndex: 1, mint: splMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '0' } }],
      },
      wallet, inMint: splMint, outMint: WSOL_MINT, walletIndex: 0,
    });
    expect(output.amountInRaw).toBe(100n);
    expect(output.amountOutRaw).toBe(105_000n);
  });

  it('derives wrapped-SOL sides from the pool reserve when the SDK closes the wallet wSOL account', () => {
    // Live mainnet shape: the SDK wraps into the wallet's own wSOL ATA,
    // swaps, then closes the ATA — the wallet's lamports RISE (unwrapped
    // remainder + rent) while its wSOL token total falls to zero. Only the
    // pool reserve delta reports the true consumed amount.
    const pool = Keypair.generate().publicKey.toBase58();
    const realized = realizedSwapDeltas({
      meta: {
        fee: 5_000,
        preBalances: [618_584_809],
        postBalances: [673_683_686],
        preTokenBalances: [
          { accountIndex: 1, mint: WSOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: '63615437' } },
          { accountIndex: 2, mint: WSOL_MINT, owner: pool, uiTokenAmount: { amount: '37367910890137' } },
          { accountIndex: 3, mint: QUOTE_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: '24135274' } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: WSOL_MINT, owner: pool, uiTokenAmount: { amount: '37367920890137' } },
          { accountIndex: 3, mint: QUOTE_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: '25103271' } },
        ],
      },
      wallet, inMint: WSOL_MINT, outMint: QUOTE_MINT, walletIndex: 0,
      wsolReserveOwner: pool,
    });
    expect(realized.amountInRaw).toBe(10_000_000n);
    expect(realized.amountOutRaw).toBe(967_997n);
  });

  it('rejects a receipt that reports a negative delta', () => {
    expect(() => realizedSwapDeltas({
      meta: {
        fee: 0,
        preTokenBalances: [{ accountIndex: 1, mint: inMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '10' } }],
        postTokenBalances: [{ accountIndex: 1, mint: inMint, owner: wallet.toBase58(), uiTokenAmount: { amount: '20' } }],
      },
      wallet, inMint, outMint, walletIndex: 0,
    })).toThrow('negative realized delta');
  });
});

describe('assertRealizedBounds and buildSwapData', () => {
  it('flags a landed swap that broke the enforced bound', () => {
    expect(() => assertRealizedBounds(
      { amountInRaw: 100n, amountOutRaw: 89n },
      { amountInRaw: 100n, minOutRaw: 90n },
    )).toThrow('minimum');
    expect(() => assertRealizedBounds(
      { amountInRaw: 101n, amountOutRaw: 95n },
      { amountInRaw: 100n, minOutRaw: 90n },
    )).toThrow('exact-in');
    expect(() => assertRealizedBounds(
      { amountInRaw: 100n, amountOutRaw: 90n },
      { amountInRaw: 100n, minOutRaw: 90n },
    )).not.toThrow();
  });

  it('reports realized decimals, raw strings, and the realized price', () => {
    const data = buildSwapData(
      { amountInRaw: 1_000_000_000n, amountOutRaw: 149_900_000n }, 9, 6, 'meteora',
    );
    expect(data).toEqual({
      amount_in: 1,
      amount_out: 149.9,
      amount_in_raw: '1000000000',
      amount_out_raw: '149900000',
      price_realized: 149.9,
      route: 'meteora',
    });
  });
});
