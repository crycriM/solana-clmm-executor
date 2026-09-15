import { describe, expect, it } from 'vitest';
import {
  buildWeightedDepositProfile,
  normalizeTargetBps,
  WeightedDepositEncodingError,
} from './weightedDeposit.js';

describe('weighted deposit profile', () => {
  it('normalizes target amounts deterministically to exactly 10,000 bps', () => {
    expect(normalizeTargetBps([1, 2, 3])).toEqual([1667, 3333, 5000]);
    expect(normalizeTargetBps([75, 75])).toEqual([5000, 5000]);
  });

  it('preserves sum(amounts) as the exact maximum raw token budget', () => {
    const profile = buildWeightedDepositProfile(
      { bin_ids: [98, 99], amounts: [1.25, 2.5] },
      6,
    );
    expect(profile.totalAmount.toString()).toBe('3.75');
    expect(profile.totalAmountRaw).toBe(3_750_000n);
    expect(profile.bins).toEqual([
      { binId: 98, targetAmount: 1.25, amountBps: 3333 },
      { binId: 99, targetAmount: 2.5, amountBps: 6667 },
    ]);
  });

  it('fails rather than dropping a target that rounds to zero bps', () => {
    expect(() => normalizeTargetBps([1, 100_000]))
      .toThrow(WeightedDepositEncodingError);
  });

  it('rejects a total that token decimals cannot represent exactly', () => {
    expect(() => buildWeightedDepositProfile({ bin_ids: [1], amounts: [0.0000001] }, 6))
      .toThrow(WeightedDepositEncodingError);
  });
});
