import { describe, expect, it } from 'vitest';
import { DepositValidationError, validateSingleSidedDeposit } from './deposit.js';
import type { DepositSingleSidedRequest, StateData } from './protocol.js';

const state: Pick<StateData, 'active_bin' | 'balances'> = {
  active_bin: 100, balances: { base: 2, quote: 300 },
};

function request(overrides: Partial<DepositSingleSidedRequest> = {}): DepositSingleSidedRequest {
  return {
    method: 'deposit_single_sided', pool: 'pool', side: 'bid', bin_ids: [98, 99], amounts: [100, 200],
    expected_active_bin: 100, max_active_bin_slippage: 1, strategy_type: 'Spot',
    ...overrides,
  };
}

function rejected(req: DepositSingleSidedRequest, code: string) {
  try {
    validateSingleSidedDeposit(req, state);
    expect.unreachable('must reject');
  } catch (error) {
    expect(error).toBeInstanceOf(DepositValidationError);
    expect((error as DepositValidationError).code).toBe(code);
  }
}

describe('validateSingleSidedDeposit', () => {
  it('binds bid amounts to quote and ask amounts to base', () => {
    expect(validateSingleSidedDeposit(request(), state)).toMatchObject({ debitedToken: 'quote' });
    expect(validateSingleSidedDeposit(request({ side: 'ask', bin_ids: [100, 101], amounts: [1, 1] }), state))
      .toMatchObject({ debitedToken: 'base' });
  });

  it('rejects non-contiguous or malformed bin/amount arrays', () => {
    rejected(request({ bin_ids: [97, 99] }), 'bad_request');
    rejected(request({ amounts: [100] }), 'bad_request');
    rejected(request({ amounts: [100, 0] }), 'bad_request');
  });

  it('rejects a ladder that crosses the active bin instead of auto-correcting it', () => {
    rejected(request({ bin_ids: [99, 100] }), 'bins_cross_active');
    rejected(request({ side: 'ask', bin_ids: [99, 100] }), 'bins_cross_active');
  });

  it('accepts drift at the requested boundary and rejects one bin beyond it', () => {
    expect(validateSingleSidedDeposit(request({ expected_active_bin: 101 }), state))
      .toMatchObject({ debitedToken: 'quote' });
    rejected(request({ expected_active_bin: 98 }), 'bins_cross_active');
    rejected(request({ expected_active_bin: 102, max_active_bin_slippage: 1 }), 'active_bin_slippage_exceeded');
  });

  it('rejects a ladder that tolerated drift moved across the current active bin', () => {
    rejected(request({ side: 'ask', expected_active_bin: 99, bin_ids: [99, 100], amounts: [1, 1] }), 'bins_cross_active');
  });

  it('uses the side-correct balance for its insufficient-funds guard', () => {
    rejected(request({ amounts: [200, 101] }), 'insufficient_balance');
    rejected(request({ side: 'ask', bin_ids: [100, 101], amounts: [1.5, 0.6] }), 'insufficient_balance');
  });
});
