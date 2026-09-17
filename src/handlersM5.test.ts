/** M5 handler composition: direct DLMM pool swap and sequential refresh_bundle (offline). */
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createM4Handlers, type WriteDependencies } from './handlers.js';
import { UnknownPositionError } from './meteora.js';
import { PolicyRejected } from './policy.js';
import { BundlePreForwardError, type BundleLeg } from './bundle.js';
import type { TransactionMeta } from './transactions.js';
import type {
  PositionData,
  RefreshBundleData,
  RefreshBundleRequest,
  SwapData,
  SwapRequest,
} from './protocol.js';
import {
  SimulationFailed,
  SubmissionAmbiguous,
  executeLegacyTransaction,
  type ExecutedTransaction,
} from './transactions.js';
import { baseEnv, TEST_POOL, TEST_QUOTE_MINT } from './testing.js';

const IN_MINT = TEST_QUOTE_MINT;
const POOL = new PublicKey(TEST_POOL);
const BASE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

type ExecuteOptions = Parameters<typeof executeLegacyTransaction>[1];

function mintState(decimals: number, balanceRaw: string) {
  return { decimals, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), walletBalanceRaw: balanceRaw };
}

function stateFixture(baseRaw = '10000000000', quoteRaw = '500000000') {
  return {
    active_bin: 100, bin_step_bps: 20, base_fee_bps: 25,
    balances: { base: Number(baseRaw) / 1e9, quote: Number(quoteRaw) / 1e6 },
    balances_raw: { base: baseRaw, quote: quoteRaw },
    tvl_usd: null, token_x: { mint: BASE_MINT.toBase58(), decimals: 9 },
    token_y: { mint: IN_MINT, decimals: 6 },
    slot: 42, fetched_at: 1,
  };
}

function positionFixture(owner: PublicKey, position: PublicKey): PositionData {
  return {
    position_id: position.toBase58(), pool: TEST_POOL, owner: owner.toBase58(),
    active_bin: 100, min_bin_id: 98, max_bin_id: 99,
    bins: [{
      bin_id: 98, bin_price: 149, amount_base: 0, amount_quote: 0,
      amount_base_raw: '200000000', amount_quote_raw: '30000000',
    }],
    claimable_fee_x: 0.003, claimable_fee_y: 0.5,
    claimable_fee_x_raw: '3000000', claimable_fee_y_raw: '500000',
    total_base: 0.2, total_quote: 30, slot: 42,
  };
}

/** The pool's own quote: 1.5 WSOL in (9 decimals) for 1000 USDC out, 50 bps bound. */
function swapQuoteResult(minOutRaw: string) {
  return {
    consumedInAmount: { toString: () => '1500000000' },
    outAmount: { toString: () => '1000000000' },
    minOutAmount: { toString: () => minOutRaw },
    binArraysPubkey: [Keypair.generate().publicKey],
  };
}

/** SDK reader for TEST_POOL: tokenX = wrapped SOL, tokenY = USDC. */
function poolReader(minOutRaw = '995000000') {
  return {
    pubkey: POOL,
    lbPair: { binStep: 20, oracle: Keypair.generate().publicKey },
    tokenX: { publicKey: BASE_MINT, reserve: Keypair.generate().publicKey, mint: { decimals: 9 } },
    tokenY: { publicKey: new PublicKey(IN_MINT), reserve: Keypair.generate().publicKey, mint: { decimals: 6 } },
    async getActiveBin() { return { binId: 100 }; },
    getFeeInfo() {
      return { baseFeeRatePercentage: { mul: () => ({ toString: () => '0.25' }) } };
    },
    async getPosition() { return null as never; },
    binArrayBitmapExtension: null,
    async getBinArrayForSwap() { return [{ account: {}, publicKey: Keypair.generate().publicKey }]; },
    swapQuote: () => swapQuoteResult(minOutRaw),
    // A legacy transaction: the direct pool route executes through `execute`.
    swap: async () => new Transaction(),
  };
}

function swapRequest(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    method: 'swap', in_mint: BASE_MINT.toBase58(), out_mint: IN_MINT,
    amount: 1.5, max_slippage_bps: 50, pool: TEST_POOL, ...overrides,
  };
}

