/**
 * Pure mapping from decoded DLMM swap events to §6 stream rows.
 *
 * Kept separate from `swapStream.ts` (which owns the subscription, backfill,
 * and sink) so the field mapping can be tested without a connection: every
 * function here is a total function of its inputs.
 *
 * Two decisions that are not obvious from the schema and that downstream
 * accounting depends on:
 *
 * - `amount_in`/`amount_out` are scaled by the token *actually sold/bought*,
 *   derived from `swapForY`. Getting this backwards misprices every swap.
 * - `fee_bps` is derived from `fee / amountIn`, not from the event's `feeBps`
 *   u128. See `feeBpsPaid` below for why the event field is not used.
 */

import BN from 'bn.js';
import DecimalDefault from 'decimal.js';
import type { ConfirmedSignatureInfo, Logs } from '@solana/web3.js';
import { decodeTransactionEvents, type DecodedEvent, type DecodedSwapEvent } from './events.js';
import type { Direction, SwapStreamRow } from './protocol.js';

const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;

/** Token decimals for one pool, as the stream needs them. */
export interface PoolDecimals {
  base: number;
  quote: number;
}

/** u64 BN → decimal string pair. Never BN.toNumber(). */
function toAmount(raw: BN, decimals: number): { decimal: number; raw: string } {
  const rawString = raw.toString();
  if (decimals <= 0) return { decimal: Number(rawString), raw: rawString };
  const negative = rawString.startsWith('-');
  const digits = (negative ? rawString.slice(1) : rawString).padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const decimal = Number(`${digits.slice(0, cut)}.${digits.slice(cut)}`) * (negative ? -1 : 1);
  return { decimal, raw: rawString };
}

/**
 * Effective fee in basis points, derived from the swap's own numbers.
 *
 * `feeBps` in the event is a u128 whose scale is not documented in the shipped
 * IDL and could not be confirmed against a recorded mainnet event, so it is
 * **not** used: hard-coding a scale here would either report 2.5e-8 bps or
 * 2.5e9 bps for a 25 bps pool, and both silently corrupt the fee accrual that
 * `bin_fill` and `pnl_explain` are built on.
 *
 * Instead the rate comes from `fee / amountIn`, which is observable and
 * self-checking: it is the fee the swap actually paid, in the token that was
 * sold. When `amountIn` is zero (or the fee exceeds it — a dust swap) the field
 * is omitted rather than guessed; the observer then falls back to its own
 * configured default when `fee_bps` is unavailable.
 */
function feeBpsPaid(swap: DecodedSwapEvent): number | undefined {
  const amountIn = swap.amountIn;
  const fee = swap.fee;
  if (amountIn.isZero() || fee.isNeg() || fee.gt(amountIn)) return undefined;
  // Decimal division preserves fractional basis points without routing either
  // u64 through a JS number first.
  const bps = new Decimal(fee.toString()).mul(10_000).div(amountIn.toString()).toNumber();
  return Number.isFinite(bps) && bps >= 0 ? bps : undefined;
}

/** Turn one decoded swap into a stream row. Returns null if it must be dropped. */
export function swapToRow(
  swap: DecodedSwapEvent,
  ctx: { slot: number; signature: string; blockTime: number | null; ts: number },
  decimals: { base: number; quote: number } | null,
): SwapStreamRow | null {
  const prevActiveBin = swap.startBinId;
  const newActiveBin = swap.endBinId;
  if (!Number.isSafeInteger(prevActiveBin) || !Number.isSafeInteger(newActiveBin)) {
    return null;
  }
  // amountIn is denominated in the token being sold. `swapForY` means the taker
  // swapped *for* Y: it sold X (base) and received Y (quote), so in=base/out=quote
  // — the same convention as `dlmmSwap.ts` (`swapForY = in_mint === tokenX`) and
  // `handlers.ts`. It is also what the chain shows: a swapForY swap moves the
  // active bin down. Neither value may be guessed. The bridge warms metadata
  // before it starts the subscription; this guard protects injected and degraded
  // hosts too.
  if (ctx.blockTime === null || decimals === null) return null;
  const inDecimals = swap.swapForY ? decimals.base : decimals.quote;
  const outDecimals = swap.swapForY ? decimals.quote : decimals.base;
  const inAmount = toAmount(swap.amountIn, inDecimals);
  const outAmount = toAmount(swap.amountOut, outDecimals);
  const direction: Direction = newActiveBin > prevActiveBin ? 'up' : 'down';
  const feeBps = feeBpsPaid(swap);
  return {
    tx_signature: ctx.signature,
    slot: ctx.slot,
    // A row must never carry a null block_time. Callers resolve it before
    // emitting; the row is built only once it is known.
    block_time: ctx.blockTime,
    ts: ctx.ts,
    pool: swap.lbPair.toBase58(),
    direction,
    prev_active_bin: prevActiveBin,
    new_active_bin: newActiveBin,
    amount_in: inAmount.decimal,
    amount_out: outAmount.decimal,
    amount_in_raw: inAmount.raw,
    amount_out_raw: outAmount.raw,
    ...(feeBps === undefined ? {} : { fee_bps: feeBps }),
    // The shipped Swap event contains aggregate amounts only. `bins_crossed`
    // is intentionally absent until a real per-bin event is decoded.
  };
}

/**
 * Decode the DLMM events of one log notification into stream rows.
 *
 * Failed transactions (`err !== null`) are dropped: their swaps never landed,
 * and emitting them would fabricate fills the chain does not have.
 */
export function decodeLogs(
  notification: Pick<Logs, 'err' | 'logs' | 'signature'>,
  ctx: { slot: number; blockTime: number | null; ts: number },
  pools: readonly string[],
  decimals: (pool: string) => { base: number; quote: number } | null,
  eventInstructions: readonly string[] = [],
): SwapStreamRow[] {
  if (notification.err) return [];
  const events: DecodedEvent[] = decodeTransactionEvents(
    notification.logs,
    eventInstructions,
  );
  const rows: SwapStreamRow[] = [];
  for (const event of events) {
    if (event.name !== 'Swap') continue;
    const pool = event.lbPair.toBase58();
    if (!pools.includes(pool)) continue;
    const row = swapToRow(
      event,
      { slot: ctx.slot, signature: notification.signature, blockTime: ctx.blockTime, ts: ctx.ts },
      decimals(pool),
    );
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Newest-first signature list → oldest-first, for slot-ordered replay. */
export function orderForReplay(signatures: readonly ConfirmedSignatureInfo[]): ConfirmedSignatureInfo[] {
  return [...signatures].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
}
