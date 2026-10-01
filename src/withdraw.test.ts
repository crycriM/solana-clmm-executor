import { describe, expect, it } from 'vitest';
import { normalizeWithdrawal } from './withdraw.js';

describe('normalizeWithdrawal', () => {
  it.each([
    [1, { fraction: 0.01, dlmmBps: 100, shouldClaimAndClose: false }],
    [50, { fraction: 0.5, dlmmBps: 5_000, shouldClaimAndClose: false }],
    [100, { fraction: 1, dlmmBps: 10_000, shouldClaimAndClose: true }],
  ])('maps protocol percent=%i to DLMM basis points', (percent, expected) => {
    expect(normalizeWithdrawal({ percent })).toEqual(expected);
  });
});
