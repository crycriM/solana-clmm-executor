/** End-to-end construction of a policy-bound native weighted deposit transaction. */

import { PublicKey, Transaction } from '@solana/web3.js';
import { validateSingleSidedDeposit } from './deposit.js';
import {
  deriveWeightedDepositAddresses,
  prepareWeightedDepositAccounts,
  type AccountPresenceConnection,
  type WeightedDepositAddresses,
} from './dlmmAccounts.js';
import {
  buildAddLiquidityOneSideInstruction,
  deriveNativeBinWeights,
  type NativeBinWeight,
} from './dlmmWeighted.js';
import type { PolicyInput } from './policy.js';
import type { DepositSingleSidedRequest, StateData } from './protocol.js';
import { buildWeightedDepositProfile, type WeightedDepositProfile } from './weightedDeposit.js';

const DEFAULT_SIGNATURE_FEE_LAMPORTS = 5_000;

export class WeightedDepositBuildError extends Error {}

export interface WritablePoolToken {
  mint: PublicKey;
  reserve: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  /** Native one-side ABI cannot carry Token-2022 transfer-hook accounts. */
  transferHookAccountCount?: number;
}

export interface WritablePoolMetadata {
  pool: PublicKey;
  binStep: number;
  /** First write gate excludes pools whose rewards require extra claim accounts. */
  activeRewardCount?: number;
  tokenX: WritablePoolToken;
  tokenY: WritablePoolToken;
}

export interface WeightedDepositTransactionPlan {
  transaction: Transaction;
  policyInput: PolicyInput;
  addresses: WeightedDepositAddresses;
  profile: WeightedDepositProfile;
  nativeWeights: NativeBinWeight[];
}

/**
 * Build from a fresh StateData snapshot. The native program rechecks activeId
 * during execution; the off-chain snapshot only rejects already-stale work.
 */
export async function buildWeightedDepositTransaction(args: {
  connection: AccountPresenceConnection;
  wallet: PublicKey;
  request: DepositSingleSidedRequest;
  state: Pick<StateData, 'active_bin' | 'bin_step_bps' | 'balances'>;
  pool: WritablePoolMetadata;
}): Promise<WeightedDepositTransactionPlan> {
  const { connection, wallet, request, state, pool } = args;
  if (!pool.pool.equals(new PublicKey(request.pool))) {
    throw new WeightedDepositBuildError('request pool does not match loaded pool metadata');
  }
  if (pool.binStep !== state.bin_step_bps) {
    throw new WeightedDepositBuildError('pool bin step does not match state snapshot');
  }
  if ((pool.activeRewardCount ?? 0) !== 0) {
    throw new WeightedDepositBuildError('deposits into reward-enabled pools are unsupported');
  }
  validateSingleSidedDeposit(request, state);
  const token = request.side === 'bid' ? pool.tokenY : pool.tokenX;
  if ((token.transferHookAccountCount ?? 0) !== 0) {
    throw new WeightedDepositBuildError(
      'native one-sided deposits with Token-2022 transfer hooks are unsupported',
    );
  }
  const profile = buildWeightedDepositProfile(request, token.decimals);
  if (profile.totalAmountRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WeightedDepositBuildError('raw deposit exceeds the policy numeric ceiling');
  }
  const addresses = deriveWeightedDepositAddresses({
    pool: pool.pool,
    wallet,
    lowerBinId: request.bin_ids[0]!,
    upperBinId: request.bin_ids.at(-1)!,
    tokenMint: token.mint,
    tokenProgram: token.tokenProgram,
    reserve: token.reserve,
  });
  const preparation = await prepareWeightedDepositAccounts(connection, addresses);
  const nativeWeights = deriveNativeBinWeights(
    request.side,
    profile.totalAmountRaw,
    profile.bins,
    pool.binStep,
  );
  const deposit = buildAddLiquidityOneSideInstruction({
    position: addresses.position,
    lbPair: pool.pool,
    binArrayBitmapExtension: addresses.bitmapExtension,
    userToken: addresses.userToken,
    reserve: token.reserve,
    tokenMint: token.mint,
    binArrayLower: addresses.lowerBinArray,
    binArrayUpper: addresses.upperBinArray,
    sender: wallet,
    tokenProgram: token.tokenProgram,
  }, {
    amount: profile.totalAmountRaw,
    activeId: request.expected_active_bin,
    maxActiveBinSlippage: request.max_active_bin_slippage,
    binLiquidityDist: nativeWeights,
  }, addresses.programId);
  const transaction = new Transaction().add(...preparation.instructions, deposit);
  const writableAccounts = [
    addresses.position,
    addresses.userToken,
    token.reserve,
    addresses.lowerBinArray,
    addresses.upperBinArray,
    ...(addresses.bitmapExtension ? [addresses.bitmapExtension] : []),
  ];
  const rawAmount = Number(profile.totalAmountRaw);
  const policyInput: PolicyInput = {
    writableAccounts,
    pools: [pool.pool],
    mints: [token.mint],
    amounts: {
      ...(request.side === 'ask' ? { baseAmount: rawAmount } : { quoteAmount: rawAmount }),
      solSpendLamports: preparation.estimatedRentLamports + DEFAULT_SIGNATURE_FEE_LAMPORTS,
      maxActiveBinSlippage: request.max_active_bin_slippage,
    },
    nativeDeposit: {
      position: addresses.position,
      pool: pool.pool,
      userToken: addresses.userToken,
      reserve: token.reserve,
      tokenMint: token.mint,
      tokenProgram: token.tokenProgram,
      binArrayLower: addresses.lowerBinArray,
      binArrayUpper: addresses.upperBinArray,
      bitmapExtension: addresses.bitmapExtension,
      positionLowerBinId: addresses.positionLowerBinId,
      positionWidth: addresses.positionWidth,
      lowerBinArrayIndex: addresses.lowerBinArrayIndex,
      upperBinArrayIndex: addresses.upperBinArrayIndex,
      amountRaw: profile.totalAmountRaw,
      activeId: request.expected_active_bin,
      maxActiveBinSlippage: request.max_active_bin_slippage,
      weights: nativeWeights,
    },
  };
  return { transaction, policyInput, addresses, profile, nativeWeights };
}
