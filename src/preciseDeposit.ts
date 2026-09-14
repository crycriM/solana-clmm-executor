/** Exact raw-amount encoding for DLMM's addLiquidityOneSidePrecise2 IDL call. */

import DecimalDefault from 'decimal.js';
import type { DepositSingleSidedRequest } from './protocol.js';

const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;
const U32_MAX = 4_294_967_295n;

export class PreciseDepositEncodingError extends Error {}

export interface CompressedBinAmount {
  binId: number;
  /** Safe because it is constrained to the IDL u32 range. */
  amount: number;
}

export interface PreciseDepositEncoding {
  bins: CompressedBinAmount[];
  decompressMultiplier: bigint;
  maxAmount: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new PreciseDepositEncodingError('token decimals are invalid');
  }
  const raw = new Decimal(amount.toString()).mul(new Decimal(10).pow(decimals));
  if (!raw.isInteger() || raw.lte(0)) {
    throw new PreciseDepositEncodingError('amount cannot be represented exactly in token raw units');
  }
  return BigInt(raw.toFixed(0));
}

/**
 * Select the greatest common divisor as the decompression multiplier. It is
 * exact (every raw amount divides by it), and produces the smallest possible
 * u32 payload. If even that cannot fit, splitting the request is required;
 * rounding downward is never acceptable for the per-bin contract.
 */
export function encodePreciseSingleSideDeposit(
  request: Pick<DepositSingleSidedRequest, 'bin_ids' | 'amounts'>,
  tokenDecimals: number,
): PreciseDepositEncoding {
  if (request.bin_ids.length === 0 || request.bin_ids.length !== request.amounts.length) {
    throw new PreciseDepositEncodingError('bin_ids and amounts must be non-empty and equal length');
  }
  const rawAmounts = request.amounts.map((amount) => toRaw(amount, tokenDecimals));
  const multiplier = rawAmounts.reduce(gcd);
  const bins = request.bin_ids.map((binId, index) => {
    const compressed = rawAmounts[index]! / multiplier;
    if (compressed > U32_MAX) {
      throw new PreciseDepositEncodingError('precise deposit needs transaction splitting; compressed amount exceeds u32');
    }
    return { binId, amount: Number(compressed) };
  });
  return {
    bins,
    decompressMultiplier: multiplier,
    maxAmount: rawAmounts.reduce((sum, amount) => sum + amount, 0n),
  };
}
