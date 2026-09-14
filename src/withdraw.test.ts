import { describe, expect, it } from 'vitest';
import { normalizeWithdrawal } from './withdraw.js';

describe('normalizeWithdrawal', () => {
  it.each([
    [-10, { fraction: 0.01, dlmmBps: 100, shouldClaimAndClose: false }],
    [1, { fraction: 0.01, dlmmBps: 100, shouldClaimAndClose: false }],
    [50, { fraction: 0.5, dlmmBps: 5_000, shouldClaimAndClose: false }],
    [100, { fraction: 1, dlmmBps: 10_000, shouldClaimAndClose: true }],
    [999, { fraction: 1, dlmmBps: 10_000, shouldClaimAndClose: true }],
  ])('maps protocol bps=%i without changing the percent semantics', (bps, expected) => {
    expect(normalizeWithdrawal({ bps })).toEqual(expected);
  });
});
