import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createM4Handlers } from './handlers.js';
import { RpcReadError, UnknownPositionError } from './meteora.js';
import { PolicyRejected } from './policy.js';
import type { DepositSingleSidedRequest, PositionData, WithdrawRequest } from './protocol.js';
import { baseEnv } from './testing.js';
import { ConfirmedTransactionFailed, SimulationFailed } from './transactions.js';

const pool = new PublicKey('11111111111111111111111111111111');
const baseMint = new PublicKey('So11111111111111111111111111111111111111112');
const quoteMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function request(): DepositSingleSidedRequest {
  return {
    method: 'deposit_single_sided', pool: pool.toBase58(), side: 'bid',
    bin_ids: [98, 99], amounts: [75, 75], expected_active_bin: 100,
    max_active_bin_slippage: 0, strategy_type: 'Spot',
  };
}

/** `tokens` adds the wallet's base/quote gains to the receipt's token balances. */
function receiptFixture(tokens?: { owner: string; base: bigint; quote: bigint }) {
  const balances = (base: bigint, quote: bigint) => [
    { accountIndex: 1, mint: baseMint.toBase58(), owner: tokens!.owner, uiTokenAmount: { amount: base.toString() } },
    { accountIndex: 2, mint: quoteMint.toBase58(), owner: tokens!.owner, uiTokenAmount: { amount: quote.toString() } },
  ];
  return {
    policy: { messageHash: 'a'.repeat(64), solSpendLamports: 0 },
    blockhash: 'test-blockhash',
    meta: {
      fee: 5_000,
      ...(tokens === undefined ? {} : {
        preTokenBalances: balances(10_000_000_000n, 500_000_000n),
        postTokenBalances: balances(10_000_000_000n + tokens.base, 500_000_000n + tokens.quote),
      }),
    },
    receipt: {
      signature: 'confirmed-signature', slot: 42, block_time: 1_756_900_001,
      fee_lamports: 5_000, compute_unit_price: 0, status: 'confirmed' as const,
    },
  };
}

function positionFixture(args: { owner: PublicKey; position: PublicKey; baseRaw: string; quoteRaw: string }): PositionData {
  return {
    position_id: args.position.toBase58(),
    pool: pool.toBase58(),
    owner: args.owner.toBase58(),
    active_bin: 100,
    min_bin_id: 98,
    max_bin_id: 99,
    bins: [
      {
        bin_id: 98, bin_price: 149,
        amount_base: 0, amount_quote: 0,
        amount_base_raw: args.baseRaw, amount_quote_raw: args.quoteRaw,
      },
    ],
    claimable_fee_x: 0.003,
    claimable_fee_y: 0.5,
    claimable_fee_x_raw: '3000000',
    claimable_fee_y_raw: '500000',
    total_base: 0.2,
    total_quote: 30,
    slot: 42,
  };
}

function stateFixture(baseRaw = '10000000000', quoteRaw = '500000000') {
  return {
    active_bin: 100, bin_step_bps: 20, base_fee_bps: 25,
    balances: { base: Number(baseRaw) / 1e9, quote: Number(quoteRaw) / 1e6 },
    balances_raw: { base: baseRaw, quote: quoteRaw },
    tvl_usd: null, token_x: { mint: baseMint.toBase58(), decimals: 9 },
    token_y: { mint: quoteMint.toBase58(), decimals: 6 }, slot: 42, fetched_at: 1,
  };
}

