/**
 * Swap primitives: request validation, raw-unit conversion,
 * slippage bounds, and realized balance deltas from a confirmed receipt.
 *
 * Realized amounts come from the confirmed transaction's token balance
 * deltas — never from the modeled quote — because `pnl_explain` treats them
 * as the true rebalance cost.
 */

import DecimalDefault from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import type { ErrorCode, SwapData, SwapRequest, TxReceipt } from './protocol.js';
import type { TransactionMeta, TransactionTokenBalance } from './transactions.js';

const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;

/** Wrapped SOL mint: the one "token" whose wallet balance lives in lamports. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const U64_MAX = 18_446_744_073_709_551_615n;
const BPS_TOTAL = 10_000;

export class SwapValidationError extends Error {
  /** Attached when the failure happened after a transaction already confirmed. */
  settledReceipt?: TxReceipt;

  constructor(readonly code: ErrorCode, detail: string) {
    super(detail);
  }
}

/**
 * Protocol-level checks before any quote or transaction build. The symbolic
 * "base"/"quote" spellings and any mint outside MINT_ALLOWLIST are rejected
 * here as well as at the request parser: the executor must never guess which
 * of the wallet's tokens the caller meant.
 */
export function validateSwapRequest(
  request: SwapRequest,
  mintAllowlist: readonly string[],
): asserts request is SwapRequest & { pool: string } {
  // The Jupiter aggregator route is on stand-by: its router binding was never
  // verified against a real route, and the price edge does not justify signing
  // against an unverified instruction layout. Re-enable only with a captured
  // mainnet route fixture behind the policy binding.
  if (request.pool === null) {
    throw new SwapValidationError(
      'bad_request',
      'swap requires a pool: the aggregator route is on stand-by',
    );
  }
  validateSwapTerms(request, mintAllowlist);
}

/** Mint, amount, and slippage rules shared by `swap` and read-only `quote_swap`. */
export function validateSwapTerms(
  request: { in_mint: string; out_mint: string; amount: number; max_slippage_bps: number },
  mintAllowlist: readonly string[],
): void {
  for (const mint of [request.in_mint, request.out_mint]) {
    if (mint === 'base' || mint === 'quote') {
      throw new SwapValidationError('bad_request', 'symbolic base/quote mints are rejected');
    }
    if (!mintAllowlist.includes(mint)) {
      throw new SwapValidationError('bad_request', 'swap mints must be allow-listed');
    }
  }
  if (request.in_mint === request.out_mint) {
    throw new SwapValidationError('bad_request', 'swap mints must differ');
  }
  if (
    !Number.isFinite(request.amount) ||
    request.amount <= 0 ||
    !Number.isSafeInteger(request.max_slippage_bps) ||
    request.max_slippage_bps < 0 ||
    request.max_slippage_bps > BPS_TOTAL
  ) {
    throw new SwapValidationError('bad_request', 'swap amount and slippage must be valid');
  }
}

/** Decimal amount in mint units → raw u64, refusing silently-truncated dust. */
export function swapAmountToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new SwapValidationError('bad_request', 'swap amount must be positive');
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new SwapValidationError('bad_request', 'mint decimals are invalid');
  }
  const raw = new Decimal(amount.toString()).mul(new Decimal(10).pow(decimals));
  if (!raw.isInteger() || raw.lte(0)) {
    throw new SwapValidationError(
      'bad_request',
      'swap amount cannot be represented in raw input-mint units',
    );
  }
  const value = BigInt(raw.toFixed(0));
  if (value > U64_MAX) {
    throw new SwapValidationError('bad_request', 'swap amount exceeds u64');
  }
  return value;
}

/**
 * Enforce the cap against the quoted bound before submitting: the route's
 * baked-in minimum output must not be looser than max_slippage_bps off the
 * quoted output, or the executor would sign a partially-acceptable swap.
 * The SDK bakes minOut with integer rounding, so a bound that is exactly at
 * the cap can sit up to one raw output unit past it; that rounding is allowed,
 * anything looser is not.
 */
export function assertQuotedSlippage(
  outAmountRaw: bigint,
  minOutRaw: bigint,
  maxSlippageBps: number,
): void {
  if (minOutRaw <= 0n || minOutRaw > outAmountRaw) {
    throw new SwapValidationError('slippage_exceeded', 'quoted minimum output is not acceptable');
  }
  if ((outAmountRaw - minOutRaw) * BigInt(BPS_TOTAL)
    > outAmountRaw * BigInt(maxSlippageBps) + BigInt(BPS_TOTAL)) {
    throw new SwapValidationError(
      'slippage_exceeded',
      'quoted route exceeds the requested slippage cap',
    );
  }
}

function ownerTokenTotal(
  balances: TransactionTokenBalance[] | null | undefined,
  owner: string,
  mint: string,
): bigint {
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance.mint === mint && balance.owner === owner) {
      if (!/^\d+$/.test(balance.uiTokenAmount.amount)) {
        throw new SwapValidationError('internal_error', 'confirmed receipt has an invalid amount');
      }
      total += BigInt(balance.uiTokenAmount.amount);
    }
  }
  return total;
}

/** Net wallet-side gain for one mint across a confirmed receipt (post − pre). */
export function walletTokenGain(
  meta: TransactionMeta,
  wallet: PublicKey,
  mint: string,
): bigint {
  return ownerTokenTotal(meta.postTokenBalances, wallet.toBase58(), mint) -
    ownerTokenTotal(meta.preTokenBalances, wallet.toBase58(), mint);
}

