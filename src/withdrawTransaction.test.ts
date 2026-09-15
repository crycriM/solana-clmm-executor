import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import type { PositionData, WithdrawRequest } from './protocol.js';
import { baseEnv, TEST_BASE_MINT, TEST_POOL, TEST_QUOTE_MINT } from './testing.js';
import { buildWithdrawalTransaction } from './withdrawTransaction.js';

const pool = new PublicKey(TEST_POOL);
const baseMint = new PublicKey(TEST_BASE_MINT);
const quoteMint = new PublicKey(TEST_QUOTE_MINT);

function fixture(bps = 100) {
  const wallet = Keypair.generate().publicKey;
  const positionKey = Keypair.generate().publicKey;
  const request: WithdrawRequest = {
    method: 'withdraw', position_id: positionKey.toBase58(), bps,
  };
  const position: PositionData = {
    position_id: positionKey.toBase58(), pool: pool.toBase58(), owner: wallet.toBase58(),
    active_bin: 100, min_bin_id: 98, max_bin_id: 99, bins: [],
    claimable_fee_x: 0, claimable_fee_y: 0,
    claimable_fee_x_raw: '0', claimable_fee_y_raw: '0',
    total_base: 1, total_quote: 150, slot: 42,
  };
  const metadata = {
    pool, binStep: 20,
    tokenX: { mint: baseMint, reserve: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 9 },
    tokenY: { mint: quoteMint, reserve: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 },
  };
  return { wallet, request, position, metadata };
}

describe('withdrawal transaction plan', () => {
  it('builds remove, fee claim, and close for a full exit and passes policy', () => {
    const input = fixture();
    const plan = buildWithdrawalTransaction({
      wallet: input.wallet, request: input.request, position: input.position, pool: input.metadata,
    });
    expect(plan.normalized).toMatchObject({ dlmmBps: 10_000, shouldClaimAndClose: true });
    expect(plan.transaction.instructions).toHaveLength(5);
    plan.transaction.feePayer = input.wallet;
    plan.transaction.recentBlockhash = pool.toBase58();
    expect(plan.transaction.serializeMessage().length + 65).toBeLessThanOrEqual(1_232);
    const config = loadConfig(baseEnv({ WALLET_PUBKEY: input.wallet.toBase58() }));
    expect(() => new TransactionPolicy(config, input.wallet)
      .validate(plan.transaction, plan.policyInput)).not.toThrow();
  });

  it('always claims fees but does not close on a partial exit', () => {
    const input = fixture(50);
    const plan = buildWithdrawalTransaction({
      wallet: input.wallet, request: input.request, position: input.position, pool: input.metadata,
    });
    expect(plan.normalized.dlmmBps).toBe(5_000);
    expect(plan.transaction.instructions).toHaveLength(4);
    expect(plan.policyInput.nativeWithdrawal?.claimAndClose).toBe(false);
  });

  it('rejects an unbound or augmented withdrawal transaction', () => {
    const input = fixture();
    const plan = buildWithdrawalTransaction({
      wallet: input.wallet, request: input.request, position: input.position, pool: input.metadata,
    });
    plan.transaction.feePayer = input.wallet;
    plan.transaction.recentBlockhash = pool.toBase58();
    const config = loadConfig(baseEnv({ WALLET_PUBKEY: input.wallet.toBase58() }));
    const validate = (policyInput: typeof plan.policyInput) =>
      new TransactionPolicy(config, input.wallet).validate(plan.transaction, policyInput);
    try {
      validate({ ...plan.policyInput, nativeWithdrawal: undefined });
      expect.unreachable('unbound withdrawal must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyRejected);
      expect((error as PolicyRejected).rule).toBe('native_withdrawal_binding');
    }
    plan.transaction.add(SystemProgram.transfer({
      fromPubkey: input.wallet, toPubkey: input.metadata.tokenX.reserve, lamports: 1,
    }));
    expect(() => validate(plan.policyInput)).toThrow(PolicyRejected);
  });

  it('fails closed for reward-enabled pools until reward claims are bound', () => {
    const input = fixture();
    expect(() => buildWithdrawalTransaction({
      wallet: input.wallet,
      request: input.request,
      position: input.position,
      pool: { ...input.metadata, activeRewardCount: 1 },
    })).toThrow('reward-enabled');
  });
});
