import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createM4Handlers } from './handlers.js';
import { RpcReadError, UnknownPositionError } from './meteora.js';
import { PolicyRejected } from './policy.js';
import type { DepositSingleSidedRequest, PositionData, WithdrawRequest } from './protocol.js';

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

function receiptFixture() {
  return {
    policy: { messageHash: 'a'.repeat(64), solSpendLamports: 0 },
    blockhash: 'test-blockhash',
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

function fixture(execute = vi.fn(async () => receiptFixture())) {
  const wallet = Keypair.generate().publicKey;
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
    policy: {} as never,
    commitment: 'confirmed',
    execute,
  });
  return { handlers, reads, execute, wallet, position, before };
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
      messageHash: 'a'.repeat(64),
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
});

describe('M4 withdrawal handler composition', () => {
  it('settles realized amounts from the post-execution readback', async () => {
    const { handlers, reads, execute, before, wallet, position } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(positionFixture({
        owner: wallet, position, baseRaw: '100000000', quoteRaw: '30000000',
      }));
    reads.getState
      .mockResolvedValueOnce(stateFixture())
      .mockResolvedValueOnce(stateFixture('10103000000', '500500000'));
    const request: WithdrawRequest = {
      method: 'withdraw', position_id: before.position_id, bps: 50,
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
    const { handlers, reads, before } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new UnknownPositionError('gone'));
    reads.getState
      .mockResolvedValueOnce(stateFixture())
      .mockResolvedValueOnce(stateFixture('10203000000', '530500000'));
    const request: WithdrawRequest = {
      method: 'withdraw', position_id: before.position_id, bps: 100,
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
    reads.getState
      .mockResolvedValueOnce(stateFixture())
      .mockResolvedValueOnce(stateFixture('10203000000', '530500000'));
    await handlers.withdraw({ method: 'withdraw', position_id: before.position_id, bps: 100 });
    const call = execute.mock.calls[0] as unknown as [unknown, { commitment: string }];
    expect(call[1]).toMatchObject({ commitment: 'finalized' });
  });

  it('returns the confirmed receipt as ambiguous when post-write reads fail', async () => {
    const { handlers, reads, before } = fixture();
    reads.getPosition
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new RpcReadError('lagging endpoint'));
    reads.getState
      .mockResolvedValueOnce(stateFixture())
      .mockResolvedValueOnce(stateFixture('10203000000', '530500000'));
    const result = await handlers.withdraw({
      method: 'withdraw', position_id: before.position_id, bps: 100,
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'submission_ambiguous',
      data: { pending_signature: 'confirmed-signature' },
      tx_signatures: ['confirmed-signature'],
      transactions: [{ signature: 'confirmed-signature' }],
    });
  });

  it('rejects a position read that is not owned by the signer before execution', async () => {
    const { handlers, reads, execute } = fixture();
    reads.getPosition.mockRejectedValueOnce(new UnknownPositionError('foreign'));
    const result = await handlers.withdraw({
      method: 'withdraw', position_id: Keypair.generate().publicKey.toBase58(), bps: 100,
    });
    expect(result.error).toBe('unknown_position');
    expect(execute).not.toHaveBeenCalled();
  });
});