function fixture(custom?: () => Promise<ReturnType<typeof receiptFixture>>) {
  const wallet = Keypair.generate().publicKey;
  /** Wallet token gains the default receipt reports; withdrawal tests set them. */
  const gains = { base: 0n, quote: 0n };
  const execute = vi.fn(custom ?? (async () => receiptFixture({ owner: wallet.toBase58(), ...gains })));
  // The real executor validates through the policy, which records each message
  // hash; the injected execute bypasses it, so mirror that side effect here.
  const validatedHashes: string[] = [];
  const recordingExecute = vi.fn(async (...args: Parameters<typeof execute>) => {
    const executed = await execute(...args);
    validatedHashes.push(executed.policy.messageHash);
    return executed;
  });
  const position = Keypair.generate().publicKey;
  const before = positionFixture({ owner: wallet, position, baseRaw: '200000000', quoteRaw: '30000000' });
  const reads = {
    getState: vi.fn(async () => stateFixture()),
    getWritablePoolMetadata: vi.fn(async () => ({
      pool, binStep: 20,
      tokenX: { mint: baseMint, reserve: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 9 },
      tokenY: { mint: quoteMint, reserve: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 },
    })),
    getPosition: vi.fn(async () => before),
  };
  const connection = { getMultipleAccountsInfo: vi.fn(async () => [null, null, null]) };
  const handlers = createM4Handlers(reads as never, {
    connection: connection as never,
    signer: { publicKey: wallet, signerId: wallet.toBase58(), sign: vi.fn() },
    policy: { takeValidatedMessageHashes: () => validatedHashes.splice(0) } as never,
    commitment: 'confirmed',
    config: loadConfig(baseEnv()),
    execute: recordingExecute,
    sleep: async () => undefined,
  });
  return { handlers, reads, execute, wallet, position, before, gains };
}

describe('M4 weighted deposit handler composition', () => {
  it('returns the deterministic position, target profile, and real receipt', async () => {
    const { handlers, execute } = fixture();
    const result = await handlers.deposit_single_sided(request());
    expect(result).toMatchObject({
      ok: true,
      data: {
        allocation_mode: 'weighted', max_debit_amount: 150,
        bins: [
          { bin_id: 98, amount: 75, target_bps: 5_000 },
          { bin_id: 99, amount: 75, target_bps: 5_000 },
        ],
      },
      tx_signatures: ['confirmed-signature'],
      transactions: [{ signature: 'confirmed-signature', fee_lamports: 5_000 }],
    });
    expect(result.position_id).toBeTruthy();
    expect(execute).toHaveBeenCalledOnce();
    expect(handlers.writeAudit()).toMatchObject({
      policyDecision: 'allowed',
      messageHashes: ['a'.repeat(64)],
      blockhash: 'test-blockhash',
      simulationOk: true,
    });
  });

  it('rejects a stale request before execution', async () => {
    const { handlers, reads, execute } = fixture();
    reads.getState.mockResolvedValueOnce({
      ...(await reads.getState()), active_bin: 101,
    });
    const result = await handlers.deposit_single_sided(request());
    expect(result.error).toBe('active_bin_slippage_exceeded');
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns the compiled-policy rule in the response and the audit line', async () => {
    const { handlers } = fixture(vi.fn(async () => {
      throw new PolicyRejected('native_deposit_binding', 'payload mismatch');
    }));
    const rejected = await handlers.deposit_single_sided(request());
    expect(rejected).toMatchObject({
      ok: false, error: 'policy_rejected', data: { rule: 'native_deposit_binding' },
    });
    expect(handlers.writeAudit()).toMatchObject({
      policyDecision: 'rejected', policyRule: 'native_deposit_binding', simulationOk: null,
    });
  });

  it('returns a failed chain receipt rather than an ambiguous submission', async () => {
    const chainError = { InstructionError: [2, { Custom: 6004 }] };
    const receipt = { signature: 'failed-signature', slot: 42, block_time: 1_756_900_001,
      fee_lamports: 5_000, compute_unit_price: null, status: 'failed' as const };
    const { handlers } = fixture(async () => {
      throw new ConfirmedTransactionFailed(receipt, chainError);
    });
    const result = await handlers.deposit_single_sided(request());
    expect(result).toMatchObject({
      ok: false, error: 'transaction_failed', data: { chain_error: chainError },
      tx_signatures: ['failed-signature'], transactions: [receipt],
    });
  });

  it('maps a simulated bin-slippage rejection to active_bin_slippage_exceeded', async () => {
    // Logged by the live met-usdc run, 2026-10-07: the bin moved 2 between read and simulation.
    const logs = ['Program log: AnchorError thrown in programs/lb_clmm/src/instructions/deposit/'
      + 'add_liquidity_by_weight_one_side.rs:53. Error Code: ExceededBinSlippageTolerance. '
      + 'Error Number: 6004. Error Message: Exceeded bin slippage tolerance.'];
    const { handlers } = fixture(async () => { throw new SimulationFailed(logs, undefined, 'bh'); });
    const result = await handlers.deposit_single_sided(request());
    expect(result).toMatchObject({ ok: false, error: 'active_bin_slippage_exceeded', tx_signatures: [] });
    expect(handlers.writeAudit()).toMatchObject({ simulationOk: false, simulationLogs: logs });

    const other = fixture(async () => { throw new SimulationFailed(['route expired'], undefined, 'bh'); });
    expect((await other.handlers.deposit_single_sided(request())).error).toBe('simulation_failed');
  });
});