/** Withdraw/deposit legs need no balance meta; only the swap leg is settled. */
function legacyExecuted(signature: string): ExecutedTransaction {
  return {
    policy: { messageHash: 'a'.repeat(64), solSpendLamports: 0 },
    blockhash: 'test-blockhash',
    meta: { fee: 5_000 },
    receipt: {
      signature, slot: 42, block_time: 1_756_900_001,
      fee_lamports: 5_000, compute_unit_price: 0, status: 'confirmed' as const,
    },
  };
}

/**
 * A landed base→quote pool swap. The wrapped-SOL input is read from the
 * wallet's lamports delta minus the fee (10 SOL → 8.499995 SOL + 5_000 fee =
 * 1.5 SOL in); the USDC output is the wallet's IN_MINT token-balance gain.
 */
function swapExecuted(wallet: PublicKey, realizedOutRaw: string): ExecutedTransaction {
  const preOut = 500_000_000n;
  return {
    policy: { messageHash: 'b'.repeat(64), solSpendLamports: 0 },
    blockhash: 'test-blockhash',
    meta: {
      fee: 5_000,
      preBalances: [10_000_000_000],
      postBalances: [8_499_995_000],
      preTokenBalances: [
        {
          accountIndex: 2, mint: IN_MINT, owner: wallet.toBase58(),
          uiTokenAmount: { amount: preOut.toString() },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2, mint: IN_MINT, owner: wallet.toBase58(),
          uiTokenAmount: { amount: (preOut + BigInt(realizedOutRaw)).toString() },
        },
      ],
    },
    receipt: {
      signature: 'swap-sig', slot: 43, block_time: 1_756_900_002,
      fee_lamports: 6_000, compute_unit_price: 0, status: 'confirmed' as const,
    },
  };
}

/**
 * The real `execute` validates through the policy, which accumulates the hash
 * of every message it signs off on; mirror that so `writeAudit()` sees them.
 */
function track<A extends unknown[]>(
  execute: (...args: A) => Promise<ExecutedTransaction>,
  sink: string[],
) {
  return vi.fn(async (...args: A) => {
    const executed = await execute(...args);
    sink.push(executed.policy.messageHash);
    return executed;
  });
}

interface FixtureOptions {
  execute?: WriteDependencies['execute'];
  executeVersioned?: WriteDependencies['executeVersioned'];
  jitoEnabled?: boolean;
  realizedOutRaw?: string;
  bundleSubmit?: WriteDependencies['bundleSubmit'];
}

function fixture(options: FixtureOptions = {}) {
  const wallet = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;
  const validatedHashes: string[] = [];
  /** Sequential refresh_bundle signing order. The swap leg is identified by its
   *  policy binding, so a standalone swap also lands as 'swap-sig'. */
  const legacySignatures = ['withdraw-sig', 'swap-sig', 'deposit-bid-sig', 'deposit-ask-sig'];
  let legacyCall = 0;
  const execute = track(options.execute ?? (async (_tx: Transaction, opts: ExecuteOptions) => {
    if (opts.policyInput.meteoraSwap !== undefined) {
      return swapExecuted(wallet, options.realizedOutRaw ?? '1000000000');
    }
    legacyCall += 1;
    const plain = legacySignatures.filter((signature) => signature !== 'swap-sig');
    return legacyExecuted(plain[legacyCall - 1] ?? `legacy-${legacyCall}`);
  }), validatedHashes);
  const executeVersioned = track(
    options.executeVersioned ?? (async () => swapExecuted(wallet, '1000000000')),
    validatedHashes,
  );
  const reads = {
    getState: vi.fn(async () => stateFixture()),
    getWritablePoolMetadata: vi.fn(async () => ({
      pool: POOL, binStep: 20, oracle: Keypair.generate().publicKey,
      tokenX: {
        mint: BASE_MINT, reserve: Keypair.generate().publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, decimals: 9,
      },
      tokenY: {
        mint: new PublicKey(IN_MINT), reserve: Keypair.generate().publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, decimals: 6,
      },
    })),
    getPosition: vi.fn(async () => positionFixture(wallet, position)),
    getMintState: vi.fn(async (mint: string) =>
      (mint === IN_MINT ? mintState(6, '2000000') : mintState(9, '20000000000'))),
    getSwapPoolReader: vi.fn(async () => poolReader()),
  };
  const connection = { getMultipleAccountsInfo: vi.fn(async () => [null, null, null]) };
  const config = loadConfig(baseEnv({
    MINT_ALLOWLIST: `${IN_MINT},${BASE_MINT.toBase58()}`,
    ...(options.jitoEnabled
      ? {
        JITO_ENABLED: 'true',
        JITO_BLOCK_ENGINE_URL: 'https://bundles.jito.test',
        JITO_TIP_ACCOUNT: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        JITO_TIP_LAMPORTS: '1000',
      }
      : {}),
  }));
  const jito = {
    sendBundle: vi.fn(async () => 'bundle-1'),
    inflightStatuses: vi.fn(async () => []),
    bundleStatuses: vi.fn(async () => []),
  };
  const handlers = createM4Handlers(reads as never, {
    connection: connection as never,
    signer: { publicKey: wallet, signerId: wallet.toBase58(), sign: vi.fn() },
    policy: { takeValidatedMessageHashes: () => validatedHashes.splice(0) } as never,
    commitment: 'confirmed',
    config,
    jito,
    execute,
    executeVersioned,
    ...(options.bundleSubmit ? { bundleSubmit: options.bundleSubmit } : {}),
  });
  return {
    handlers, reads, execute, executeVersioned, jito, wallet, position, validatedHashes,
  };
}

