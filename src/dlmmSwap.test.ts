/** Offline verification for the direct DLMM pool swap route (plan T5.1). */
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { MEMO_PROGRAM_ID, deriveEventAuthority, LBCLMM_PROGRAM_IDS } from '@meteora-ag/dlmm';
import { describe, expect, it, vi } from 'vitest';
import {
  DlmmSwapBuildError,
  buildDlmmSwapTransaction,
  decodeSwap2Payload,
  encodeSwap2Payload,
} from './dlmmSwap.js';
import { loadConfig } from './config.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import type { SwapRequest } from './protocol.js';
import type { SwapPoolReader, SwapQuoteLike, SwapBinArray } from './meteora.js';
import type { WritablePoolMetadata } from './depositTransaction.js';
import { baseEnv, TEST_BASE_MINT, TEST_POOL, TEST_QUOTE_MINT } from './testing.js';

const POOL = new PublicKey(TEST_POOL);
const BASE_MINT = new PublicKey(TEST_BASE_MINT);
const QUOTE_MINT = new PublicKey(TEST_QUOTE_MINT);
const wallet = Keypair.generate().publicKey;
const binArray = Keypair.generate().publicKey;
const oracle = Keypair.generate().publicKey;
const reserveX = Keypair.generate().publicKey;
const reserveY = Keypair.generate().publicKey;

function poolMetadata(overrides: Partial<WritablePoolMetadata> = {}): WritablePoolMetadata {
  return {
    pool: POOL,
    binStep: 20,
    oracle,
    activeRewardCount: 0,
    tokenX: {
      mint: BASE_MINT,
      reserve: reserveX,
      tokenProgram: TOKEN_PROGRAM_ID,
      transferHookAccountCount: 0,
      decimals: 9,
    },
    tokenY: {
      mint: QUOTE_MINT,
      reserve: reserveY,
      tokenProgram: TOKEN_PROGRAM_ID,
      transferHookAccountCount: 0,
      decimals: 6,
    },
    ...overrides,
  };
}

function bn(value: bigint | number): { toString(): string } {
  return { toString: () => String(value) };
}

function quoteLike(overrides: Partial<SwapQuoteLike> = {}): SwapQuoteLike {
  return {
    consumedInAmount: bn(1_500_000_000n),
    outAmount: bn(150_000_000n),
    minOutAmount: bn(149_250_000n),
    binArraysPubkey: [binArray],
    ...overrides,
  };
}

function readerFixture(overrides: Partial<SwapPoolReader> = {}): SwapPoolReader {
  return {
    pubkey: POOL,
    lbPair: { binStep: 20, oracle },
    tokenX: {
      publicKey: BASE_MINT, reserve: reserveX, mint: { decimals: 9 }, owner: TOKEN_PROGRAM_ID,
    },
    tokenY: {
      publicKey: QUOTE_MINT, reserve: reserveY, mint: { decimals: 6 }, owner: TOKEN_PROGRAM_ID,
    },
    async getActiveBin() { return { binId: 100 }; },
    getFeeInfo() {
      return { baseFeeRatePercentage: { mul: () => ({ toString: () => '0.25' }) } };
    },
    async getPosition() { return null as never; },
    binArrayBitmapExtension: null,
    async getBinArrayForSwap() {
      return [{ account: {}, publicKey: binArray }] satisfies SwapBinArray[];
    },
    swapQuote: vi.fn(() => quoteLike()) as never,
    swap: vi.fn(async () => new Transaction()) as never,
    ...overrides,
  };
}

function request(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    method: 'swap', in_mint: TEST_BASE_MINT, out_mint: TEST_QUOTE_MINT,
    amount: 1.5, max_slippage_bps: 50, pool: TEST_POOL, ...overrides,
  };
}

const mintState9 = { decimals: 9, tokenProgram: TOKEN_PROGRAM_ID.toBase58() };
const mintState6 = { decimals: 6, tokenProgram: TOKEN_PROGRAM_ID.toBase58() };

function build(args: Partial<Parameters<typeof buildDlmmSwapTransaction>[0]> = {}) {
  return buildDlmmSwapTransaction({
    reader: readerFixture(),
    wallet,
    request: request(),
    pool: poolMetadata(),
    inMint: mintState9,
    outMint: mintState6,
    walletInBalanceRaw: '20000000000',
    ...args,
  });
}