describe('M4 withdrawal handler composition', () => {
  it('settles realized amounts from the post-execution readback', async () => {
    const { handlers, reads, execute, before, wallet, position, gains } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(positionFixture({
        owner: wallet, position, baseRaw: '100000000', quoteRaw: '30000000',
      }));
    // Receipt deltas: principal plus the claimed fee entitlement.
    gains.base = 103_000_000n;
    gains.quote = 500_000n;
    const request: WithdrawRequest = {
      method: 'withdraw', position_id: before.position_id, percent: 50,
    };
    const result = await handlers.withdraw(request);
    expect(result).toMatchObject({
      ok: true,
      data: {
        fraction: 0.5,
        fees_claimed: { x_raw: '3000000', y_raw: '500000' },
        amounts_returned: { base_raw: '100000000', quote_raw: '0' },
        closed: false,
      },
      tx_signatures: ['confirmed-signature'],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(handlers.writeAudit()).toMatchObject({
      policyDecision: 'allowed', simulationOk: true, blockhash: 'test-blockhash',
    });
  });

  it('reports a closed position and the full balance when the account is gone', async () => {
    const { handlers, reads, before, gains } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new UnknownPositionError('gone'));
    gains.base = 203_000_000n;
    gains.quote = 30_500_000n;
    const request: WithdrawRequest = {
      method: 'withdraw', position_id: before.position_id, percent: 100,
    };
    const result = await handlers.withdraw(request);
    expect(result).toMatchObject({
      ok: true,
      data: {
        fraction: 1,
        amounts_returned: { base_raw: '200000000', quote_raw: '30000000' },
        closed: true,
      },
    });
  });

  it('uses finalized commitment for a full close', async () => {
    const { handlers, reads, execute, before } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new UnknownPositionError('gone'));
    await handlers.withdraw({ method: 'withdraw', position_id: before.position_id, percent: 100 });
    const call = execute.mock.calls[0] as unknown as [unknown, { commitment: string }];
    expect(call[1]).toMatchObject({ commitment: 'finalized' });
  });

  it('re-reads a lagging node until the confirmed close is visible', async () => {
    // Live 2026-10-02: a finalized close was reported ambiguous on one stale read.
    const { handlers, reads, before, gains } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new RpcReadError('lagging endpoint'))
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new UnknownPositionError('gone'));
    gains.base = 203_000_000n;
    gains.quote = 30_500_000n;
    const result = await handlers.withdraw({
      method: 'withdraw', position_id: before.position_id, percent: 100,
    });
    expect(result).toMatchObject({ ok: true, data: { closed: true } });
    expect(reads.getPosition).toHaveBeenCalledTimes(4);
  });

  it('returns the confirmed receipt as ambiguous, naming the check, when reads never agree', async () => {
    const { handlers, reads, before } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new RpcReadError('lagging endpoint'));
    const result = await handlers.withdraw({
      method: 'withdraw', position_id: before.position_id, percent: 100,
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'submission_ambiguous',
      data: {
        detail: 'confirmed withdrawal could not be reconciled from chain state: '
          + 'position still present after close',
        pending_signature: 'confirmed-signature',
      },
      tx_signatures: ['confirmed-signature'],
      transactions: [{ signature: 'confirmed-signature' }],
    });
  });

  it('rejects a position read that is not owned by the signer before execution', async () => {
    const { handlers, reads, execute } = fixture();
    reads.getPosition.mockRejectedValueOnce(new UnknownPositionError('foreign'));
    const result = await handlers.withdraw({
      method: 'withdraw', position_id: Keypair.generate().publicKey.toBase58(), percent: 100,
    });
    expect(result.error).toBe('unknown_position');
    expect(execute).not.toHaveBeenCalled();
  });
});
