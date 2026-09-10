/** Runtime validation at the untyped JSON boundary; no chain policy here. */
import type { ExecRequest, ExecHandlers, ExecResponse } from './protocol.js';

export class BadRequest extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): boolean {
  return number(value) && value > 0;
}
function bps(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000;
}
function bins(ids: unknown, amounts: unknown, empty = false): boolean {
  return (
    Array.isArray(ids) &&
    Array.isArray(amounts) &&
    ids.length === amounts.length &&
    (empty || ids.length > 0) &&
    ids.every(Number.isSafeInteger) &&
    amounts.every(positive)
  );
}
function swap(value: unknown, mints: readonly string[], optionalBps = false): boolean {
  return (
    object(value) &&
    text(value.in_mint) &&
    text(value.out_mint) &&
    value.in_mint !== value.out_mint &&
    mints.includes(value.in_mint) &&
    mints.includes(value.out_mint) &&
    positive(value.amount) &&
    ((optionalBps && value.max_slippage_bps === undefined) || bps(value.max_slippage_bps))
  );
}

export function parseRequest(value: unknown, mintAllowlist: readonly string[]): ExecRequest {
  if (!object(value)) throw new BadRequest('Request must be an object');
  let valid = false;
  switch (value.method) {
    case 'get_state':
      valid = text(value.pool);
      break;
    case 'get_position':
      valid = text(value.position_id);
      break;
    case 'deposit_single_sided':
      valid =
        text(value.pool) &&
        (value.side === 'bid' || value.side === 'ask') &&
        bins(value.bin_ids, value.amounts) &&
        ['Spot', 'Curve', 'BidAsk'].includes(String(value.strategy_type));
      break;
    case 'withdraw':
      valid = text(value.position_id) && Number.isSafeInteger(value.bps);
      break;
    case 'swap':
      valid = swap(value, mintAllowlist) && (value.pool === null || text(value.pool));
      break;
    case 'refresh_bundle': {
      const deposit = value.deposit_spec;
      valid =
        text(value.withdraw_position_id) &&
        (value.swap_spec === null || swap(value.swap_spec, mintAllowlist, true)) &&
        object(deposit) &&
        text(deposit.pool) &&
        bins(deposit.bid_bins, deposit.bid_amounts, true) &&
        bins(deposit.ask_bins, deposit.ask_amounts, true) &&
        (deposit.bid_bins as number[]).length + (deposit.ask_bins as number[]).length > 0;
      break;
    }
    default:
      throw new BadRequest('Unknown method');
  }
  // Never reflect untrusted field values (including unknown method names).
  if (!valid) throw new BadRequest('Invalid or missing request fields');
  return value as unknown as ExecRequest;
}

export function dispatch(handlers: ExecHandlers, request: ExecRequest): Promise<ExecResponse> {
  switch (request.method) {
    case 'get_state':
      return handlers.get_state(request);
    case 'get_position':
      return handlers.get_position(request);
    case 'deposit_single_sided':
      return handlers.deposit_single_sided(request);
    case 'withdraw':
      return handlers.withdraw(request);
    case 'swap':
      return handlers.swap(request);
    case 'refresh_bundle':
      return handlers.refresh_bundle(request);
  }
}