describe('swap2 payload codec', () => {
  it('round-trips the borsh layout with empty hook slices', () => {
    const data = encodeSwap2Payload(1_500_000_000n, 149_250_000n);
    expect(decodeSwap2Payload(data)).toEqual({
      amountIn: 1_500_000_000n,
      minAmountOut: 149_250_000n,
      slices: [{ type: 0, length: 0 }, { type: 1, length: 0 }],
    });
  });

  it('rejects truncated or trailing-mismatched payloads', () => {
    expect(() => decodeSwap2Payload(Buffer.alloc(20))).toThrow('invalid swap2 payload');
    expect(() => decodeSwap2Payload(Buffer.concat([
      encodeSwap2Payload(1n, 1n), Buffer.from([9]),
    ]))).toThrow('trailing bytes');
  });
});

describe('buildDlmmSwapTransaction', () => {
  it('binds the quote amounts, reserves, oracle, ATAs, and bin arrays', async () => {
    const plan = await build();
    expect(plan.amountInRaw).toBe(1_500_000_000n);
    expect(plan.minOutRaw).toBe(149_250_000n);
    expect(plan.quoteOutRaw).toBe(150_000_000n);
    const userTokenIn = getAssociatedTokenAddressSync(BASE_MINT, wallet);
    const userTokenOut = getAssociatedTokenAddressSync(QUOTE_MINT, wallet);
    expect(plan.policyInput.meteoraSwap).toMatchObject({
      pool: POOL,
      userTokenIn,
      userTokenOut,
      reserveX, reserveY, oracle,
      bitmapExtension: null,
      binArrays: [binArray],
    });
    expect(plan.policyInput.writableAccounts).toContainEqual(oracle);
    expect(plan.policyInput.writableAccounts).toContainEqual(binArray);
  });

  it('makes the bitmap extension writable despite the SDK IDL default', async () => {
    // Live mainnet regression: the pinned SDK builds swap2 with the
    // binArrayBitmapExtension meta non-writable (its IDL says isMut:false),
    // but the program enforces mut when the account is present, failing
    // simulation with ConstraintMut. The builder must correct the meta.
    const bitmapExtension = Keypair.generate().publicKey;
    const programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
    const swapIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: POOL, isWritable: true, isSigner: false },
        { pubkey: bitmapExtension, isWritable: false, isSigner: false },
        { pubkey: wallet, isWritable: false, isSigner: true },
      ],
      data: encodeSwap2Payload(1_500_000_000n, 149_250_000n),
    });
    const plan = await build({
      reader: readerFixture({
        binArrayBitmapExtension: { publicKey: bitmapExtension },
        swap: vi.fn(async () => new Transaction().add(swapIx)) as never,
      }),
    });
    expect(String(plan.policyInput.meteoraSwap?.bitmapExtension))
      .toBe(bitmapExtension.toBase58());
    expect(plan.policyInput.writableAccounts).toContainEqual(bitmapExtension);
    const built = plan.transaction.instructions.find((ix) => ix.programId.equals(programId))!;
    expect(built.keys[1]!.isWritable).toBe(true);
  });

  it('rejects mints that do not belong to the requested pool', async () => {
    await expect(build({
      request: request({ in_mint: Keypair.generate().publicKey.toBase58() }),
    })).rejects.toThrow('do not belong to the requested pool');
    await expect(build({
      request: request({ out_mint: Keypair.generate().publicKey.toBase58() }),
    })).rejects.toThrow('do not belong to the requested pool');
  });

  it('fails closed on reward-bearing and transfer-hook pools', async () => {
    await expect(build({
      pool: poolMetadata({ activeRewardCount: 1 }),
    })).rejects.toBeInstanceOf(DlmmSwapBuildError);
    await expect(build({
      pool: poolMetadata({
        tokenY: {
          mint: QUOTE_MINT, reserve: reserveY,
          tokenProgram: TOKEN_PROGRAM_ID, transferHookAccountCount: 2, decimals: 6,
        },
      }),
    })).rejects.toBeInstanceOf(DlmmSwapBuildError);
  });

  it('requires the pool oracle for the swap2 account vector', async () => {
    await expect(build({
      pool: poolMetadata({ oracle: undefined }),
    })).rejects.toThrow('oracle');
  });

  it('maps a pool that cannot absorb the exact-in amount to slippage_exceeded', async () => {
    await expect(build({
      reader: readerFixture({
        swapQuote: vi.fn(() => { throw new Error('not enough liquidity'); }) as never,
      }),
    })).rejects.toMatchObject({ code: 'slippage_exceeded' });
    await expect(build({
      reader: readerFixture({ swapQuote: vi.fn(() => quoteLike({
        consumedInAmount: bn(1_400_000_000n),
      })) as never }),
    })).rejects.toMatchObject({ code: 'slippage_exceeded', message: expect.stringContaining('partially') });
  });

  it('rejects an unfunded wallet before quoting', async () => {
    await expect(build({
      request: request({ in_mint: TEST_QUOTE_MINT, out_mint: TEST_BASE_MINT }),
      inMint: mintState6,
      outMint: mintState9,
      walletInBalanceRaw: '10',
    })).rejects.toMatchObject({ code: 'insufficient_balance' });
  });

  it('passes the configured slippage cap to the pool quote', async () => {
    const swapQuote = vi.fn(() => quoteLike());
    await build({ reader: readerFixture({ swapQuote: swapQuote as never }) });
    const call = swapQuote.mock.calls[0] as unknown as [unknown, boolean, { toString(): string }];
    expect(call[1]).toBe(true); // swapForY for X→Y
    expect(call[2].toString()).toBe('50');
  });
});

