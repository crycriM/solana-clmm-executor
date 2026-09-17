/**
 * Wire protocol for solana-clmm-executor.
 *
 * This module defines the JSON-lines contract consumed by the external keeper.
 * Field names are part of the compatibility boundary and must not be renamed
 * without updating both sides.
 *
 * Raw on-chain u64 amounts are `string`, never `number`: they exceed
 * Number.MAX_SAFE_INTEGER, so values must remain strings throughout the
 * protocol.
 */

export type RawAmount = string;
export type Side = 'bid' | 'ask';
export type StrategyType = 'Spot' | 'Curve' | 'BidAsk';
export type Direction = 'up' | 'down';

export type ErrorCode =
  | 'slippage_exceeded'
  | 'active_bin_slippage_exceeded'
  | 'insufficient_balance'
  | 'policy_rejected'
  | 'rpc_timeout'
  | 'bins_cross_active'
  | 'submission_ambiguous'
  | 'simulation_failed'
  | 'unknown_position'
  | 'bad_request'
  | 'internal_error';

// ---------------------------------------------------------------- requests

export interface GetStateRequest { method: 'get_state'; pool: string }
export interface GetPositionRequest { method: 'get_position'; position_id: string }

export interface DepositSingleSidedRequest {
  method: 'deposit_single_sided';
  pool: string;
  side: Side;
  bin_ids: number[];
  /**
   * Target allocation per bin. The executor normalizes these values to native
   * Meteora weights; sum(amounts) is the maximum token budget. Actual per-bin
   * deposits are approximate and authoritative only after get_position.
   * bid → QUOTE token, ask → BASE token.
   */
  amounts: number[];
  /** Active bin used by the keeper when constructing this absolute ladder. */
  expected_active_bin: number;
  /** Maximum permitted absolute active-bin drift, measured in bins (not bps). */
  max_active_bin_slippage: number;
  /** Audit metadata only; target amounts determine the native weight profile. */
  strategy_type: StrategyType;
}

export interface WithdrawRequest {
  method: 'withdraw';
  position_id: string;
  /** Hundredths of the position as the keeper uses it: 100 = full exit. */
  bps: number;
}

export interface SwapRequest {
  method: 'swap';
  in_mint: string;
  out_mint: string;
  /** Decimal, in in_mint units. */
  amount: number;
  max_slippage_bps: number;
  /** The DLMM pool to swap against. `null` (aggregator route) is on stand-by. */
  pool: string | null;
}

export interface SwapSpec {
  in_mint: string;
  out_mint: string;
  amount: number;
  max_slippage_bps?: number;
  /** Rebalance pool; defaults to the pool being redeposited into. */
  pool?: string;
}

export interface DepositSpec {
  pool: string;
  expected_active_bin: number;
  /** Maximum permitted absolute active-bin drift, measured in bins (not bps). */
  max_active_bin_slippage: number;
  bid_bins: number[];
  ask_bins: number[];
  /** quote-token target allocations; sum is the maximum quote budget */
  bid_amounts: number[];
  /** base-token target allocations; sum is the maximum base budget */
  ask_amounts: number[];
}

export interface RefreshBundleRequest {
  method: 'refresh_bundle';
  withdraw_position_id: string;
  swap_spec: SwapSpec | null;
  deposit_spec: DepositSpec;
}

/** Read-only price scouting across POOL_ALLOWLIST; never signs or submits. */
export interface QuoteSwapRequest {
  method: 'quote_swap';
  in_mint: string;
  out_mint: string;
  amount: number;
  max_slippage_bps: number;
}

export type ExecRequest =
  | GetStateRequest
  | GetPositionRequest
  | QuoteSwapRequest
  | DepositSingleSidedRequest
  | WithdrawRequest
  | SwapRequest
  | RefreshBundleRequest;

export type Verb = ExecRequest['method'];

// --------------------------------------------------------------- responses

/** One confirmed transaction. transactions[i] matches tx_signatures[i]. */
export interface TxReceipt {
  signature: string;
  slot: number;
  block_time: number | null;
  /** From the confirmed receipt (meta.fee), never an estimate. Replaces the
   *  keeper's REFRESH_GAS_LAMPORTS placeholder in `cash_flow`. */
  fee_lamports: number;
  compute_unit_price: number | null;
  status: 'confirmed' | 'finalized' | 'pending' | 'failed';
}

export interface ExecResponse<D = unknown> {
  ok: boolean;
  data: D | null;
  error: ErrorCode | null;
  tx_signatures: string[];
  transactions: TxReceipt[];
  position_id?: string | null;
}

export interface TokenMeta { mint: string; decimals: number; symbol?: string }

export interface StateData {
  active_bin: number;
  bin_step_bps: number;
  base_fee_bps: number;
  balances: { base: number; quote: number };
  balances_raw: { base: RawAmount; quote: RawAmount };
  /** null disables the keeper's rug kill-switch for that cycle. */
  tvl_usd: number | null;
  token_x: TokenMeta;
  token_y: TokenMeta;
  slot: number;
  fetched_at: number;
}

/** Mirrors lp-monitor's LiquidityProfileEntry, plus raw amounts. */
export interface PositionBin {
  bin_id: number;
  bin_price: number;
  amount_base: number;
  amount_quote: number;
  amount_base_raw: RawAmount;
  amount_quote_raw: RawAmount;
  liquidity_share?: number;
}