function refreshRequest(positionId: string, overrides: Partial<RefreshBundleRequest> = {}): RefreshBundleRequest {
  return {
    method: 'refresh_bundle',
    withdraw_position_id: positionId,
    swap_spec: { in_mint: BASE_MINT.toBase58(), out_mint: IN_MINT, amount: 1.5 },
    deposit_spec: {
      pool: TEST_POOL, expected_active_bin: 100, max_active_bin_slippage: 1,
      bid_bins: [98, 99], ask_bins: [101, 102],
      bid_amounts: [75, 75], ask_amounts: [0.5, 0.5],
    },
    ...overrides,
  };
}

/** Withdraw leg: the full-close readback expects the position gone and the
 *  wallet richer by principal + claimed fees. */
function withLandedWithdraw(reads: ReturnType<typeof fixture>['reads'], wallet: PublicKey, position: PublicKey) {
  reads.getPosition
    .mockResolvedValueOnce(positionFixture(wallet, position))
    .mockRejectedValueOnce(new UnknownPositionError('closed'));
  reads.getState
    .mockResolvedValueOnce(stateFixture())
    .mockResolvedValueOnce(stateFixture('10200000000', '503000000'));
}

describe('M5 swap handler', () => {
  it('settles SwapData from the confirmed receipt, not the quote', async () => {
    const { handlers, execute, executeVersioned } = fixture();
    const result = await handlers.swap(swapRequest());
    expect(result).toMatchObject({
      ok: true,
      data: {
        amount_in: 1.5, amount_out: 1000,
        amount_in_raw: '1500000000', amount_out_raw: '1000000000',
        price_realized: expect.closeTo(1000 / 1.5, 5),
        route: 'meteora',
      },
      tx_signatures: ['swap-sig'],
      transactions: [{ signature: 'swap-sig', fee_lamports: 6_000 }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(executeVersioned).not.toHaveBeenCalled();
    expect(handlers.writeAudit()).toMatchObject({
      policyDecision: 'allowed', messageHashes: ['b'.repeat(64)], simulationOk: true,
    });
  });

  it('reports realized amounts that differ from the modeled quote', async () => {
    const { handlers } = fixture({ realizedOutRaw: '999000000' });
    const result = await handlers.swap(swapRequest());
    expect(result.ok).toBe(true);
    expect((result.data as SwapData).amount_out_raw).toBe('999000000');
  });

  it('rejects symbolic and non-allow-listed mints without reading the pool', async () => {
    const { handlers, reads, execute } = fixture();
    const symbolic = await handlers.swap(swapRequest({ in_mint: 'base' }));
    expect(symbolic).toMatchObject({ ok: false, error: 'bad_request' });
    const foreign = await handlers.swap(swapRequest({ in_mint: Keypair.generate().publicKey.toBase58() }));
    expect(foreign).toMatchObject({ ok: false, error: 'bad_request' });
    expect(reads.getSwapPoolReader).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects the stand-by aggregator route before any submission', async () => {
    const { handlers, execute, executeVersioned } = fixture();
    const result = await handlers.swap(swapRequest({ pool: null }));
    expect(result).toMatchObject({ ok: false, error: 'bad_request' });
    expect(execute).not.toHaveBeenCalled();
    expect(executeVersioned).not.toHaveBeenCalled();
  });

  it('never submits a partially-acceptable route: a loose bound fails before execution', async () => {
    const loose = fixture();
    // 1000 USDC out against a 900 USDC floor: 1000 bps, far past the 50 bps cap.
    loose.reads.getSwapPoolReader.mockResolvedValueOnce(poolReader('900000000'));
    const result = await loose.handlers.swap(swapRequest());
    expect(result).toMatchObject({ ok: false, error: 'slippage_exceeded' });
    expect(loose.execute).not.toHaveBeenCalled();
  });

  it('rejects an unfunded swap before any submission', async () => {
    const poor = fixture();
    poor.reads.getMintState.mockImplementation(async (mint: string) =>
      (mint === IN_MINT ? mintState(6, '100') : mintState(9, '20000000000')));
    // Quote→base: a wrapped-SOL input is funded by wrapping lamports, so only
    // an SPL input is checked against a wallet token balance.
    const result = await poor.handlers.swap(swapRequest({
      in_mint: IN_MINT, out_mint: BASE_MINT.toBase58(),
    }));
    expect(result).toMatchObject({ ok: false, error: 'insufficient_balance' });
    expect(poor.execute).not.toHaveBeenCalled();
  });

  it('maps simulation and policy failures to stable codes with audit', async () => {
    const { handlers } = fixture({
      execute: vi.fn(async () => {
        throw new SimulationFailed(['route expired'], undefined, 'bh');
      }),
    });
    const result = await handlers.swap(swapRequest());
    expect(result).toMatchObject({ ok: false, error: 'simulation_failed' });
    expect(handlers.writeAudit()).toMatchObject({ policyDecision: 'allowed', simulationOk: false });

    const rejected = fixture({
      execute: vi.fn(async () => {
        throw new PolicyRejected('meteora_swap_binding', 'payload mismatch');
      }),
    });
    const policyResult = await rejected.handlers.swap(swapRequest());
    expect(policyResult).toMatchObject({
      ok: false, error: 'policy_rejected', data: { rule: 'meteora_swap_binding' },
    });
  });

  it('surfaces an ambiguous submission with the pending signature', async () => {
    const { handlers } = fixture({
      execute: vi.fn(async () => {
        throw new SubmissionAmbiguous('timeout', 'swap-sig');
      }),
    });
    const result = await handlers.swap(swapRequest());
    expect(result).toMatchObject({
      ok: false,
      error: 'submission_ambiguous',
      data: { pending_signature: 'swap-sig' },
      tx_signatures: ['swap-sig'],
    });
  });

  it('flags a landed swap whose realized output broke the enforced minimum', async () => {
    const { handlers } = fixture({ realizedOutRaw: '990000000' });
    const result = await handlers.swap(swapRequest());
    expect(result).toMatchObject({ ok: false, error: 'slippage_exceeded' });
    expect(result.tx_signatures).toEqual(['swap-sig']);
    expect(result.transactions).toHaveLength(1);
  });
});

describe('M5 sequential refresh_bundle', () => {
  it('withdraws, swaps, and re-deposits both sides with one receipt per tx in order', async () => {
    const { handlers, reads, wallet, position, execute, executeVersioned } = fixture();
    withLandedWithdraw(reads, wallet, position);
    const result = await handlers.refresh_bundle(refreshRequest(position.toBase58()));
    expect(result.ok).toBe(true);
    const data = result.data as RefreshBundleData;
    expect(data.stage).toBe('deposited');
    expect(data.swap).toMatchObject({ amount_in_raw: '1500000000', route: 'meteora' });
    expect(data.fees_claimed).toMatchObject({ x_raw: '3000000', y_raw: '500000' });
    expect(data.amounts_returned).toMatchObject({ base_raw: '197000000', quote_raw: '2500000' });
    expect(result.tx_signatures).toEqual([
      'withdraw-sig', 'swap-sig', 'deposit-bid-sig', 'deposit-ask-sig',
    ]);
    expect(result.transactions.map((tx) => tx.signature)).toEqual(result.tx_signatures);
    // The keeper tracks one live position: the first (bid) redeposit leg wins,
    // mirroring _place_ladder semantics.
    expect(data.position_id).toBeTruthy();
    // A two-sided redeposit lands in two distinct PDAs; the response must
    // report both so the caller can close everything it opened.
    expect(data.position_ids).toHaveLength(2);
    expect(new Set(data.position_ids).size).toBe(2);
    expect(data.position_id).toBe(data.position_ids![0]);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(executeVersioned).not.toHaveBeenCalled();
  });

  it('audits one validated message hash per leg, in signing order', async () => {
    const { handlers, reads, wallet, position } = fixture();
    withLandedWithdraw(reads, wallet, position);
    const result = await handlers.refresh_bundle(refreshRequest(position.toBase58()));
    expect(result.ok).toBe(true);
    // writeAudit() drains, so read it once: every leg must be represented, not
    // just the last one to run.
    expect(handlers.writeAudit().messageHashes).toEqual([
      'a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64), 'a'.repeat(64),
    ]);
  });

  it('omits the swap leg and its data when swap_spec is null', async () => {
    const { handlers, reads, wallet, position, executeVersioned } = fixture();
    withLandedWithdraw(reads, wallet, position);
    const result = await handlers.refresh_bundle(
      refreshRequest(position.toBase58(), { swap_spec: null }),
    );
    expect(result.ok).toBe(true);
    expect(result.tx_signatures).toEqual(['withdraw-sig', 'deposit-bid-sig', 'deposit-ask-sig']);
    expect((result.data as RefreshBundleData).swap).toBeUndefined();
    expect(reads.getSwapPoolReader).not.toHaveBeenCalled();
    expect(executeVersioned).not.toHaveBeenCalled();
  });

  it('reports a pre-mutation withdraw failure without a stage (no state change claimed)', async () => {
    const { handlers, reads, execute } = fixture();
    reads.getPosition.mockRejectedValueOnce(new UnknownPositionError('foreign'));
    const result = await handlers.refresh_bundle(refreshRequest('missing-position'));
    expect(result).toMatchObject({ ok: false, error: 'unknown_position' });
    expect((result.data as RefreshBundleData | null)?.stage).toBeUndefined();
    expect(reads.getSwapPoolReader).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous withdrawal pending-signature visible and stops the sequence', async () => {
    const { handlers, reads, wallet, position } = fixture({
      execute: vi.fn(async () => {
        throw new SubmissionAmbiguous('timeout', 'pending-withdraw-sig');
      }),
    });
    withLandedWithdraw(reads, wallet, position);
    const result = await handlers.refresh_bundle(refreshRequest(position.toBase58()));
    expect(result).toMatchObject({ ok: false, error: 'submission_ambiguous' });
    expect(result.tx_signatures).toEqual(['pending-withdraw-sig']);
    expect(reads.getSwapPoolReader).not.toHaveBeenCalled();
  });

  it('reports stage withdrew when the swap leg fails after the withdrawal landed', async () => {
    const { handlers, reads, wallet, position, execute } = fixture({
      execute: vi.fn(async (_tx: Transaction, opts: ExecuteOptions) => {
        if (opts.policyInput.meteoraSwap !== undefined) {
          throw new SimulationFailed(['route expired'], undefined, 'bh');
        }
        return legacyExecuted('withdraw-sig');
      }),
    });
    withLandedWithdraw(reads, wallet, position);
    const result = await handlers.refresh_bundle(refreshRequest(position.toBase58()));
    expect(result).toMatchObject({ ok: false, error: 'simulation_failed' });
    const data = result.data as RefreshBundleData;
    expect(data.stage).toBe('withdrew');
    expect(data.fees_claimed).toBeTruthy();
    expect(data.amounts_returned).toBeTruthy();
    expect(result.tx_signatures).toEqual(['withdraw-sig']);
    expect(result.position_id).toBe(position.toBase58());
    // No blind retry: exactly one withdrawal and one swap attempt were submitted.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reports stage swapped when the first deposit leg fails', async () => {
    const f: ReturnType<typeof fixture> = fixture({
      execute: vi.fn(async (_tx: Transaction, opts: ExecuteOptions) => {
        if (opts.policyInput.nativeDeposit) {
          throw new PolicyRejected('native_deposit_binding', 'binding mismatch');
        }
        if (opts.policyInput.meteoraSwap !== undefined) {
          return swapExecuted(f.wallet, '1000000000');
        }
        return legacyExecuted('withdraw-sig');
      }),
    });
    withLandedWithdraw(f.reads, f.wallet, f.position);
    const result = await f.handlers.refresh_bundle(refreshRequest(f.position.toBase58()));
    expect(result).toMatchObject({ ok: false, error: 'policy_rejected' });
    const data = result.data as RefreshBundleData;
    expect(data.stage).toBe('swapped');
    expect(data.swap).toMatchObject({ amount_out_raw: '1000000000' });
    expect(result.tx_signatures).toEqual(['withdraw-sig', 'swap-sig']);
    expect(result.position_id).toBe(f.position.toBase58());
  });

  it('reports stage deposited with the bid position when only the ask leg fails', async () => {
    let deposits = 0;
    const f: ReturnType<typeof fixture> = fixture({
      execute: vi.fn(async (_tx: Transaction, opts: ExecuteOptions) => {
        if (opts.policyInput.nativeDeposit !== undefined) {
          deposits += 1;
          if (deposits === 2) throw new PolicyRejected('native_deposit_binding', 'ask leg failed');
          return legacyExecuted('deposit-bid-sig');
        }
        if (opts.policyInput.meteoraSwap !== undefined) {
          return swapExecuted(f.wallet, '1000000000');
        }
        return legacyExecuted('withdraw-sig');
      }),
    });
    withLandedWithdraw(f.reads, f.wallet, f.position);
    const result = await f.handlers.refresh_bundle(refreshRequest(f.position.toBase58(), {
      deposit_spec: {
        pool: TEST_POOL, expected_active_bin: 100, max_active_bin_slippage: 1,
        bid_bins: [96, 97], ask_bins: [101, 102],
        bid_amounts: [75, 75], ask_amounts: [0.5, 0.5],
      },
    }));
    expect(result).toMatchObject({ ok: false, error: 'policy_rejected' });
    const data = result.data as RefreshBundleData;
    expect(data.stage).toBe('deposited');
    expect(data.position_id).toBeTruthy();
    expect(data.position_id).not.toBe(f.position.toBase58());
    expect(result.position_id).toBe(data.position_id);
    expect(result.tx_signatures).toEqual(['withdraw-sig', 'swap-sig', 'deposit-bid-sig']);
  });

});

describe('M5 direct DLMM pool swap', () => {
  it('routes a pool-scoped swap through the SDK reader and reports route meteora', async () => {
    const f: ReturnType<typeof fixture> = fixture({
      execute: vi.fn(async () => ({
        ...swapExecuted(f.wallet, '1000000000'),
        policy: { messageHash: 'c'.repeat(64), solSpendLamports: 0 },
        receipt: {
          signature: 'direct-swap-sig', slot: 44, block_time: 1_756_900_003,
          fee_lamports: 5_000, compute_unit_price: 0, status: 'confirmed' as const,
        },
      })),
    });
    const result = await f.handlers.swap(swapRequest());
    expect(result).toMatchObject({
      ok: true,
      data: {
        route: 'meteora',
        amount_in_raw: '1500000000',
        amount_out_raw: '1000000000',
      },
      tx_signatures: ['direct-swap-sig'],
    });
    expect(f.reads.getSwapPoolReader).toHaveBeenCalledWith(TEST_POOL);
    expect(f.executeVersioned).not.toHaveBeenCalled();
  });

  it('keeps symbolic mint rejection ahead of any pool read', async () => {
    const f = fixture();
    const result = await f.handlers.swap(swapRequest({ in_mint: 'quote', pool: TEST_POOL }));
    expect(result).toMatchObject({ ok: false, error: 'bad_request' });
    expect(f.reads.getSwapPoolReader).not.toHaveBeenCalled();
  });
});

function landedReceipt(label: string, meta: TransactionMeta, finalized = false) {
  return {
    label,
    meta,
    receipt: {
      signature: `sig-${label}`, slot: 50, block_time: 1_756_900_010,
      fee_lamports: 5_000, compute_unit_price: null,
      status: finalized ? 'finalized' as const : 'confirmed' as const,
    },
  };
}

function bundleMeta(f: ReturnType<typeof fixture>): Record<string, TransactionMeta> {
  const owner = f.wallet.toBase58();
  return {
    withdraw: {
      fee: 5_000,
      preTokenBalances: [
        { accountIndex: 1, mint: BASE_MINT.toBase58(), owner, uiTokenAmount: { amount: '10000000000' } },
        { accountIndex: 2, mint: IN_MINT, owner, uiTokenAmount: { amount: '500000000' } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: BASE_MINT.toBase58(), owner, uiTokenAmount: { amount: '10200000000' } },
        { accountIndex: 2, mint: IN_MINT, owner, uiTokenAmount: { amount: '503000000' } },
      ],
    },
    swap: swapExecuted(f.wallet, '1000000000').meta,
    deposit_bid: { fee: 6_000 },
    deposit_ask: { fee: 6_000 },
  };
}

describe('M5 Jito bundle refresh', () => {
  it('forwards one bundle with the tip on the final guarded mutation and never solo-submits', async () => {
    let captured: BundleLeg[] | undefined;
    const bundleSubmit = vi.fn(async (legs: BundleLeg[]) => {
      captured = legs;
      const meta = bundleMeta(fixtureRef);
      return {
        kind: 'landed' as const,
        bundleId: 'bundle-1',
        blockhash: 'shared-blockhash',
        lastValidBlockHeight: 100,
        signatures: legs.map((leg) => `sig-${leg.label}`),
        statuses: ['sent:bundle-1', 'inflight:landed'],
        receipts: legs.map((leg) => landedReceipt(
          leg.label, meta[leg.label as keyof typeof meta], leg.label === 'withdraw',
        )),
      };
    });
    const fixtureRef = fixture({ jitoEnabled: true, bundleSubmit });
    withLandedWithdraw(fixtureRef.reads, fixtureRef.wallet, fixtureRef.position);
    const result = await fixtureRef.handlers.refresh_bundle(
      refreshRequest(fixtureRef.position.toBase58()),
    );
    expect(result.ok).toBe(true);
    const legs = captured!;
    expect(legs.map((leg) => leg.label)).toEqual([
      'withdraw', 'swap', 'deposit_bid', 'deposit_ask',
    ]);
    // Every component is policy-bound with its own transaction-local guard.
    expect(legs[0]!.policyInput.nativeWithdrawal).toBeTruthy();
    expect(legs[1]!.policyInput.meteoraSwap?.minOutRaw).toBe(995_000_000n);
    expect(legs[2]!.policyInput.nativeDeposit).toBeTruthy();
    expect(legs[3]!.policyInput.nativeDeposit).toBeTruthy();
    // The tip rides only inside the final deposit, never as its own tx.
    expect(legs.slice(0, 3).every((leg) => leg.policyInput.jitoTip === undefined)).toBe(true);
    expect(legs[3]!.policyInput.jitoTip).toMatchObject({ lamports: 1_000 });
    const tipIxes = (legs[3]!.transaction as Transaction).instructions.filter((ix) =>
      ix.programId.equals(SystemProgram.programId) && ix.data.readUInt32LE(0) === 2);
    expect(tipIxes).toHaveLength(1);
    expect(tipIxes[0]!.keys[1]!.pubkey.toBase58())
      .toBe('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
    expect(tipIxes[0]!.data.readBigUInt64LE(4)).toBe(1_000n);
    // No individual submissions: the sequential executors were never used.
    expect(fixtureRef.execute).not.toHaveBeenCalled();
    expect(fixtureRef.executeVersioned).not.toHaveBeenCalled();
    const data = result.data as RefreshBundleData;
    expect(data).toMatchObject({
      stage: 'deposited',
      bundle_id: 'bundle-1',
      fees_claimed: { x_raw: '3000000', y_raw: '500000' },
      amounts_returned: { base_raw: '197000000', quote_raw: '2500000' },
      swap: { amount_in_raw: '1500000000', amount_out_raw: '1000000000', route: 'meteora' },
    });
    expect(data.position_id).toBe(
      (legs[2]!.policyInput.nativeDeposit!.position as PublicKey).toBase58(),
    );
    expect(data.position_ids).toEqual([
      (legs[2]!.policyInput.nativeDeposit!.position as PublicKey).toBase58(),
      (legs[3]!.policyInput.nativeDeposit!.position as PublicKey).toBase58(),
    ]);
    expect(result.tx_signatures).toEqual([
      'sig-withdraw', 'sig-swap', 'sig-deposit_bid', 'sig-deposit_ask',
    ]);
    expect(fixtureRef.handlers.writeAudit()).toMatchObject({
      bundleId: 'bundle-1',
      bundleRecord: { outcome: 'landed', last_valid_block_height: 100 },
    });
  });

  it('omits the swap leg and tips the last deposit when swap_spec is null', async () => {
    let captured: BundleLeg[] | undefined;
    const bundleSubmit = vi.fn(async (legs: BundleLeg[]) => {
      captured = legs;
      const meta = bundleMeta(fixtureRef);
      return {
        kind: 'landed' as const, bundleId: 'b2', blockhash: 'bh', lastValidBlockHeight: 9,
        signatures: legs.map((leg) => `sig-${leg.label}`), statuses: [],
        receipts: legs.map((leg) => landedReceipt(
          leg.label, meta[leg.label as keyof typeof meta], leg.label === 'withdraw',
        )),
      };
    });
    const fixtureRef = fixture({ jitoEnabled: true, bundleSubmit });
    withLandedWithdraw(fixtureRef.reads, fixtureRef.wallet, fixtureRef.position);
    const result = await fixtureRef.handlers.refresh_bundle(
      refreshRequest(fixtureRef.position.toBase58(), { swap_spec: null }),
    );
    expect(result.ok).toBe(true);
    expect(captured!.map((leg) => leg.label)).toEqual(['withdraw', 'deposit_bid', 'deposit_ask']);
    expect(captured!.at(-1)!.policyInput.jitoTip).toBeTruthy();
    expect((result.data as RefreshBundleData).swap).toBeUndefined();
  });

  it('reports bundle_dropped with no state change after a proven drop', async () => {
    const bundleSubmit = vi.fn(async () => ({
      kind: 'dropped' as const,
      bundleId: 'b3',
      reason: 'rejected before inclusion; signatures absent, blockhash expired',
      blockhash: 'bh',
      lastValidBlockHeight: 9,
      signatures: ['sig-withdraw', 'sig-deposit_bid'],
      statuses: ['inflight:expired'],
    }));
    const f = fixture({ jitoEnabled: true, bundleSubmit });
    withLandedWithdraw(f.reads, f.wallet, f.position);
    const result = await f.handlers.refresh_bundle(
      refreshRequest(f.position.toBase58(), { swap_spec: null }),
    );
    expect(result).toMatchObject({ ok: false, error: 'internal_error' });
    const data = result.data as RefreshBundleData;
    expect(data.stage).toBe('bundle_dropped');
    expect(data.bundle_id).toBe('b3');
    expect(result.tx_signatures).toEqual([]);
    expect(result.position_id).toBe(f.position.toBase58());
  });

  it('reports submission_ambiguous with every component signature unresolved', async () => {
    const bundleSubmit = vi.fn(async () => ({
      kind: 'ambiguous' as const,
      bundleId: 'b4',
      reason: 'status did not resolve before the polling deadline',
      blockhash: 'bh',
      lastValidBlockHeight: 9,
      signatures: ['sig-withdraw', 'sig-deposit_bid'],
      statuses: ['inflight:pending'],
    }));
    const f = fixture({ jitoEnabled: true, bundleSubmit });
    withLandedWithdraw(f.reads, f.wallet, f.position);
    const result = await f.handlers.refresh_bundle(
      refreshRequest(f.position.toBase58(), { swap_spec: null }),
    );
    expect(result).toMatchObject({ ok: false, error: 'submission_ambiguous' });
    expect(result.tx_signatures).toEqual(['sig-withdraw', 'sig-deposit_bid']);
    const data = result.data as RefreshBundleData;
    expect(data.pending_signature).toBe('sig-withdraw');
    expect(data.component_signatures).toEqual(['sig-withdraw', 'sig-deposit_bid']);
    expect(data.last_valid_block_height).toBe(9);
    expect(f.handlers.writeAudit().bundleRecord?.outcome).toBe('ambiguous');
  });

  it('classifies a pre-forward rejection as bundle_dropped with the specific error', async () => {
    const bundleSubmit = vi.fn(async () => {
      throw new BundlePreForwardError(
        'bundle component failed admission or signing',
        new PolicyRejected('native_deposit_binding', 'binding mismatch'),
      );
    });
    const f = fixture({ jitoEnabled: true, bundleSubmit });
    withLandedWithdraw(f.reads, f.wallet, f.position);
    const result = await f.handlers.refresh_bundle(
      refreshRequest(f.position.toBase58(), { swap_spec: null }),
    );
    expect(result).toMatchObject({ ok: false, error: 'policy_rejected' });
    const data = result.data as RefreshBundleData;
    expect(data.stage).toBe('bundle_dropped');
    expect(f.execute).not.toHaveBeenCalled();
  });
});
