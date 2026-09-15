/** Deterministic accounts and initialization instructions for a weighted deposit. */

import BN from 'bn.js';
import {
  BIN_ARRAY_BITMAP_FEE,
  BIN_ARRAY_FEE,
  LBCLMM_PROGRAM_IDS,
  POSITION_FEE,
  TOKEN_ACCOUNT_FEE,
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveBinArrayBitmapExtension,
  deriveEventAuthority,
  derivePosition,
  isOverflowDefaultBinArrayBitmap,
} from '@meteora-ag/dlmm';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  type AccountInfo,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { createHash } from 'node:crypto';

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export const INITIALIZE_POSITION_PDA_DISCRIMINATOR = discriminator('initialize_position_pda');
export const INITIALIZE_BIN_ARRAY_DISCRIMINATOR = discriminator('initialize_bin_array');
export const INITIALIZE_BITMAP_EXTENSION_DISCRIMINATOR = discriminator(
  'initialize_bin_array_bitmap_extension',
);

export class WeightedDepositAccountError extends Error {}

export interface WeightedDepositAddresses {
  programId: PublicKey;
  pool: PublicKey;
  wallet: PublicKey;
  position: PublicKey;
  positionLowerBinId: number;
  positionUpperBinId: number;
  positionWidth: number;
  lowerBinArray: PublicKey;
  upperBinArray: PublicKey;
  lowerBinArrayIndex: bigint;
  upperBinArrayIndex: bigint;
  bitmapExtension: PublicKey | null;
  userToken: PublicKey;
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  reserve: PublicKey;
}

export interface WeightedDepositPresence {
  position: boolean;
  lowerBinArray: boolean;
  upperBinArray: boolean;
  bitmapExtension: boolean;
}

export interface WeightedDepositPreparation {
  instructions: TransactionInstruction[];
  /** Conservative SDK rent constants, converted to lamports. */
  estimatedRentLamports: number;
}

export interface AccountPresenceConnection {
  getMultipleAccountsInfo(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
}

function i32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new WeightedDepositAccountError(`${name} must fit i32`);
  }
}

function solToLamports(value: number): number {
  return Math.ceil(value * 1_000_000_000);
}

/**
 * Use initializePositionPda with wallet as base, payer, and owner. This keeps
 * the transaction's signer set to exactly one key and makes retries derive the
 * same position address for the same pool/range.
 */