export interface RealizedSwap {
  amountInRaw: bigint;
  amountOutRaw: bigint;
}

/**
 * Realized in/out from the confirmed receipt's balance deltas. SPL sides use
 * wallet-owned token accounts. A wrapped-SOL side is derived from the pool's
 * own wSOL reserve delta when `wsolReserveOwner` (the pool PDA) is supplied:
 * the SDK treats the wallet's wSOL account as transaction-local (it wraps in,
 * then closes the account and unwraps everything back to lamports), so
 * wallet-side lamport or token deltas cannot isolate the swap amount. Without
 * a reserve owner, the legacy lamports derivation applies.
 */
export function realizedSwapDeltas(args: {
  meta: TransactionMeta;
  wallet: PublicKey;
  inMint: string;
  outMint: string;
  /** Index of the wallet account within the receipt's balance arrays. */
  walletIndex: number;
  /** Pool PDA owning the wSOL reserve, when the route is a direct DLMM swap. */
  wsolReserveOwner?: string | null;
}): RealizedSwap {
  const { meta, wallet, inMint, outMint, walletIndex, wsolReserveOwner } = args;
  if (inMint === WSOL_MINT || outMint === WSOL_MINT) {
    const pre = meta.preBalances?.[walletIndex];
    const post = meta.postBalances?.[walletIndex];
    if (pre === undefined || post === undefined) {
      throw new SwapValidationError('internal_error', 'confirmed receipt lacks wallet balances');
    }
    const fee = BigInt(meta.fee);
    // Input WSOL: the wallet funded the wrap, so its lamports fell by in + fee.
    const lamportsIn = BigInt(pre) - BigInt(post) - fee;
    // Output WSOL: the unwrap credited the wallet after paying the fee.
    const lamportsOut = BigInt(post) - BigInt(pre) + fee;
    const splIn = ownerTokenTotal(meta.preTokenBalances, wallet.toBase58(), inMint) -
      ownerTokenTotal(meta.postTokenBalances, wallet.toBase58(), inMint);
    const splOut = ownerTokenTotal(meta.postTokenBalances, wallet.toBase58(), outMint) -
      ownerTokenTotal(meta.preTokenBalances, wallet.toBase58(), outMint);
    let wsolReserveDelta: bigint | null = null;
    const hasReserveEntry = [...meta.preTokenBalances ?? [], ...meta.postTokenBalances ?? []]
      .some((balance) => balance.mint === WSOL_MINT && balance.owner === wsolReserveOwner);
    if (wsolReserveOwner && hasReserveEntry) {
      wsolReserveDelta = ownerTokenTotal(meta.postTokenBalances, wsolReserveOwner, WSOL_MINT) -
        ownerTokenTotal(meta.preTokenBalances, wsolReserveOwner, WSOL_MINT);
    }
    return normalize({
      amountInRaw: inMint !== WSOL_MINT ? splIn
        : wsolReserveDelta !== null ? wsolReserveDelta : lamportsIn,
      amountOutRaw: outMint !== WSOL_MINT ? splOut
        : wsolReserveDelta !== null ? -wsolReserveDelta : lamportsOut,
    });
  }
  return normalize({
    amountInRaw: ownerTokenTotal(meta.preTokenBalances, wallet.toBase58(), inMint) -
      ownerTokenTotal(meta.postTokenBalances, wallet.toBase58(), inMint),
    amountOutRaw: ownerTokenTotal(meta.postTokenBalances, wallet.toBase58(), outMint) -
      ownerTokenTotal(meta.preTokenBalances, wallet.toBase58(), outMint),
  });
}

function normalize(swap: RealizedSwap): RealizedSwap {
  if (swap.amountInRaw < 0n || swap.amountOutRaw < 0n) {
    throw new SwapValidationError(
      'internal_error',
      'confirmed swap receipt reported a negative realized delta',
    );
  }
  return swap;
}

/** Post-confirmation guard: the landed swap must honor the pre-submission bound. */
export function assertRealizedBounds(
  realized: RealizedSwap,
  args: { amountInRaw: bigint; minOutRaw: bigint },
): void {
  if (realized.amountInRaw > args.amountInRaw) {
    throw new SwapValidationError(
      'slippage_exceeded',
      'realized input exceeded the exact-in amount',
    );
  }
  if (realized.amountOutRaw < args.minOutRaw) {
    throw new SwapValidationError(
      'slippage_exceeded',
      'realized output fell below the enforced minimum',
    );
  }
}

export function buildSwapData(
  realized: RealizedSwap,
  inDecimals: number,
  outDecimals: number,
  route: 'jupiter' | 'meteora',
): SwapData {
  const amountIn = new Decimal(realized.amountInRaw.toString()).div(new Decimal(10).pow(inDecimals));
  const amountOut = new Decimal(realized.amountOutRaw.toString())
    .div(new Decimal(10).pow(outDecimals));
  if (realized.amountInRaw === 0n) {
    throw new SwapValidationError('internal_error', 'realized swap consumed no input');
  }
  return {
    amount_in: amountIn.toNumber(),
    amount_out: amountOut.toNumber(),
    amount_in_raw: realized.amountInRaw.toString(),
    amount_out_raw: realized.amountOutRaw.toString(),
    price_realized: amountOut.div(amountIn).toNumber(),
    route,
  };
}
