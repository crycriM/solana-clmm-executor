import { describe, expect, it } from 'vitest';
import { encodePreciseSingleSideDeposit, PreciseDepositEncodingError } from './preciseDeposit.js';

describe('encodePreciseSingleSideDeposit', () => {
  it('preserves every decimal amount exactly in the compressed IDL representation', () => {
    const encoded = encodePreciseSingleSideDeposit({ bin_ids: [98, 99], amounts: [1.25, 2.5] }, 6);
    expect(encoded).toEqual({
      bins: [{ binId: 98, amount: 1 }, { binId: 99, amount: 2 }],
      decompressMultiplier: 1_250_000n,
      maxAmount: 3_750_000n,
    });
  });

  it('rejects a decimal that would silently round in raw token units', () => {
    expect(() => encodePreciseSingleSideDeposit({ bin_ids: [1], amounts: [0.0000001] }, 6))
      .toThrow(PreciseDepositEncodingError);
  });

  it('fails closed when no exact u32 compression exists', () => {
    // Co-prime amounts force multiplier 1, leaving the first amount above u32.
    expect(() => encodePreciseSingleSideDeposit({ bin_ids: [1, 2], amounts: [4_294_967_296, 1] }, 0))
      .toThrow(/transaction splitting/);
  });
});
