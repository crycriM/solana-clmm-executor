/** Low-level native Meteora one-sided deposit instruction and payload decoder. */

import BN from 'bn.js';
import {
  LBCLMM_PROGRAM_IDS,
  deriveEventAuthority,
  toWeightDistribution,
} from '@meteora-ag/dlmm';
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { Side } from './protocol.js';

const U64_MAX = (1n << 64n) - 1n;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const U16_MAX = 65_535;

export const ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR = createHash('sha256')
  .update('global:add_liquidity_one_side')
  .digest()
  .subarray(0, 8);

export class WeightedDepositInstructionError extends Error {}

export interface NativeBinWeight {
  binId: number;
  weight: number;
}

export interface AddLiquidityOneSideAccounts {
  position: PublicKey;
  lbPair: PublicKey;
  binArrayBitmapExtension?: PublicKey | null;
  userToken: PublicKey;
  reserve: PublicKey;
  tokenMint: PublicKey;
  binArrayLower: PublicKey;
  binArrayUpper: PublicKey;
  sender: PublicKey;
  tokenProgram: PublicKey;
}

export interface AddLiquidityOneSidePayload {
  amount: bigint;
  activeId: number;
  maxActiveBinSlippage: number;
  binLiquidityDist: NativeBinWeight[];
}

function assertI32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new WeightedDepositInstructionError(`${name} must fit i32`);
  }
}

/** Convert target token BPS into Meteora's price-aware u16 liquidity weights. */
export function deriveNativeBinWeights(
  side: Side,
  totalAmountRaw: bigint,
  targetBins: { binId: number; amountBps: number }[],
  binStep: number,
): NativeBinWeight[] {
  if (totalAmountRaw <= 0n || totalAmountRaw > U64_MAX) {
    throw new WeightedDepositInstructionError('total amount must fit positive u64');
  }
  if (!Number.isSafeInteger(binStep) || binStep <= 0 || binStep > U16_MAX) {
    throw new WeightedDepositInstructionError('bin step must fit positive u16');
  }
  const distributions = targetBins.map(({ binId, amountBps }) => {
    assertI32(binId, 'bin id');
    if (!Number.isSafeInteger(amountBps) || amountBps <= 0 || amountBps > 10_000) {
      throw new WeightedDepositInstructionError('target BPS must be in [1, 10000]');
    }
    return {
      binId,
      xAmountBpsOfTotal: new BN(side === 'ask' ? amountBps : 0),
      yAmountBpsOfTotal: new BN(side === 'bid' ? amountBps : 0),
    };
  });
  if (targetBins.reduce((sum, bin) => sum + bin.amountBps, 0) !== 10_000) {
    throw new WeightedDepositInstructionError('target BPS must sum to 10000');
  }
  const raw = new BN(totalAmountRaw.toString());
  const weights = toWeightDistribution(
    side === 'ask' ? raw : new BN(0),
    side === 'bid' ? raw : new BN(0),
    distributions,
    binStep,
  );
  if (weights.length !== targetBins.length ||
      weights.some((weight, index) => weight.binId !== targetBins[index]!.binId || weight.weight <= 0)) {
    throw new WeightedDepositInstructionError('native conversion dropped or reordered a requested bin');
  }
  return weights;
}

export function encodeAddLiquidityOneSidePayload(payload: AddLiquidityOneSidePayload): Buffer {
  if (payload.amount <= 0n || payload.amount > U64_MAX) {
    throw new WeightedDepositInstructionError('amount must fit positive u64');
  }
  assertI32(payload.activeId, 'active id');
  assertI32(payload.maxActiveBinSlippage, 'max active-bin slippage');
  if (payload.maxActiveBinSlippage < 0) {
    throw new WeightedDepositInstructionError('max active-bin slippage must be non-negative');
  }
  if (payload.binLiquidityDist.length === 0) {
    throw new WeightedDepositInstructionError('weight distribution must not be empty');
  }
  const data = Buffer.alloc(8 + 8 + 4 + 4 + 4 + payload.binLiquidityDist.length * 6);
  ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(payload.amount, 8);
  data.writeInt32LE(payload.activeId, 16);
  data.writeInt32LE(payload.maxActiveBinSlippage, 20);
  data.writeUInt32LE(payload.binLiquidityDist.length, 24);
  payload.binLiquidityDist.forEach(({ binId, weight }, index) => {
    assertI32(binId, 'bin id');
    if (!Number.isSafeInteger(weight) || weight <= 0 || weight > U16_MAX) {
      throw new WeightedDepositInstructionError('weight must fit positive u16');
    }
    const offset = 28 + index * 6;
    data.writeInt32LE(binId, offset);
    data.writeUInt16LE(weight, offset + 4);
  });
  return data;
}

export function decodeAddLiquidityOneSidePayload(data: Buffer): AddLiquidityOneSidePayload {
  if (data.length < 28 || !data.subarray(0, 8).equals(ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR)) {
    throw new WeightedDepositInstructionError('not an addLiquidityOneSide payload');
  }
  const count = data.readUInt32LE(24);
  if (data.length !== 28 + count * 6 || count === 0) {
    throw new WeightedDepositInstructionError('invalid weight vector length');
  }
  const binLiquidityDist = Array.from({ length: count }, (_, index) => {
    const offset = 28 + index * 6;
    return { binId: data.readInt32LE(offset), weight: data.readUInt16LE(offset + 4) };
  });
  if (binLiquidityDist.some(({ weight }) => weight === 0)) {
    throw new WeightedDepositInstructionError('weight must be positive');
  }
  return {
    amount: data.readBigUInt64LE(8),
    activeId: data.readInt32LE(16),
    maxActiveBinSlippage: data.readInt32LE(20),
    binLiquidityDist,
  };
}

export function buildAddLiquidityOneSideInstruction(
  accounts: AddLiquidityOneSideAccounts,
  payload: AddLiquidityOneSidePayload,
  programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']),
): TransactionInstruction {
  const [eventAuthority] = deriveEventAuthority(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.position, isSigner: false, isWritable: true },
      { pubkey: accounts.lbPair, isSigner: false, isWritable: true },
      { pubkey: accounts.binArrayBitmapExtension ?? programId, isSigner: false, isWritable: true },
      { pubkey: accounts.userToken, isSigner: false, isWritable: true },
      { pubkey: accounts.reserve, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenMint, isSigner: false, isWritable: false },
      { pubkey: accounts.binArrayLower, isSigner: false, isWritable: true },
      { pubkey: accounts.binArrayUpper, isSigner: false, isWritable: true },
      { pubkey: accounts.sender, isSigner: true, isWritable: false },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: encodeAddLiquidityOneSidePayload(payload),
  });
}