export interface PositionData {
  position_id: string;
  pool: string;
  owner: string;
  active_bin: number;
  min_bin_id: number;
  max_bin_id: number;
  bins: PositionBin[];
  /** Exact on-chain claimable fees. Deltas between observations are the
   *  accrual-basis LP fee income — estimates break the reconciliation. */
  claimable_fee_x: number;
  claimable_fee_y: number;
  claimable_fee_x_raw: RawAmount;
  claimable_fee_y_raw: RawAmount;
  total_base: number;
  total_quote: number;
  slot: number;
}

export interface TokenPair<T> { base: T; quote: T }

export interface WithdrawData {
  position_id: string;
  fraction: number;
  fees_claimed: { x: number; y: number; x_raw: RawAmount; y_raw: RawAmount };
  amounts_returned: TokenPair<number> & { base_raw: RawAmount; quote_raw: RawAmount };
  closed: boolean;
}

export interface SwapData {
  amount_in: number;
  amount_out: number;
  amount_in_raw: RawAmount;
  amount_out_raw: RawAmount;
  price_realized: number;
  route: string;
}

export interface PoolQuote {
  pool: string;
  amount_out: number;
  amount_out_raw: RawAmount;
  /** The bound `swap` would enforce for this pool at the same slippage cap. */
  min_out_raw: RawAmount;
  price: number;
}

/**
 * Quotes are ordered best-output first. A pool that cannot fill the exact-in
 * amount within bounds is reported in `rejected` rather than omitted silently.
 * Reward-enabled and transfer-hook pools quote here but still fail closed on
 * `swap`, which stays authoritative.
 */
export interface QuoteSwapData {
  quotes: PoolQuote[];
  rejected: { pool: string; error: ErrorCode }[];
  best_pool: string | null;
}

export interface DepositData {
  position_id: string;
  pool: string;
  side: Side;
  allocation_mode: 'weighted';
  /** Requested targets and their normalized weights, not realized balances. */
  bins: { bin_id: number; amount: number; target_bps: number }[];
  max_debit_amount: number;
  strategy_type: StrategyType;
}

export interface RefreshBundleData {
  /** New position after redeposit (the first opened leg; bid before ask). */
  position_id: string | null;
  /** Every position the refresh opened, in leg order. A two-sided redeposit
   * lands in two distinct PDAs; callers must track and withdraw all of them.
   * Absent when no deposit leg opened a position. */
  position_ids?: string[];
  /** How far we got — set on failure so the keeper reconciles from chain.
   *  Omitted when no mutation landed at all (the error alone is complete). */
  stage?: 'withdrew' | 'swapped' | 'deposited' | 'bundle_dropped';
  detail?: string;
  pending_signature?: string | null;
  fees_claimed?: WithdrawData['fees_claimed'];
  amounts_returned?: WithdrawData['amounts_returned'];
  swap?: SwapData;
  bundle_id?: string | null;
  /** Ordered signed component signatures, present once a bundle was forwarded. */
  component_signatures?: string[];
  /** Block-height expiry bound shared by every bundle component. */
  last_valid_block_height?: number | null;
}

// ------------------------------------------------------------ swap stream

/**
 * One decoded swap, appended as a JSON line to SWAP_STREAM_PATH and tailed by
 * `dlmm_bot.swap_observer.JsonlSwapEventSource`. Flush per line: a buffered
 * write that dies with the process loses fills.
 */
export interface SwapStreamRow {
  /** Dedupe and join key everywhere downstream. Never synthesized. */
  tx_signature: string;
  slot: number;
  block_time: number;
  ts: number;
  pool: string;
  /** Optional — the observer derives it from the bin delta. */
  direction?: Direction;
  /** Actual pre/post-swap bins from the decoded event, not a poll diff. */
  prev_active_bin: number;
  new_active_bin: number;
  amount_in?: number;
  amount_out?: number;
  amount_in_raw?: RawAmount;
  amount_out_raw?: RawAmount;
  trade_size_usd?: number;
  fee_bps?: number;
  tvl_usd?: number | null;
  bins_crossed?: {
    bin_id: number;
    bin_price?: number;
    amount_x?: RawAmount;
    amount_y?: RawAmount;
    fee?: RawAmount;
  }[];
}

// --------------------------------------------------------- handler surface

/** Transport-agnostic: bridge.ts is a thin stdio loop over this. */
export interface ExecHandlers {
  get_state(req: GetStateRequest): Promise<ExecResponse<StateData>>;
  get_position(req: GetPositionRequest): Promise<ExecResponse<PositionData>>;
  quote_swap(req: QuoteSwapRequest): Promise<ExecResponse<QuoteSwapData>>;
  deposit_single_sided(req: DepositSingleSidedRequest): Promise<ExecResponse<DepositData>>;
  withdraw(req: WithdrawRequest): Promise<ExecResponse<WithdrawData>>;
  swap(req: SwapRequest): Promise<ExecResponse<SwapData>>;
  refresh_bundle(req: RefreshBundleRequest): Promise<ExecResponse<RefreshBundleData>>;
}

export function errorResponse(error: ErrorCode, detail?: string): ExecResponse<{ detail?: string }> {
  return { ok: false, data: detail ? { detail } : null, error, tx_signatures: [], transactions: [] };
}
