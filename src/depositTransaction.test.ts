import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { decodeAddLiquidityOneSidePayload } from './dlmmWeighted.js';
import { buildWeightedDepositTransaction } from './depositTransaction.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import type { DepositSingleSidedRequest } from './protocol.js';
import { baseEnv } from './testing.js';

const poolKey = new PublicKey('11111111111111111111111111111111');
const baseMint = new PublicKey('So11111111111111111111111111111111111111112');
const quoteMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function request(overrides: Partial<DepositSingleSidedRequest> = {}): DepositSingleSidedRequest {
  return {
    method: 'deposit_single_sided', pool: poolKey.toBase58(), side: 'bid',
    bin_ids: [98, 99], amounts: [75, 75], expected_active_bin: 100,
    max_active_bin_slippage: 0, strategy_type: 'Spot', ...overrides,
  };
}

function inputs(overrides: Partial<DepositSingleSidedRequest> = {}) {
  const wallet = Keypair.generate().publicKey;
  return {
    wallet,
    connection: { getMultipleAccountsInfo: async () => [null, null, null] },
    request: request(overrides),
    state: { active_bin: 100, bin_step_bps: 20, balances: { base: 10, quote: 500 } },
    pool: {
      pool: poolKey, binStep: 20,
      tokenX: { mint: baseMint, reserve: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 9, transferHookAccountCount: 0 },
      tokenY: { mint: quoteMint, reserve: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6, transferHookAccountCount: 0 },
    },
  };
}

describe('weighted deposit transaction plan', () => {
  it('composes preparation plus one policy-bound native instruction', async () => {
    const plan = await buildWeightedDepositTransaction(inputs());
    expect(plan.transaction.instructions).toHaveLength(5);
    const payload = decodeAddLiquidityOneSidePayload(plan.transaction.instructions.at(-1)!.data);
    expect(payload).toMatchObject({
      amount: 150_000_000n, activeId: 100, maxActiveBinSlippage: 0,
    });
    expect(payload.binLiquidityDist).toEqual(plan.nativeWeights);
    expect(plan.policyInput.nativeDeposit?.position).toEqual(plan.addresses.position);
    expect(plan.policyInput.amounts.quoteAmount).toBe(150_000_000);
    expect(plan.policyInput.amounts.baseAmount).toBeUndefined();

    plan.transaction.feePayer = plan.addresses.wallet;
    plan.transaction.recentBlockhash = poolKey.toBase58();
    expect(plan.transaction.serializeMessage().length + 65).toBeLessThanOrEqual(1_232);
    const config = loadConfig(baseEnv({ WALLET_PUBKEY: plan.addresses.wallet.toBase58() }));
    expect(() => new TransactionPolicy(config, plan.addresses.wallet)
      .validate(plan.transaction, plan.policyInput)).not.toThrow();

    plan.transaction.add(SystemProgram.transfer({
      fromPubkey: plan.addresses.wallet,
      toPubkey: new PublicKey(plan.policyInput.nativeDeposit!.reserve),
      lamports: 1,
    }));
    try {
      new TransactionPolicy(config, plan.addresses.wallet).validate(plan.transaction, plan.policyInput);
      expect.unreachable('an extra transfer must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyRejected);
      expect((error as PolicyRejected).rule).toBe('native_deposit_binding');
    }
  });

  it('maps ask deposits to token X and price-adjusted weights', async () => {
    const plan = await buildWeightedDepositTransaction(inputs({
      side: 'ask', bin_ids: [100, 101], amounts: [1, 1],
    }));
    expect(plan.policyInput.mints).toEqual([baseMint]);
    expect(plan.policyInput.amounts.baseAmount).toBe(2_000_000_000);
    expect(plan.nativeWeights).toHaveLength(2);
  });

  it('fails closed for transfer-hook tokens', async () => {
    const args = inputs();
    args.pool.tokenY.transferHookAccountCount = 1;
    await expect(buildWeightedDepositTransaction(args)).rejects.toThrow('transfer hooks');
  });

  it('fails closed for reward-enabled pools until reward claims are bound', async () => {
    const args = inputs();
    await expect(buildWeightedDepositTransaction({
      ...args,
      pool: { ...args.pool, activeRewardCount: 1 },
    })).rejects.toThrow('reward-enabled');
  });
});
