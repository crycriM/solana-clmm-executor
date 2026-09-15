/** Policy-bound native Meteora withdrawal transaction construction. */

import BN from 'bn.js';
import {
  LBCLMM_PROGRAM_IDS,
  TOKEN_ACCOUNT_FEE,
  deriveBinArrayBitmapExtension,
  getBinArraysRequiredByPositionRange,
  isOverflowDefaultBinArrayBitmap,
} from '@meteora-ag/dlmm';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { PolicyInput } from './policy.js';
import type { PositionData, WithdrawRequest } from './protocol.js';
import type { WritablePoolMetadata } from './depositTransaction.js';
import {
  buildClaimFee2Instruction,
  buildClosePositionIfEmptyInstruction,
  buildRemoveLiquidityByRange2Instruction,
} from './dlmmWithdraw.js';
import { normalizeWithdrawal, type NormalizedWithdrawal } from './withdraw.js';

const DEFAULT_SIGNATURE_FEE_LAMPORTS = 5_000;

export class WithdrawBuildError extends Error {}

export interface WithdrawalTransactionPlan {
  transaction: Transaction;
  policyInput: PolicyInput;
  normalized: NormalizedWithdrawal;
  position: PublicKey;
  userTokenX: PublicKey;
  userTokenY: PublicKey;
  binArrays: PublicKey[];
  bitmapExtension: PublicKey | null;
}

function solToLamports(value: number): number {
  return Math.ceil(value * 1_000_000_000);
}

export function buildWithdrawalTransaction(args: {
  wallet: PublicKey;
  request: WithdrawRequest;
  position: PositionData;
  pool: WritablePoolMetadata;
}): WithdrawalTransactionPlan {
  const { wallet, request, position, pool } = args;
  if (position.position_id !== request.position_id || position.owner !== wallet.toBase58()) {
    throw new WithdrawBuildError('position identity or owner does not match the request');
  }
  if (position.pool !== pool.pool.toBase58()) {
    throw new WithdrawBuildError('position pool does not match loaded metadata');
  }
  if ((pool.activeRewardCount ?? 0) !== 0) {
    throw new WithdrawBuildError('withdrawal from reward-enabled pools is unsupported');
  }
  if ((pool.tokenX.transferHookAccountCount ?? 0) !== 0 ||
      (pool.tokenY.transferHookAccountCount ?? 0) !== 0) {
    throw new WithdrawBuildError('withdrawal with Token-2022 transfer hooks is unsupported');
  }
  const normalized = normalizeWithdrawal(request);
  const programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
  const positionKey = new PublicKey(position.position_id);
  const lower = new BN(position.min_bin_id);
  const upper = new BN(position.max_bin_id);
  const required = getBinArraysRequiredByPositionRange(pool.pool, lower, upper, programId);
  if (required.length === 0 || required.length > 2) {
    throw new WithdrawBuildError('position requires an unsupported bin-array span');
  }
  const binArrays = required.map(({ key }) => key);
  const overflow = required.some(({ index }) => isOverflowDefaultBinArrayBitmap(index));
  const bitmapExtension = overflow ? deriveBinArrayBitmapExtension(pool.pool, programId)[0] : null;
  const userTokenX = getAssociatedTokenAddressSync(
    pool.tokenX.mint, wallet, false, pool.tokenX.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userTokenY = getAssociatedTokenAddressSync(
    pool.tokenY.mint, wallet, false, pool.tokenY.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const instructionAccounts = {
    position: positionKey,
    pool: pool.pool,
    bitmapExtension,
    userTokenX,
    userTokenY,
    reserveX: pool.tokenX.reserve,
    reserveY: pool.tokenY.reserve,
    tokenXMint: pool.tokenX.mint,
    tokenYMint: pool.tokenY.mint,
    tokenXProgram: pool.tokenX.tokenProgram,
    tokenYProgram: pool.tokenY.tokenProgram,
    sender: wallet,
    binArrays,
  };
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet, userTokenX, wallet, pool.tokenX.mint,
      pool.tokenX.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet, userTokenY, wallet, pool.tokenY.mint,
      pool.tokenY.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    buildRemoveLiquidityByRange2Instruction(instructionAccounts, {
      fromBinId: position.min_bin_id,
      toBinId: position.max_bin_id,
      bpsToRemove: normalized.dlmmBps,
    }, programId),
    buildClaimFee2Instruction(instructionAccounts, {
      fromBinId: position.min_bin_id,
      toBinId: position.max_bin_id,
    }, programId),
  ];
  if (normalized.shouldClaimAndClose) {
    instructions.push(
      buildClosePositionIfEmptyInstruction(positionKey, wallet, programId),
    );
  }
  const transaction = new Transaction().add(...instructions);
  const policyInput: PolicyInput = {
    writableAccounts: [
      positionKey, userTokenX, userTokenY,
      pool.tokenX.reserve, pool.tokenY.reserve,
      ...binArrays,
      ...(bitmapExtension ? [bitmapExtension] : []),
    ],
    pools: [pool.pool],
    mints: [pool.tokenX.mint, pool.tokenY.mint],
    amounts: {
      solSpendLamports: solToLamports(TOKEN_ACCOUNT_FEE) * 2 + DEFAULT_SIGNATURE_FEE_LAMPORTS,
    },
    nativeWithdrawal: {
      position: positionKey,
      pool: pool.pool,
      wallet,
      userTokenX,
      userTokenY,
      reserveX: pool.tokenX.reserve,
      reserveY: pool.tokenY.reserve,
      tokenXMint: pool.tokenX.mint,
      tokenYMint: pool.tokenY.mint,
      tokenXProgram: pool.tokenX.tokenProgram,
      tokenYProgram: pool.tokenY.tokenProgram,
      bitmapExtension,
      binArrays,
      fromBinId: position.min_bin_id,
      toBinId: position.max_bin_id,
      bpsToRemove: normalized.dlmmBps,
      claimAndClose: normalized.shouldClaimAndClose,
    },
  };
  return {
    transaction,
    policyInput,
    normalized,
    position: positionKey,
    userTokenX,
    userTokenY,
    binArrays,
    bitmapExtension,
  };
}
