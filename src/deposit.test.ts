import { describe, expect, it } from 'vitest';
import { DepositValidationError, validateSingleSidedDeposit } from './deposit.js';
import type { DepositSingleSidedRequest, StateData } from './protocol.js';

const state: Pick<StateData, 'active_bin' | 'balances'> = {
  active_bin: 100, balances: { base: 2, quote: 300 },
};

function request(overrides: Partial<DepositSingleSidedRequest> = {}): DepositSingleSidedRequest {
  return {
    method: 'deposit_single_sided', pool: 'pool', side: 'bid', bin_ids: [98, 99], amounts: [100, 200], strategy_type: 'Spot',
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

  it('uses the side-correct balance for its insufficient-funds guard', () => {
    rejected(request({ amounts: [200, 101] }), 'insufficient_balance');
    rejected(request({ side: 'ask', bin_ids: [100, 101], amounts: [1.5, 0.6] }), 'insufficient_balance');
  });
});
