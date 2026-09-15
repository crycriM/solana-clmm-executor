/** Low-level Meteora withdrawal instructions for the no-transfer-hook M4 gate. */

import {
  LBCLMM_PROGRAM_IDS,
  MEMO_PROGRAM_ID,
  deriveEventAuthority,
} from '@meteora-ag/dlmm';
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export const REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR = discriminator(
  'remove_liquidity_by_range2',
);
export const CLAIM_FEE_2_DISCRIMINATOR = discriminator('claim_fee2');
export const CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR = discriminator('close_position_if_empty');

export class WithdrawInstructionError extends Error {}

export interface WithdrawTokenAccounts {
  userTokenX: PublicKey;
  userTokenY: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
}

export interface WithdrawInstructionAccounts extends WithdrawTokenAccounts {
  position: PublicKey;
  pool: PublicKey;
  bitmapExtension: PublicKey | null;
  sender: PublicKey;
  binArrays: PublicKey[];
}

export interface RemoveLiquidityByRangePayload {
  fromBinId: number;
  toBinId: number;
  bpsToRemove: number;
}

function assertI32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new WithdrawInstructionError(`${name} must fit i32`);
  }
}

function encodeRangeWithEmptyRemainingAccounts(
  discriminatorBytes: Buffer,
  fromBinId: number,
  toBinId: number,
  bps?: number,
): Buffer {
  assertI32(fromBinId, 'from bin id');
  assertI32(toBinId, 'to bin id');
  if (toBinId < fromBinId) throw new WithdrawInstructionError('bin range is inverted');
  if (bps !== undefined && (!Number.isSafeInteger(bps) || bps <= 0 || bps > 10_000)) {
    throw new WithdrawInstructionError('withdraw BPS must be in [1, 10000]');
  }
  const data = Buffer.alloc(bps === undefined ? 20 : 22);
  discriminatorBytes.copy(data, 0);
  data.writeInt32LE(fromBinId, 8);
  data.writeInt32LE(toBinId, 12);
  if (bps === undefined) {
    data.writeUInt32LE(0, 16); // RemainingAccountsInfo.slices
  } else {
    data.writeUInt16LE(bps, 16);
    data.writeUInt32LE(0, 18); // RemainingAccountsInfo.slices
  }
  return data;
}

export function decodeRemoveLiquidityByRangePayload(data: Buffer): RemoveLiquidityByRangePayload {
  if (data.length !== 22 ||
      !data.subarray(0, 8).equals(REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR) ||
      data.readUInt32LE(18) !== 0) {
    throw new WithdrawInstructionError('invalid removeLiquidityByRange2 payload');
  }
  return {
    fromBinId: data.readInt32LE(8),
    toBinId: data.readInt32LE(12),
    bpsToRemove: data.readUInt16LE(16),
  };
}

export function buildRemoveLiquidityByRange2Instruction(
  accounts: WithdrawInstructionAccounts,
  payload: RemoveLiquidityByRangePayload,
  programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']),
): TransactionInstruction {
  const [eventAuthority] = deriveEventAuthority(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.position, isSigner: false, isWritable: true },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.bitmapExtension ?? programId, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenX, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenY, isSigner: false, isWritable: true },
      { pubkey: accounts.reserveX, isSigner: false, isWritable: true },
      { pubkey: accounts.reserveY, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenXMint, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenYMint, isSigner: false, isWritable: false },
      { pubkey: accounts.sender, isSigner: true, isWritable: false },
      { pubkey: accounts.tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      ...accounts.binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeRangeWithEmptyRemainingAccounts(
      REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR,
      payload.fromBinId,
      payload.toBinId,
      payload.bpsToRemove,
    ),
  });
}

export function buildClaimFee2Instruction(
  accounts: WithdrawInstructionAccounts,
  range: Pick<RemoveLiquidityByRangePayload, 'fromBinId' | 'toBinId'>,
  programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']),
): TransactionInstruction {
  const [eventAuthority] = deriveEventAuthority(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.position, isSigner: false, isWritable: true },
      { pubkey: accounts.sender, isSigner: true, isWritable: false },
      { pubkey: accounts.reserveX, isSigner: false, isWritable: true },
      { pubkey: accounts.reserveY, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenX, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenY, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenXMint, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenYMint, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      ...accounts.binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeRangeWithEmptyRemainingAccounts(
      CLAIM_FEE_2_DISCRIMINATOR,
      range.fromBinId,
      range.toBinId,
    ),
  });
}

export function buildClosePositionIfEmptyInstruction(
  position: PublicKey,
  wallet: PublicKey,
  programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']),
): TransactionInstruction {
  const [eventAuthority] = deriveEventAuthority(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR,
  });
}