export function deriveWeightedDepositAddresses(args: {
  pool: PublicKey;
  wallet: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  reserve: PublicKey;
  programId?: PublicKey;
}): WeightedDepositAddresses {
  const programId = args.programId ?? new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
  i32(args.lowerBinId, 'lower bin id');
  i32(args.upperBinId, 'upper bin id');
  if (args.upperBinId < args.lowerBinId) {
    throw new WeightedDepositAccountError('upper bin id must not precede lower bin id');
  }
  const width = args.upperBinId - args.lowerBinId + 1;
  if (width > 70) throw new WeightedDepositAccountError('position width exceeds 70 bins');
  const lowerId = new BN(args.lowerBinId);
  const upperId = new BN(args.upperBinId);
  const widthBn = new BN(width);
  const lowerIndex = binIdToBinArrayIndex(lowerId);
  const upperIndex = BN.max(lowerIndex.add(new BN(1)), binIdToBinArrayIndex(upperId));
  const [position] = derivePosition(args.pool, args.wallet, lowerId, widthBn, programId);
  const [lowerBinArray] = deriveBinArray(args.pool, lowerIndex, programId);
  const [upperBinArray] = deriveBinArray(args.pool, upperIndex, programId);
  const overflow = isOverflowDefaultBinArrayBitmap(lowerIndex) ||
    isOverflowDefaultBinArrayBitmap(upperIndex);
  return {
    programId,
    pool: args.pool,
    wallet: args.wallet,
    position,
    positionLowerBinId: args.lowerBinId,
    positionUpperBinId: args.upperBinId,
    positionWidth: width,
    lowerBinArray,
    upperBinArray,
    lowerBinArrayIndex: BigInt(lowerIndex.toString()),
    upperBinArrayIndex: BigInt(upperIndex.toString()),
    bitmapExtension: overflow ? deriveBinArrayBitmapExtension(args.pool, programId)[0] : null,
    userToken: getAssociatedTokenAddressSync(
      args.tokenMint,
      args.wallet,
      false,
      args.tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    tokenMint: args.tokenMint,
    tokenProgram: args.tokenProgram,
    reserve: args.reserve,
  };
}

export function buildInitializePositionPdaInstruction(
  addresses: WeightedDepositAddresses,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  INITIALIZE_POSITION_PDA_DISCRIMINATOR.copy(data, 0);
  data.writeInt32LE(addresses.positionLowerBinId, 8);
  data.writeInt32LE(addresses.positionWidth, 12);
  const [eventAuthority] = deriveEventAuthority(addresses.programId);
  return new TransactionInstruction({
    programId: addresses.programId,
    keys: [
      { pubkey: addresses.wallet, isSigner: true, isWritable: true },
      { pubkey: addresses.wallet, isSigner: true, isWritable: false },
      { pubkey: addresses.position, isSigner: false, isWritable: true },
      { pubkey: addresses.pool, isSigner: false, isWritable: false },
      { pubkey: addresses.wallet, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: addresses.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeBinArrayInstruction(
  addresses: WeightedDepositAddresses,
  binArray: PublicKey,
  index: bigint,
): TransactionInstruction {
  if (index < -(1n << 63n) || index > (1n << 63n) - 1n) {
    throw new WeightedDepositAccountError('bin-array index must fit i64');
  }
  const data = Buffer.alloc(16);
  INITIALIZE_BIN_ARRAY_DISCRIMINATOR.copy(data, 0);
  data.writeBigInt64LE(index, 8);
  return new TransactionInstruction({
    programId: addresses.programId,
    keys: [
      { pubkey: addresses.pool, isSigner: false, isWritable: false },
      { pubkey: binArray, isSigner: false, isWritable: true },
      { pubkey: addresses.wallet, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeBitmapExtensionInstruction(
  addresses: WeightedDepositAddresses,
): TransactionInstruction {
  if (!addresses.bitmapExtension) {
    throw new WeightedDepositAccountError('position range does not use a bitmap extension');
  }
  return new TransactionInstruction({
    programId: addresses.programId,
    keys: [
      { pubkey: addresses.pool, isSigner: false, isWritable: false },
      { pubkey: addresses.bitmapExtension, isSigner: false, isWritable: true },
      { pubkey: addresses.wallet, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: INITIALIZE_BITMAP_EXTENSION_DISCRIMINATOR,
  });
}

/** Build only missing Meteora accounts; ATA creation is idempotent by design. */
export function buildWeightedDepositPreparation(
  addresses: WeightedDepositAddresses,
  present: WeightedDepositPresence,
): WeightedDepositPreparation {
  const instructions: TransactionInstruction[] = [];
  let estimatedRentLamports = 0;
  if (addresses.bitmapExtension && !present.bitmapExtension) {
    instructions.push(buildInitializeBitmapExtensionInstruction(addresses));
    estimatedRentLamports += solToLamports(BIN_ARRAY_BITMAP_FEE);
  }
  if (!present.lowerBinArray) {
    instructions.push(buildInitializeBinArrayInstruction(
      addresses,
      addresses.lowerBinArray,
      addresses.lowerBinArrayIndex,
    ));
    estimatedRentLamports += solToLamports(BIN_ARRAY_FEE);
  }
  if (!addresses.upperBinArray.equals(addresses.lowerBinArray) && !present.upperBinArray) {
    instructions.push(buildInitializeBinArrayInstruction(
      addresses,
      addresses.upperBinArray,
      addresses.upperBinArrayIndex,
    ));
    estimatedRentLamports += solToLamports(BIN_ARRAY_FEE);
  }
  if (!present.position) {
    instructions.push(buildInitializePositionPdaInstruction(addresses));
    estimatedRentLamports += solToLamports(POSITION_FEE);
  }
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(
    addresses.wallet,
    addresses.userToken,
    addresses.wallet,
    addresses.tokenMint,
    addresses.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
  // The idempotent instruction charges this only when the ATA is absent.
  estimatedRentLamports += solToLamports(TOKEN_ACCOUNT_FEE);
  return { instructions, estimatedRentLamports };
}

/** Resolve account presence once, rejecting occupied PDAs owned by another program. */
export async function prepareWeightedDepositAccounts(
  connection: AccountPresenceConnection,
  addresses: WeightedDepositAddresses,
): Promise<WeightedDepositPreparation> {
  const named = [
    ['position', addresses.position],
    ['lower bin array', addresses.lowerBinArray],
    ['upper bin array', addresses.upperBinArray],
    ...(addresses.bitmapExtension ? [['bitmap extension', addresses.bitmapExtension] as const] : []),
  ] as const;
  const accounts = await connection.getMultipleAccountsInfo(named.map(([, address]) => address));
  if (accounts.length !== named.length) {
    throw new WeightedDepositAccountError('RPC returned an incomplete account-presence result');
  }
  accounts.forEach((account, index) => {
    if (account && !account.owner.equals(addresses.programId)) {
      throw new WeightedDepositAccountError(`${named[index]![0]} is not owned by Meteora`);
    }
  });
  return buildWeightedDepositPreparation(addresses, {
    position: accounts[0] !== null,
    lowerBinArray: accounts[1] !== null,
    upperBinArray: accounts[2] !== null,
    bitmapExtension: addresses.bitmapExtension === null || accounts[3] !== null,
  });
}
