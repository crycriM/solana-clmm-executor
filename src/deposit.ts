/** Protocol-level deposit preflight, before any Meteora SDK transaction build. */

import DecimalDefault from 'decimal.js';
import type { DepositSingleSidedRequest, ErrorCode, StateData } from './protocol.js';

const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;

export class DepositValidationError extends Error {
  constructor(readonly code: Extract<ErrorCode, 'bad_request' | 'bins_cross_active' | 'insufficient_balance'>, detail: string) {
    super(detail);
  }
}

export interface ValidatedDeposit {
  /** Protocol invariant: bid consumes quote; ask consumes base. */
  debitedToken: 'base' | 'quote';
  totalAmount: InstanceType<typeof Decimal>;
}

/**
 * Enforce the protocol's expensive invariants in decimal units before SDK
 * conversion. Decimal avoids an IEEE-754 rounding acceptance at the balance
 * boundary; the builder later converts only this validated amount to raw units.
 */
export function validateSingleSidedDeposit(
  request: DepositSingleSidedRequest,
  state: Pick<StateData, 'active_bin' | 'balances'>,
): ValidatedDeposit {
  if (request.bin_ids.length === 0 || request.bin_ids.length !== request.amounts.length) {
    throw new DepositValidationError('bad_request', 'bin_ids and amounts must be non-empty and equal length');
  }
  let previous: number | undefined;
  let total = new Decimal(0);
  for (let index = 0; index < request.bin_ids.length; index += 1) {
    const bin = request.bin_ids[index]!;
    const amount = request.amounts[index]!;
    if (!Number.isSafeInteger(bin) || !Number.isFinite(amount) || amount <= 0) {
      throw new DepositValidationError('bad_request', 'bin_ids must be safe integers and amounts must be finite positive values');
    }
    if (previous !== undefined && bin !== previous + 1) {
      throw new DepositValidationError('bad_request', 'bin_ids must be contiguous and strictly increasing');
    }
    previous = bin;
    total = total.plus(new Decimal(amount));
  }
  const bid = request.side === 'bid';
  if ((bid && request.bin_ids.some((bin) => bin >= state.active_bin)) ||
      (!bid && request.bin_ids.some((bin) => bin < state.active_bin))) {
    throw new DepositValidationError('bins_cross_active', 'bid bins must be below active; ask bins must be at or above active');
  }
  const debitedToken = bid ? 'quote' : 'base';
  if (total.greaterThan(new Decimal(state.balances[debitedToken]))) {
    throw new DepositValidationError('insufficient_balance', `insufficient ${debitedToken} balance`);
  }
  return { debitedToken, totalAmount: total };
}
