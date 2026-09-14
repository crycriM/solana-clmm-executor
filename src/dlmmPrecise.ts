/** Account derivation shared by the reviewed exact-per-bin DLMM builder. */

import BN from 'bn.js';
import { deriveBinArray, binIdToBinArrayIndex } from '@meteora-ag/dlmm';
import type { AccountMeta, PublicKey } from '@solana/web3.js';

export class PreciseBuilderError extends Error {}

/**
 * `addLiquidityOneSidePrecise2` takes every bin-array PDA covering the
 * requested range as writable remaining accounts. This duplicates the pinned
 * SDK's unexported helper exactly, rather than guessing a single array.
 */
export function binArrayMetasForRange(
  minBinId: number,
  maxBinId: number,
  pool: PublicKey,
  programId: PublicKey,
): AccountMeta[] {
  if (!Number.isSafeInteger(minBinId) || !Number.isSafeInteger(maxBinId) || minBinId > maxBinId) {
    throw new PreciseBuilderError('bin range must be ordered safe integers');
  }
  const lower = binIdToBinArrayIndex(new BN(minBinId)).toNumber();
  const upper = binIdToBinArrayIndex(new BN(maxBinId)).toNumber();
  const result: AccountMeta[] = [];
  for (let index = lower; index <= upper; index += 1) {
    const [pubkey] = deriveBinArray(pool, new BN(index), programId);
    result.push({ pubkey, isSigner: false, isWritable: true });
  }
  return result;
}
