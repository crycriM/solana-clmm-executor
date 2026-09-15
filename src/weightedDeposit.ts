/** Native Meteora one-sided weight profile derived from keeper target amounts. */

import DecimalDefault from 'decimal.js';
import type { DepositSingleSidedRequest } from './protocol.js';

const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;
const BPS_TOTAL = 10_000;

export class WeightedDepositEncodingError extends Error {}

export interface WeightedBinTarget {
  binId: number;
  targetAmount: number;
  amountBps: number;
}

export interface WeightedDepositProfile {
  /** Maximum side-token debit represented by sum(request.amounts). */
  totalAmount: InstanceType<typeof Decimal>;
  totalAmountRaw: bigint;
  bins: WeightedBinTarget[];
}

/** Largest-remainder normalization; never silently drops a requested bin. */
export function normalizeTargetBps(amounts: number[]): number[] {
  if (amounts.length === 0 || amounts.length > BPS_TOTAL ||
      amounts.some((amount) => !Number.isFinite(amount) || amount <= 0)) {
    throw new WeightedDepositEncodingError('target amounts must be finite and positive');
  }
  const values = amounts.map((amount) => new Decimal(amount.toString()));
  const total = values.reduce((sum, value) => sum.plus(value), new Decimal(0));
  const scaled = values.map((value) => value.mul(BPS_TOTAL).div(total));
  const result = scaled.map((value) => value.floor().toNumber());
  let remainder = BPS_TOTAL - result.reduce((sum, value) => sum + value, 0);
  const order = scaled
    .map((value, index) => ({ index, fraction: value.minus(value.floor()) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) result[order[index]!.index] += 1;
  remainder = BPS_TOTAL - result.reduce((sum, value) => sum + value, 0);
  if (remainder !== 0 || result.some((value) => value <= 0)) {
    throw new WeightedDepositEncodingError('a requested bin is too small for a 10,000-bps profile');
  }
  return result;
}

export function buildWeightedDepositProfile(
  request: Pick<DepositSingleSidedRequest, 'bin_ids' | 'amounts'>,
  tokenDecimals: number,
): WeightedDepositProfile {
  if (request.bin_ids.length !== request.amounts.length) {
    throw new WeightedDepositEncodingError('bin_ids and amounts must have equal length');
  }
  if (!Number.isSafeInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    throw new WeightedDepositEncodingError('token decimals are invalid');
  }
  const amountBps = normalizeTargetBps(request.amounts);
  const totalAmount = request.amounts.reduce(
    (sum, amount) => sum.plus(new Decimal(amount.toString())),
    new Decimal(0),
  );
  const raw = totalAmount.mul(new Decimal(10).pow(tokenDecimals));
  if (!raw.isInteger() || raw.lte(0)) {
    throw new WeightedDepositEncodingError('total amount cannot be represented in token raw units');
  }
  return {
    totalAmount,
    totalAmountRaw: BigInt(raw.toFixed(0)),
    bins: request.bin_ids.map((binId, index) => ({
      binId,
      targetAmount: request.amounts[index]!,
      amountBps: amountBps[index]!,
    })),
  };
}