describe('TransactionPolicy Meteora swap binding', () => {
  function policyFixture() {
    const keypair = Keypair.generate();
    const config = loadConfig(baseEnv({ WALLET_PUBKEY: keypair.publicKey.toBase58() }));
    return { keypair, policy: new TransactionPolicy(config, keypair.publicKey) };
  }

  function binding(walletKey: PublicKey) {
    return {
      pool: POOL,
      userTokenIn: getAssociatedTokenAddressSync(BASE_MINT, walletKey),
      userTokenOut: getAssociatedTokenAddressSync(QUOTE_MINT, walletKey),
      reserveX, reserveY,
      tokenXMint: BASE_MINT, tokenYMint: QUOTE_MINT,
      tokenXProgram: TOKEN_PROGRAM_ID, tokenYProgram: TOKEN_PROGRAM_ID,
      oracle,
      bitmapExtension: null,
      binArrays: [binArray],
      amountInRaw: 1_500_000_000n,
      minOutRaw: 149_250_000n,
    };
  }

  it('accepts the exact SDK account vector and payload', () => {
    const { keypair, policy } = policyFixture();
    const userTokenIn = getAssociatedTokenAddressSync(BASE_MINT, keypair.publicKey);
    const userTokenOut = getAssociatedTokenAddressSync(QUOTE_MINT, keypair.publicKey);
    const program = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
    const [eventAuthority] = deriveEventAuthority(program);
    const aligned = new Transaction({
      feePayer: keypair.publicKey, recentBlockhash: '11111111111111111111111111111111',
    }).add({
      programId: program,
      keys: [
        POOL, program, reserveX, reserveY, userTokenIn, userTokenOut,
        BASE_MINT, QUOTE_MINT, oracle, program, keypair.publicKey,
        TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, eventAuthority, program,
        binArray,
      ].map((pubkey, index) => ({
        pubkey,
        isSigner: index === 10,
        isWritable: ![6, 7, 11, 12, 13, 14, 15].includes(index),
      })),
      data: encodeSwap2Payload(1_500_000_000n, 149_250_000n),
    });
    const expected = binding(keypair.publicKey);
    expect(() => policy.validate(aligned, {
      writableAccounts: [
        userTokenIn, userTokenOut, reserveX, reserveY, oracle, binArray,
      ],
      pools: [POOL],
      mints: [TEST_BASE_MINT, TEST_QUOTE_MINT],
      amounts: { maxSlippageBps: 50, solSpendLamports: 4_205_000 },
      meteoraSwap: expected,
    })).not.toThrow();
  });

  it('rejects a swap2 instruction delivered without a policy binding', () => {
    const { keypair, policy } = policyFixture();
    const program = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
    const tx = new Transaction({
      feePayer: keypair.publicKey, recentBlockhash: '11111111111111111111111111111111',
    }).add({
      programId: program,
      keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
      data: encodeSwap2Payload(1n, 1n),
    });
    try {
      policy.validate(tx, { writableAccounts: [], amounts: {} });
      expect.unreachable();
    } catch (error) {
      expect((error as PolicyRejected).rule).toBe('meteora_swap_binding');
    }
  });

  it('rejects tampered amounts, foreign accounts, and unexpected Meteora tags', () => {
    const { keypair, policy } = policyFixture();
    const base = binding(keypair.publicKey);
    const userTokenIn = getAssociatedTokenAddressSync(BASE_MINT, keypair.publicKey);
    const userTokenOut = getAssociatedTokenAddressSync(QUOTE_MINT, keypair.publicKey);
    const program = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
    const [eventAuthority] = deriveEventAuthority(program);
    const accounts = [
      POOL, program, reserveX, reserveY, userTokenIn, userTokenOut,
      BASE_MINT, QUOTE_MINT, oracle, program, keypair.publicKey,
      TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, eventAuthority, program,
      binArray,
    ];
    const txWith = (ixKeys: PublicKey[], data: Buffer, extra = false) => {
      const tx = new Transaction({
        feePayer: keypair.publicKey, recentBlockhash: '11111111111111111111111111111111',
      }).add({
        programId: program,
        keys: ixKeys.map((pubkey, index) => ({
          pubkey,
          isSigner: index === 10,
          isWritable: ![6, 7, 11, 12, 13, 14, 15].includes(index),
        })),
        data,
      });
      if (extra) {
        tx.add({
          programId: program,
          keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
          data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
        });
      }
      return tx;
    };
    const input = {
      writableAccounts: [userTokenIn, userTokenOut, reserveX, reserveY, oracle, binArray],
      pools: [POOL], mints: [TEST_BASE_MINT, TEST_QUOTE_MINT],
      amounts: { maxSlippageBps: 50 },
      meteoraSwap: base,
    };
    const rejectWith = (tx: Transaction, expected: typeof input) => {
      try {
        policy.validate(tx, expected);
        expect.unreachable('policy must reject');
      } catch (error) {
        expect((error as PolicyRejected).rule).toBe('meteora_swap_binding');
      }
    };
    rejectWith(
      txWith(accounts, encodeSwap2Payload(1_500_000_001n, 149_250_000n)), input,
    );
    rejectWith(
      txWith(accounts, encodeSwap2Payload(1_500_000_000n, 149_249_999n)), input,
    );
    // A foreign input account declared writable still fails the account binding.
    const foreign = Keypair.generate().publicKey;
    rejectWith(
      txWith(accounts.map((key, index) => index === 4 ? foreign : key),
        encodeSwap2Payload(1_500_000_000n, 149_250_000n)),
      { ...input, writableAccounts: [...input.writableAccounts, foreign] },
    );
    rejectWith(txWith(accounts, encodeSwap2Payload(1_500_000_000n, 149_250_000n), true), input);
    // A zero minimum output is rejected even when the binding agrees.
    rejectWith(
      txWith(accounts, encodeSwap2Payload(1_500_000_000n, 0n)),
      { ...input, meteoraSwap: { ...base, minOutRaw: 0n } },
    );
    // Non-empty transfer-hook slices are unsupported.
    rejectWith(
      txWith(accounts, encodeSwap2Payload(1_500_000_000n, 149_250_000n,
        [{ type: 0, length: 2 }, { type: 1, length: 0 }])),
      input,
    );
  });

  it('rejects unknown programs inside a bound swap transaction', () => {
    const { keypair, policy } = policyFixture();
    const userTokenIn = getAssociatedTokenAddressSync(BASE_MINT, keypair.publicKey);
    const userTokenOut = getAssociatedTokenAddressSync(QUOTE_MINT, keypair.publicKey);
    const program = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
    const [eventAuthority] = deriveEventAuthority(program);
    const swapIx = {
      programId: program,
      keys: [
        POOL, program, reserveX, reserveY, userTokenIn, userTokenOut,
        BASE_MINT, QUOTE_MINT, oracle, program, keypair.publicKey,
        TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, eventAuthority, program,
        binArray,
      ].map((pubkey, index) => ({
        pubkey,
        isSigner: index === 10,
        isWritable: ![6, 7, 11, 12, 13, 14, 15].includes(index),
      })),
      data: encodeSwap2Payload(1_500_000_000n, 149_250_000n),
    };
    const stranger = new Transaction({
      feePayer: keypair.publicKey, recentBlockhash: '11111111111111111111111111111111',
    }).add(
      swapIx,
      {
        programId: Keypair.generate().publicKey,
        keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.alloc(0),
      },
    );
    try {
      policy.validate(stranger, {
        writableAccounts: [userTokenIn, userTokenOut, reserveX, reserveY, oracle, binArray],
        pools: [POOL], mints: [TEST_BASE_MINT, TEST_QUOTE_MINT],
        amounts: { maxSlippageBps: 50 },
        meteoraSwap: binding(keypair.publicKey),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as PolicyRejected).rule).toBe('program_id_allowlist');
    }
  });
});
