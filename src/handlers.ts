/** M1 stubs plus the M2 read-only and M4/M5 write handler composition. */
import type {
  ExecHandlers,
  ExecResponse,
  StateData,
  PositionData,
  TxReceipt,
  WithdrawData,
  WithdrawRequest,
  RefreshBundleRequest,
  SwapData,
  SwapRequest,
  DepositData,
  DepositSingleSidedRequest,
  RefreshBundleData,
  ErrorCode,
  PoolQuote,
  QuoteSwapData,
} from './protocol.js';
import { errorResponse } from './protocol.js';
import {
  InvalidPoolError,
  RpcReadError,
  UnknownPositionError,
  type MintState,
  type SwapPoolReader,
} from './meteora.js';
import { normalizeTargetBps } from './weightedDeposit.js';
import { DepositValidationError } from './deposit.js';
import {
  WeightedDepositBuildError,
  buildWeightedDepositTransaction,
  type WritablePoolMetadata,
} from './depositTransaction.js';
import {
  WithdrawBuildError,
  buildWithdrawalTransaction,
} from './withdrawTransaction.js';
import { WeightedDepositAccountError, type AccountPresenceConnection } from './dlmmAccounts.js';
import { WeightedDepositInstructionError } from './dlmmWeighted.js';
import { WeightedDepositEncodingError } from './weightedDeposit.js';
import { PolicyRejected, type PolicyInput, type TransactionPolicy } from './policy.js';
import type { Signer } from './signer.js';
import type { ExecutorConfig } from './config.js';
import type { JitoClient } from './jito.js';
import {
  BundlePreForwardError,
  jitoTipInstruction,
  submitBundle,
  type BundleConnection,
  type BundleLeg,
  type BundleOutcome,
} from './bundle.js';
import {
  DlmmSwapBuildError,
  DlmmSwapInstructionError,
  buildDlmmSwapTransaction,
  quoteDlmmSwap,
} from './dlmmSwap.js';
import {
  SwapValidationError,
  validateSwapTerms,
  swapAmountToRaw,
  assertRealizedBounds,
  walletTokenGain,
  buildSwapData,
  realizedSwapDeltas,
  validateSwapRequest,
} from './swap.js';
import {
  executeLegacyTransaction,
  executeVersionedTransaction,
  SimulationFailed,
  SubmissionAmbiguous,
  type ExecutedTransaction,
  type ExecutionCommitment,
  type ExecutionConnection,
  type TransactionMeta,
} from './transactions.js';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export const STUB_POSITION = 'stub_position_001';
/** Ask legs land in a distinct PDA on chain; the dry-run stub mirrors that so
 * keepers exercising the DRY_RUN rehearsal path adopt and track both sides. */
export const STUB_ASK_POSITION = 'stub_position_002_ask';
export const STUB_WALLET = '11111111111111111111111111111111';
export const STUB_BASE_MINT = 'So11111111111111111111111111111111111111112';
export const STUB_QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SLOT = 301234567;
const BLOCK_TIME = 1756900001;

function receipt(verb: string, status: TxReceipt['status'] = 'confirmed'): TxReceipt {
  return {
    signature: `dryrun_stub_${verb}`,
    slot: SLOT,
    block_time: BLOCK_TIME,
    fee_lamports: 5000,
    compute_unit_price: 0,
    status,
  };
}

function ok<D extends object>(
  data: D,
  transactions: TxReceipt[] = [],
  positionId?: string,
): ExecResponse<D> {
  return {
    ok: true,
    data: { ...data, dry_run: true, stub: true },
    error: null,
    tx_signatures: transactions.map((tx) => tx.signature),
    transactions,
    ...(positionId === undefined ? {} : { position_id: positionId }),
  };
}

const returned: Pick<WithdrawData, 'fees_claimed' | 'amounts_returned'> = {
  fees_claimed: { x: 0.003, y: 1.84, x_raw: '3000000', y_raw: '1840000' },
  amounts_returned: { base: 1, quote: 150, base_raw: '1000000000', quote_raw: '150000000' },
};

/** New response objects on every call; no mutable process-wide test state. */
export function createStubHandlers(): ExecHandlers {
  return {
    async get_state() {
      return ok<StateData>({
        active_bin: 100,
        bin_step_bps: 20,
        base_fee_bps: 25,
        balances: { base: 0, quote: 0 },
        balances_raw: { base: '0', quote: '0' },
        tvl_usd: 50000,
        token_x: { mint: STUB_BASE_MINT, decimals: 9, symbol: 'SOL' },
        token_y: { mint: STUB_QUOTE_MINT, decimals: 6, symbol: 'USDC' },
        slot: SLOT,
        fetched_at: BLOCK_TIME,
      });
    },
    async get_position(req) {
      return ok<PositionData>({
        position_id: req.position_id,
        pool: STUB_WALLET,
        owner: STUB_WALLET,
        active_bin: 100,
        min_bin_id: 98,
        max_bin_id: 102,
        bins: [
          {
            bin_id: 98,
            bin_price: 149,
            amount_base: 0,
            amount_quote: 150,
            amount_base_raw: '0',
            amount_quote_raw: '150000000',
            liquidity_share: 0.01,
          },
          {
            bin_id: 102,
            bin_price: 151,
            amount_base: 1,
            amount_quote: 0,
            amount_base_raw: '1000000000',
            amount_quote_raw: '0',
            liquidity_share: 0.01,
          },
        ],
        claimable_fee_x: 0.003,
        claimable_fee_y: 1.84,
        claimable_fee_x_raw: '3000000',
        claimable_fee_y_raw: '1840000',
        total_base: 1,
        total_quote: 150,
        slot: SLOT,
      });
    },
    async deposit_single_sided(req) {
      const weights = normalizeTargetBps(req.amounts);
      const positionId = req.side === 'ask' ? STUB_ASK_POSITION : STUB_POSITION;
      return ok(
        {
          position_id: positionId,
          pool: req.pool,
          side: req.side,
          allocation_mode: 'weighted' as const,
          bins: req.bin_ids.map((bin_id, i) => ({
            bin_id, amount: req.amounts[i]!, target_bps: weights[i]!,
          })),
          max_debit_amount: req.amounts.reduce((sum, amount) => sum + amount, 0),
          strategy_type: req.strategy_type,
        },
        [receipt('deposit_single_sided')],
        positionId,
      );
    },
    async withdraw(req) {
      const fraction = Math.min(100, Math.max(1, req.bps)) / 100;
      return ok(
        {
          position_id: req.position_id,
          fraction,
          ...structuredClone(returned),
          closed: fraction === 1,
        },
        [receipt('withdraw', 'finalized')],
        req.position_id,
      );
    },
    async quote_swap() {
      return ok({ quotes: [], rejected: [], best_pool: null });
    },
    async swap() {
      return ok(
        {
          amount_in: 1,
          amount_out: 150,
          amount_in_raw: '1000000000',
          amount_out_raw: '150000000',
          price_realized: 150,
          route: 'meteora',
        },
        [receipt('swap')],
      );
    },
    async refresh_bundle(req) {
      const transactions = [receipt('withdraw', 'finalized')];
      if (req.swap_spec !== null) transactions.push(receipt('swap'));
      transactions.push(receipt('deposit_single_sided'));
      const positionIds = [
        STUB_POSITION,
        ...(req.deposit_spec.ask_bins.length > 0 ? [STUB_ASK_POSITION] : []),
      ];
      return ok(
        {
          position_id: STUB_POSITION,
          position_ids: positionIds,
          stage: 'deposited' as const,
          ...structuredClone(returned),
          ...(req.swap_spec === null
            ? {}
            : {
                swap: {
                  amount_in: 1,
                  amount_out: 150,
                  amount_in_raw: '1000000000',
                  amount_out_raw: '150000000',
                  price_realized: 150,
                  route: 'meteora',
                },
              }),
        },
        transactions,
        STUB_POSITION,
      );
    },
  };
}

function readOk<D>(data: D): ExecResponse<D> {
  return { ok: true, data, error: null, tx_signatures: [], transactions: [] };
}

function quoteErrorCode(error: unknown): ErrorCode {
  if (error instanceof SwapValidationError) return error.code;
  if (error instanceof InvalidPoolError) return 'bad_request';
  if (error instanceof RpcReadError) return 'rpc_timeout';
  return 'internal_error';
}

/** The read surface every handler set needs; `MeteoraReads` satisfies it. */
export interface ReadHandlersSource {
  getState(pool: string): Promise<StateData>;
  getPosition(positionId: string): Promise<PositionData>;
  /** SDK reader used by the read-only `quote_swap` scout. */
  getSwapPoolReader(pool: string): Promise<SwapPoolReader>;
}

/** M2: real read verbs with the still-gated M1 write stubs. */
export function createReadHandlers(
  reads: ReadHandlersSource,
  config: ExecutorConfig,
): ExecHandlers {
  const handlers = createStubHandlers();
  handlers.quote_swap = async (req) => {
    try {
      validateSwapTerms(req, config.mintAllowlist);
    } catch (error) {
      if (error instanceof SwapValidationError) {
        return errorResponse(error.code, error.message) as ExecResponse<QuoteSwapData>;
      }
      throw error;
    }
    const quotes: PoolQuote[] = [];
    const rejected: QuoteSwapData['rejected'] = [];
    for (const pool of config.poolAllowlist) {
      try {
        const reader = await reads.getSwapPoolReader(pool);
        const x = reader.tokenX.publicKey.toBase58();
        const y = reader.tokenY.publicKey.toBase58();
        const swapForY = req.in_mint === x && req.out_mint === y;
        if (!swapForY && !(req.in_mint === y && req.out_mint === x)) continue;
        const inDecimals = swapForY ? reader.tokenX.mint.decimals : reader.tokenY.mint.decimals;
        const outDecimals = swapForY ? reader.tokenY.mint.decimals : reader.tokenX.mint.decimals;
        const amountInRaw = swapAmountToRaw(req.amount, inDecimals);
        const { outAmountRaw, minOutRaw } = await quoteDlmmSwap({
          reader, swapForY, amountInRaw, maxSlippageBps: req.max_slippage_bps,
        });
        const amountOut = rawToNumber(outAmountRaw, outDecimals);
        quotes.push({
          pool,
          amount_out: amountOut,
          amount_out_raw: outAmountRaw.toString(),
          min_out_raw: minOutRaw.toString(),
          price: amountOut / req.amount,
        });
      } catch (error) {
        rejected.push({ pool, error: quoteErrorCode(error) });
      }
    }
    quotes.sort((a, b) =>
      BigInt(a.amount_out_raw) === BigInt(b.amount_out_raw)
        ? 0
        : BigInt(a.amount_out_raw) < BigInt(b.amount_out_raw) ? 1 : -1);
    return readOk({ quotes, rejected, best_pool: quotes[0]?.pool ?? null });
  };
  handlers.get_state = async (req) => {
    try {
      return readOk(await reads.getState(req.pool));
    } catch (error) {
      if (error instanceof InvalidPoolError) {
        return errorResponse('bad_request', 'Pool is not allow-listed') as ExecResponse<StateData>;
      }
      if (error instanceof RpcReadError) {
        return errorResponse('rpc_timeout', 'RPC read failed') as ExecResponse<StateData>;
      }
      throw error;
    }
  };
  handlers.get_position = async (req) => {
    try {
      return readOk(await reads.getPosition(req.position_id));
    } catch (error) {
      if (error instanceof UnknownPositionError) {
        return errorResponse(
          'unknown_position',
          'Position does not exist or is not owned by the wallet',
        ) as ExecResponse<PositionData>;
      }
      if (error instanceof RpcReadError) {
        return errorResponse('rpc_timeout', 'RPC read failed') as ExecResponse<PositionData>;
      }
      throw error;
    }
  };
  return handlers;
}

export interface DepositWriteReads {
  getState(pool: string): Promise<StateData>;
  getWritablePoolMetadata(pool: string): Promise<WritablePoolMetadata>;
}

/** M4/M5 writes derive every transaction from these reads; no client tx is accepted. */
export interface WriteReads extends ReadHandlersSource, DepositWriteReads {
  getPosition(positionId: string): Promise<PositionData>;
  /** Mint facts for `swap`/`refresh_bundle`, which address tokens by mint. */
  getMintState(mint: string): Promise<MintState>;
}

export interface WriteDependencies {
  connection: AccountPresenceConnection & ExecutionConnection;
  signer: Signer;
  policy: TransactionPolicy;
  commitment: ExecutionCommitment;
  config: ExecutorConfig;
  /** Required when `JITO_ENABLED=true`; unused by the sequential path. */
  jito?: JitoClient;
  execute?: (
    tx: Transaction,
    options: Parameters<typeof executeLegacyTransaction>[1],
  ) => Promise<ExecutedTransaction>;
  executeVersioned?: (
    tx: VersionedTransaction,
    options: Parameters<typeof executeVersionedTransaction>[1],
  ) => Promise<ExecutedTransaction>;
  /** Injectable for offline bundle verification; defaults to the real path. */
  bundleSubmit?: (legs: BundleLeg[], dependencies: BundleDependenciesLike) => Promise<BundleOutcome>;
}

export interface BundleDependenciesLike {
  connection: BundleConnection;
  signer: Signer;
  policy: TransactionPolicy;
  jito: JitoClient;
}

/** Per-attempt write metadata for the bridge audit line; no key material. */
export interface WriteAuditContext {
  policyDecision: 'allowed' | 'rejected' | null;
  policyRule: string | null;
  /** Every message this verb validated for signing, in order; legs included. */
  messageHashes: string[];
  blockhash: string | null;
  simulationOk: boolean | null;
  simulationLogs?: string[];
  signerId: string | null;
  /** Set once a Jito bundle attempt exists for this write; drives the verb line. */
  bundleId: string | null;
  bundleRecord: {
    bundle_id: string | null;
    component_signatures: string[];
    last_valid_block_height: number | null;
    statuses: string[];
    outcome: 'landed' | 'dropped' | 'ambiguous';
  } | null;
}

export interface M4Handlers extends ExecHandlers {
  /** The most recent write attempt; read verbs are not written here. */
  writeAudit(): WriteAuditContext;
}

function emptyWriteAudit(signerId: string): WriteAuditContext {
  return {
    policyDecision: null,
    policyRule: null,
    messageHashes: [],
    blockhash: null,
    simulationOk: null,
    signerId,
    bundleId: null,
    bundleRecord: null,
  };
}

function rawToNumber(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

interface PositionAfter {
  position: PositionData | null;
  /** Only an unreadable account means the close instruction took effect. */
  gone: boolean;
}

async function readPositionAfter(reads: WriteReads, positionId: string): Promise<PositionAfter> {
  try {
    return { position: await reads.getPosition(positionId), gone: false };
  } catch (error) {
    if (error instanceof UnknownPositionError) return { position: null, gone: true };
    throw error;
  }
}

/**
 * The wallet balance delta is the cash-basis withdrawal result. Fee claims are
 * separate response fields, so remove the freshly-read pre-transaction fee
 * entitlement from that delta to report principal returned by the withdrawal.
 */
function withdrawalReturned(args: {
  before: StateData;
  after: StateData;
  feesXRaw: string;
  feesYRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
}): WithdrawData['amounts_returned'] {
  const { before, after, feesXRaw, feesYRaw, baseDecimals, quoteDecimals } = args;
  const tokenDelta = (beforeRaw: string, afterRaw: string, feeRaw: string): bigint => {
    const gross = BigInt(afterRaw) - BigInt(beforeRaw);
    if (gross < 0n) {
      throw new Error('withdrawal readback reported a lower wallet token balance');
    }
    const principal = gross - BigInt(feeRaw);
    return principal > 0n ? principal : 0n;
  };
  const baseRaw = tokenDelta(
    before.balances_raw.base,
    after.balances_raw.base,
    feesXRaw,
  );
  const quoteRaw = tokenDelta(
    before.balances_raw.quote,
    after.balances_raw.quote,
    feesYRaw,
  );
  return {
    base: rawToNumber(baseRaw, baseDecimals),
    quote: rawToNumber(quoteRaw, quoteDecimals),
    base_raw: baseRaw.toString(),
    quote_raw: quoteRaw.toString(),
  };
}

/** Bundle-side twin of `withdrawalReturned`: deltas from the receipt meta. */
function bundleReturned(args: {
  meta: TransactionMeta;
  wallet: PublicKey;
  tokenXMint: string;
  tokenYMint: string;
  feesXRaw: string;
  feesYRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
}): WithdrawData['amounts_returned'] {
  const { meta, wallet, feesXRaw, feesYRaw, baseDecimals, quoteDecimals } = args;
  const principal = (mint: string, feeRaw: string): bigint => {
    const gain = walletTokenGain(meta, wallet, mint);
    if (gain < 0n) throw new Error('bundle withdrawal reported a negative wallet delta');
    const net = gain - BigInt(feeRaw);
    return net > 0n ? net : 0n;
  };
  const baseRaw = principal(args.tokenXMint, feesXRaw);
  const quoteRaw = principal(args.tokenYMint, feesYRaw);
  return {
    base: rawToNumber(baseRaw, baseDecimals),
    quote: rawToNumber(quoteRaw, quoteDecimals),
    base_raw: baseRaw.toString(),
    quote_raw: quoteRaw.toString(),
  };
}

function ambiguousBundleResult(
  outcome: BundleOutcome,
  detail: string,
  positionId: string,
): ExecResponse<RefreshBundleData> {
  const receipts = outcome.kind === 'landed' ? outcome.receipts.map((r) => r.receipt) : [];
  return {
    ok: false,
    error: 'submission_ambiguous',
    data: {
      detail,
      bundle_id: outcome.bundleId,
      pending_signature: outcome.signatures[0] ?? null,
      component_signatures: outcome.signatures,
      last_valid_block_height: outcome.lastValidBlockHeight,
      position_id: positionId,
    },
    tx_signatures: receipts.length > 0
      ? receipts.map((receipt) => receipt.signature)
      : outcome.signatures,
    transactions: receipts,
    position_id: positionId,
  };
}

/** A fully built, policy-bound swap transaction awaiting execution. */
interface SwapPlan {
  transaction: Transaction | VersionedTransaction;
  policyInput: PolicyInput;
  amountInRaw: bigint;
  minOutRaw: bigint;
  inMint: string;
  outMint: string;
  inDecimals: number;
  outDecimals: number;
  route: 'jupiter' | 'meteora';
  /** Pool PDA owning the wSOL reserve for direct DLMM swaps; null otherwise. */
  wsolReserveOwner: string | null;
}

/**
 * Settle a confirmed swap from its receipt's realized balance deltas and
 * enforce the transaction-local minimum output after the fact. A bound break
 * or unreadable delta attaches the confirmed receipt to the error so the verb
 * response can carry the signature.
 */
function settleSwapData(
  executed: ExecutedTransaction,
  plan: SwapPlan,
  wallet: PublicKey,
): SwapData {
  let data: SwapData;
  try {
    const realized = realizedSwapDeltas({
      meta: executed.meta,
      wallet,
      inMint: plan.inMint,
      outMint: plan.outMint,
      walletIndex: 0,
      wsolReserveOwner: plan.wsolReserveOwner,
    });
    assertRealizedBounds(realized, {
      amountInRaw: plan.amountInRaw,
      minOutRaw: plan.minOutRaw,
    });
    data = buildSwapData(realized, plan.inDecimals, plan.outDecimals, plan.route);
  } catch (error) {
    if (error instanceof SwapValidationError) {
      error.settledReceipt = executed.receipt;
      throw error;
    }
    throw new SubmissionAmbiguous(
      'confirmed swap could not be reconciled from its receipt',
      executed.receipt.signature,
      executed.receipt,
    );
  }
  return data;
}

function writeErrorResponse(error: unknown): ExecResponse<never> | null {
  if (error instanceof UnknownPositionError) {
    return errorResponse(
      'unknown_position',
      'Position does not exist or is not owned by the wallet',
    ) as ExecResponse<never>;
  }
  if (error instanceof DepositValidationError) {
    return errorResponse(error.code, error.message) as ExecResponse<never>;
  }
  if (error instanceof WithdrawBuildError) {
    return errorResponse('bad_request', error.message) as ExecResponse<never>;
  }
  if (error instanceof InvalidPoolError) {
    return errorResponse('bad_request', 'Pool is not allow-listed') as ExecResponse<never>;
  }
  if (error instanceof RpcReadError) {
    return errorResponse('rpc_timeout', 'RPC read failed') as ExecResponse<never>;
  }
  if (error instanceof PolicyRejected) {
    return {
      ...errorResponse('policy_rejected', error.message),
      data: { detail: error.message, rule: error.rule },
    } as unknown as ExecResponse<never>;
  }
  if (error instanceof SwapValidationError) {
    return errorResponse(error.code, error.message) as ExecResponse<never>;
  }
  if (error instanceof SimulationFailed) {
    return errorResponse('simulation_failed', error.message) as ExecResponse<never>;
  }
  if (error instanceof SubmissionAmbiguous) {
    return {
      ...errorResponse('submission_ambiguous', error.message),
      data: { detail: error.message, pending_signature: error.signature ?? null },
      tx_signatures: error.signature ? [error.signature] : [],
      transactions: error.receipt ? [error.receipt] : [],
    } as unknown as ExecResponse<never>;
  }
  if (error instanceof WeightedDepositBuildError ||
      error instanceof WeightedDepositAccountError ||
      error instanceof WeightedDepositInstructionError ||
      error instanceof WeightedDepositEncodingError ||
      error instanceof DlmmSwapBuildError ||
      error instanceof DlmmSwapInstructionError) {
    return errorResponse('bad_request', error.message) as ExecResponse<never>;
  }
  return null;
}

/**
 * Write composition (M4 + M5): policy-bound deposit, withdrawal, swap on both
 * direct Meteora `swap2` swaps (the aggregator route is on stand-by),
 * and `refresh_bundle` — sequential legs by default, one atomic Jito bundle
 * when `JITO_ENABLED=true`.
 */
export function createM4Handlers(reads: WriteReads, dependencies: WriteDependencies): M4Handlers {
  const handlers = createReadHandlers(reads, dependencies.config) as ExecHandlers & Partial<M4Handlers>;
  let lastWriteAudit = emptyWriteAudit(dependencies.signer.signerId);
  /** True while refresh_bundle drives legs: their hashes belong to its verb line. */
  let inSequence = false;
  const resetWriteAudit = (): WriteAuditContext => {
    if (inSequence) return lastWriteAudit;
    // Drop hashes a previous verb left behind when it threw past the bridge.
    dependencies.policy.takeValidatedMessageHashes();
    lastWriteAudit = emptyWriteAudit(dependencies.signer.signerId);
    return lastWriteAudit;
  };
  const executeWrite = (
    transaction: Transaction,
    policyInput: PolicyInput,
    commitment = dependencies.commitment,
  ) => {
    const execute = dependencies.execute ?? executeLegacyTransaction;
    return execute(transaction, {
      connection: dependencies.connection,
      signer: dependencies.signer,
      policy: dependencies.policy,
      policyInput,
      commitment,
    });
  };
  const executeWriteVersioned = (
    transaction: VersionedTransaction,
    policyInput: PolicyInput,
  ) => {
    const execute = dependencies.executeVersioned ?? executeVersionedTransaction;
    return execute(transaction, {
      connection: dependencies.connection,
      signer: dependencies.signer,
      policy: dependencies.policy,
      policyInput,
      commitment: dependencies.commitment,
    });
  };
  const recordOutcome = (audit: WriteAuditContext, error: unknown): ExecResponse<never> | null => {
    if (error instanceof PolicyRejected) {
      audit.policyDecision = 'rejected';
      audit.policyRule = error.rule;
      audit.blockhash = error.blockhash ?? null;
      audit.simulationOk = error.simulationOk ?? null;
    }
    if (error instanceof SimulationFailed) {
      audit.policyDecision = 'allowed';
      audit.blockhash = error.blockhash ?? null;
      audit.simulationOk = false;
      audit.simulationLogs = error.logs;
    }
    if (error instanceof SubmissionAmbiguous) {
      audit.policyDecision = error.policy ? 'allowed' : audit.policyDecision;
      audit.blockhash = error.blockhash ?? audit.blockhash;
      if (error.policy) audit.simulationOk = true;
    }
    return writeErrorResponse(error);
  };

  const runDeposit = async (
    req: DepositSingleSidedRequest,
  ): Promise<ExecResponse<DepositData>> => {
    const audit = resetWriteAudit();
    try {
      const [state, pool] = await Promise.all([
        reads.getState(req.pool),
        reads.getWritablePoolMetadata(req.pool),
      ]);
      const plan = await buildWeightedDepositTransaction({
        connection: dependencies.connection,
        wallet: dependencies.signer.publicKey,
        request: req,
        state,
        pool,
      });
      const executed = await executeWrite(plan.transaction, plan.policyInput);
      audit.policyDecision = 'allowed';
      audit.blockhash = executed.blockhash;
      audit.simulationOk = true;
      return {
        ok: true,
        data: {
          position_id: plan.addresses.position.toBase58(),
          pool: req.pool,
          side: req.side,
          allocation_mode: 'weighted',
          bins: plan.profile.bins.map((bin) => ({
            bin_id: bin.binId,
            amount: bin.targetAmount,
            target_bps: bin.amountBps,
          })),
          max_debit_amount: plan.profile.totalAmount.toNumber(),
          strategy_type: req.strategy_type,
        },
        error: null,
        tx_signatures: [executed.receipt.signature],
        transactions: [executed.receipt],
        position_id: plan.addresses.position.toBase58(),
      };
    } catch (error) {
      const mapped = recordOutcome(audit, error);
      if (mapped) return mapped;
      throw error;
    }
  };

  const runWithdraw = async (req: WithdrawRequest): Promise<ExecResponse<WithdrawData>> => {
    const audit = resetWriteAudit();
    try {
      const before = await reads.getPosition(req.position_id);
      const [pool, walletBefore] = await Promise.all([
        reads.getWritablePoolMetadata(before.pool),
        reads.getState(before.pool),
      ]);
      const plan = buildWithdrawalTransaction({
        wallet: dependencies.signer.publicKey,
        request: req,
        position: before,
        pool,
      });
      const executed = await executeWrite(
        plan.transaction,
        plan.policyInput,
        plan.normalized.shouldClaimAndClose ? 'finalized' : dependencies.commitment,
      );
      audit.policyDecision = 'allowed';
      audit.blockhash = executed.blockhash;
      audit.simulationOk = true;
      let walletAfter: StateData;
      let after: PositionAfter;
      try {
        [walletAfter, after] = await Promise.all([
          reads.getState(before.pool),
          readPositionAfter(reads, req.position_id),
        ]);
        if (walletAfter.slot < walletBefore.slot ||
            after.gone !== plan.normalized.shouldClaimAndClose) {
          throw new Error('withdrawal readback has not reached the confirmed closure state');
        }
      } catch {
        throw new SubmissionAmbiguous(
          'confirmed withdrawal could not be reconciled from chain state',
          executed.receipt.signature,
          executed.receipt,
        );
      }
      let amountsReturned: WithdrawData['amounts_returned'];
      try {
        amountsReturned = withdrawalReturned({
          before: walletBefore,
          after: walletAfter,
          feesXRaw: before.claimable_fee_x_raw,
          feesYRaw: before.claimable_fee_y_raw,
          baseDecimals: pool.tokenX.decimals,
          quoteDecimals: pool.tokenY.decimals,
        });
      } catch {
        throw new SubmissionAmbiguous(
          'confirmed withdrawal wallet balance delta could not be reconciled',
          executed.receipt.signature,
          executed.receipt,
        );
      }
      return {
        ok: true,
        data: {
          position_id: req.position_id,
          fraction: plan.normalized.fraction,
          fees_claimed: {
            x: before.claimable_fee_x,
            y: before.claimable_fee_y,
            x_raw: before.claimable_fee_x_raw,
            y_raw: before.claimable_fee_y_raw,
          },
          amounts_returned: amountsReturned,
          closed: after.gone,
        },
        error: null,
        tx_signatures: [executed.receipt.signature],
        transactions: [executed.receipt],
        position_id: req.position_id,
      };
    } catch (error) {
      const mapped = recordOutcome(audit, error);
      if (mapped) return mapped;
      throw error;
    }
  };

  /**
   * Validate and build one direct-pool swap transaction from fresh chain state.
   * Shared by the standalone verb and every bundle leg.
   */
  const buildSwapPlan = async (req: SwapRequest): Promise<SwapPlan> => {
    const wallet = dependencies.signer.publicKey;
    validateSwapRequest(req, dependencies.config.mintAllowlist);
    const [inMint, outMint] = await Promise.all([
      reads.getMintState(req.in_mint),
      reads.getMintState(req.out_mint),
    ]);
    const [pool, reader] = await Promise.all([
      reads.getWritablePoolMetadata(req.pool),
      reads.getSwapPoolReader(req.pool),
    ]);
    const plan = await buildDlmmSwapTransaction({
      reader,
      wallet,
      request: req,
      pool,
      inMint: { decimals: inMint.decimals, tokenProgram: inMint.tokenProgram },
      outMint: { decimals: outMint.decimals, tokenProgram: outMint.tokenProgram },
      walletInBalanceRaw: inMint.walletBalanceRaw,
    });
    return {
      transaction: plan.transaction,
      policyInput: plan.policyInput,
      amountInRaw: plan.amountInRaw,
      minOutRaw: plan.minOutRaw,
      inMint: req.in_mint,
      outMint: req.out_mint,
      inDecimals: inMint.decimals,
      outDecimals: outMint.decimals,
      route: 'meteora',
      wsolReserveOwner: req.pool,
    };
  };

  const executeSwapTransaction = (
    transaction: Transaction | VersionedTransaction,
    policyInput: PolicyInput,
  ): Promise<ExecutedTransaction> =>
    transaction instanceof VersionedTransaction
      ? executeWriteVersioned(transaction, policyInput)
      : executeWrite(transaction, policyInput);

  const runSwap = async (req: SwapRequest): Promise<ExecResponse<SwapData>> => {
    const audit = resetWriteAudit();
    try {
      const plan = await buildSwapPlan(req);
      const executed = await executeSwapTransaction(plan.transaction, plan.policyInput);
      audit.policyDecision = 'allowed';
      audit.blockhash = executed.blockhash;
      audit.simulationOk = true;
      const data = settleSwapData(executed, plan, dependencies.signer.publicKey);
      return {
        ok: true,
        data,
        error: null,
        tx_signatures: [executed.receipt.signature],
        transactions: [executed.receipt],
      };
    } catch (error) {
      if (error instanceof SwapValidationError && error.settledReceipt) {
        const receipt = error.settledReceipt;
        return {
          ...errorResponse(error.code, error.message),
          tx_signatures: [receipt.signature],
          transactions: [receipt],
        } as ExecResponse<SwapData>;
      }
      const mapped = recordOutcome(audit, error);
      if (mapped) return mapped;
      throw error;
    }
  };

  handlers.deposit_single_sided = runDeposit;
  handlers.withdraw = runWithdraw;
  handlers.swap = runSwap;

  /**
   * Projected wallet balances for bundle deposit legs. At build time the
   * funds still sit in the closing position and the swap has not run, so the
   * budget preflight projects position totals, claimed fees, and the swap
   * quote's bounds onto the balances. These are modeled numbers guarding a
   * modeled preflight; the on-chain per-leg bounds remain the authority.
   */
  const projectedDepositState = (
    state: StateData,
    position: PositionData,
    swapPlan: SwapPlan | null,
    pool: WritablePoolMetadata,
  ): StateData => {
    let base = state.balances.base + position.total_base + position.claimable_fee_x;
    let quote = state.balances.quote + position.total_quote + position.claimable_fee_y;
    if (swapPlan !== null) {
      const inIsBase = swapPlan.inMint === pool.tokenX.mint.toBase58();
      const amountIn = Number(swapPlan.amountInRaw) / 10 ** swapPlan.inDecimals;
      const minOut = Number(swapPlan.minOutRaw) / 10 ** swapPlan.outDecimals;
      if (inIsBase) {
        base -= amountIn;
        quote += minOut;
      } else {
        quote -= amountIn;
        base += minOut;
      }
    }
    return { ...state, balances: { base, quote } };
  };

  const buildDepositPlan = async (leg: DepositSingleSidedRequest, state: StateData) => {
    const pool = await reads.getWritablePoolMetadata(leg.pool);
    return buildWeightedDepositTransaction({
      connection: dependencies.connection,
      wallet: dependencies.signer.publicKey,
      request: leg,
      state,
      pool,
    });
  };

  const refreshViaBundle = async (
    req: RefreshBundleRequest,
  ): Promise<ExecResponse<RefreshBundleData>> => {
    const audit = lastWriteAudit;
    if (!dependencies.jito) throw new Error('JITO_ENABLED=true without a Jito client');
    const tipAccount = dependencies.config.jitoTipAccount!;
    const tipLamports = dependencies.config.jitoTipLamports;
    const before = await reads.getPosition(req.withdraw_position_id);
    const [pool, state] = await Promise.all([
      reads.getWritablePoolMetadata(before.pool),
      reads.getState(before.pool),
    ]);
    const withdrawPlan = buildWithdrawalTransaction({
      wallet: dependencies.signer.publicKey,
      request: { method: 'withdraw', position_id: req.withdraw_position_id, bps: 100 },
      position: before,
      pool,
    });
    const legs: BundleLeg[] = [{
      label: 'withdraw',
      transaction: withdrawPlan.transaction,
      policyInput: withdrawPlan.policyInput,
      commitment: 'finalized',
    }];

    let swapPlan: SwapPlan | null = null;
    if (req.swap_spec !== null) {
      swapPlan = await buildSwapPlan({
        method: 'swap',
        in_mint: req.swap_spec.in_mint,
        out_mint: req.swap_spec.out_mint,
        amount: req.swap_spec.amount,
        max_slippage_bps: req.swap_spec.max_slippage_bps ?? dependencies.config.maxSlippageBps,
        pool: req.swap_spec.pool ?? req.deposit_spec.pool,
      });
      legs.push({
        label: 'swap',
        transaction: swapPlan.transaction,
        policyInput: swapPlan.policyInput,
        commitment: dependencies.commitment,
        // Funded by the withdrawn position, not by the pre-bundle wallet.
        simulate: false,
      });
    }

    const spec = req.deposit_spec;
    const projected = projectedDepositState(state, before, swapPlan, pool);
    const depositLegs: { label: 'deposit_bid' | 'deposit_ask'; request: DepositSingleSidedRequest }[] = [];
    if (spec.bid_bins.length > 0) {
      depositLegs.push({
        label: 'deposit_bid',
        request: {
          method: 'deposit_single_sided', pool: spec.pool, side: 'bid',
          bin_ids: spec.bid_bins, amounts: spec.bid_amounts,
          expected_active_bin: spec.expected_active_bin,
          max_active_bin_slippage: spec.max_active_bin_slippage,
          strategy_type: 'Spot',
        },
      });
    }
    if (spec.ask_bins.length > 0) {
      depositLegs.push({
        label: 'deposit_ask',
        request: {
          method: 'deposit_single_sided', pool: spec.pool, side: 'ask',
          bin_ids: spec.ask_bins, amounts: spec.ask_amounts,
          expected_active_bin: spec.expected_active_bin,
          max_active_bin_slippage: spec.max_active_bin_slippage,
          strategy_type: 'Spot',
        },
      });
    }
    if (depositLegs.length === 0) {
      throw new BundlePreForwardError('a refresh bundle needs at least one deposit leg');
    }
    const depositPlans = [];
    for (const [index, leg] of depositLegs.entries()) {
      const plan = await buildDepositPlan(leg.request, projected);
      const policyInput: PolicyInput = { ...plan.policyInput };
      if (index === depositLegs.length - 1) {
        plan.transaction.add(jitoTipInstruction(
          dependencies.signer.publicKey, new PublicKey(tipAccount), tipLamports,
        ));
        policyInput.jitoTip = { account: tipAccount, lamports: tipLamports };
        policyInput.amounts = {
          ...policyInput.amounts,
          solSpendLamports: (policyInput.amounts.solSpendLamports ?? 0) + tipLamports,
        };
      }
      depositPlans.push({ leg, plan, policyInput });
      legs.push({
        label: leg.label,
        transaction: plan.transaction,
        policyInput,
        commitment: dependencies.commitment,
        // Funded by the withdrawn position (and possibly the swap leg).
        simulate: false,
      });
    }

    const submit = dependencies.bundleSubmit ?? submitBundle;
    let outcome: BundleOutcome;
    try {
      outcome = await submit(legs, {
        connection: dependencies.connection as unknown as BundleConnection,
        signer: dependencies.signer,
        policy: dependencies.policy,
        jito: dependencies.jito,
      });
    } catch (error) {
      // Definitively pre-forward: nothing was submitted, so no state changed.
      audit.bundleRecord = null;
      const cause = error instanceof BundlePreForwardError
        ? (error.innerCause ?? error) : error;
      const mapped = recordOutcome(audit, cause);
      const base = mapped ?? errorResponse('internal_error',
        `bundle admission failed: ${cause instanceof Error
          ? cause.message.slice(0, 200) : 'unknown error'}`);
      return {
        ...base,
        data: {
          ...(base.data ?? {}),
          stage: 'bundle_dropped',
          position_id: req.withdraw_position_id,
        },
        position_id: req.withdraw_position_id,
      } as ExecResponse<RefreshBundleData>;
    }

    audit.bundleId = outcome.bundleId;
    audit.bundleRecord = {
      bundle_id: outcome.bundleId,
      component_signatures: outcome.signatures,
      last_valid_block_height: outcome.lastValidBlockHeight,
      statuses: outcome.statuses,
      outcome: outcome.kind,
    };

    if (outcome.kind !== 'landed') {
      if (outcome.kind === 'dropped') {
        return {
          ok: false,
          error: 'internal_error',
          data: {
            stage: 'bundle_dropped',
            detail: outcome.reason,
            bundle_id: outcome.bundleId,
            component_signatures: outcome.signatures,
            last_valid_block_height: outcome.lastValidBlockHeight,
            position_id: req.withdraw_position_id,
          },
          tx_signatures: [],
          transactions: [],
          position_id: req.withdraw_position_id,
        };
      }
      return {
        ok: false,
        error: 'submission_ambiguous',
        data: {
          detail: outcome.reason,
          bundle_id: outcome.bundleId,
          pending_signature: outcome.signatures[0] ?? null,
          component_signatures: outcome.signatures,
          last_valid_block_height: outcome.lastValidBlockHeight,
          position_id: req.withdraw_position_id,
        },
        tx_signatures: outcome.signatures,
        transactions: [],
        position_id: req.withdraw_position_id,
      };
    }

    const wallet = dependencies.signer.publicKey;
    const byLabel = new Map(outcome.receipts.map((entry) => [entry.label, entry]));
    const withdrawEntry = byLabel.get('withdraw')!;
    let amountsReturned: WithdrawData['amounts_returned'];
    try {
      amountsReturned = bundleReturned({
        meta: withdrawEntry.meta,
        wallet,
        tokenXMint: pool.tokenX.mint.toBase58(),
        tokenYMint: pool.tokenY.mint.toBase58(),
        feesXRaw: before.claimable_fee_x_raw,
        feesYRaw: before.claimable_fee_y_raw,
        baseDecimals: pool.tokenX.decimals,
        quoteDecimals: pool.tokenY.decimals,
      });
    } catch {
      return ambiguousBundleResult(outcome, 'landed bundle withdrawal could not be reconciled',
        req.withdraw_position_id);
    }
    let swapData: SwapData | undefined;
    if (swapPlan !== null) {
      const swapEntry = byLabel.get('swap')!;
      try {
        swapData = settleSwapData(
          {
            receipt: swapEntry.receipt,
            policy: { messageHash: '', solSpendLamports: 0 },
            blockhash: outcome.blockhash,
            meta: swapEntry.meta,
          },
          swapPlan,
          wallet,
        );
      } catch (error) {
        if (error instanceof SwapValidationError) {
          return ambiguousBundleResult(outcome, error.message, req.withdraw_position_id);
        }
        throw error;
      }
    }
    const bidPlan = depositPlans.find((entry) => entry.leg.label === 'deposit_bid');
    const askPlan = depositPlans.find((entry) => entry.leg.label === 'deposit_ask');
    const openedIds = [bidPlan, askPlan]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .map((entry) => entry.plan.addresses.position.toBase58());
    const positionId = openedIds[0] ?? null;
    return {
      ok: true,
      data: {
        position_id: positionId,
        ...(openedIds.length > 0 ? { position_ids: openedIds } : {}),
        stage: 'deposited',
        fees_claimed: {
          x: before.claimable_fee_x,
          y: before.claimable_fee_y,
          x_raw: before.claimable_fee_x_raw,
          y_raw: before.claimable_fee_y_raw,
        },
        amounts_returned: amountsReturned,
        ...(swapData === undefined ? {} : { swap: swapData }),
        bundle_id: outcome.bundleId,
        component_signatures: outcome.signatures,
        last_valid_block_height: outcome.lastValidBlockHeight,
      },
      error: null,
      tx_signatures: outcome.receipts.map((entry) => entry.receipt.signature),
      transactions: outcome.receipts.map((entry) => entry.receipt),
      position_id: positionId,
    };
  };

  const refreshSequential = async (
    req: RefreshBundleRequest,
  ): Promise<ExecResponse<RefreshBundleData>> => {
    const receipts: TxReceipt[] = [];
    const signatures: string[] = [];
    const collect = (
      leg: { tx_signatures: string[]; transactions: TxReceipt[] },
    ): void => {
      receipts.push(...leg.transactions);
      signatures.push(...leg.tx_signatures);
    };
    const legDetail = (leg: ExecResponse<unknown>): string => {
      const detail = (leg.data as { detail?: string } | null)?.detail;
      return detail ?? leg.error ?? 'bundle leg failed';
    };

    const withdrawn = await runWithdraw({
      method: 'withdraw',
      position_id: req.withdraw_position_id,
      bps: 100,
    });
    if (!withdrawn.ok || withdrawn.data === null) {
      return {
        ok: false,
        error: withdrawn.error ?? 'internal_error',
        data: {
          ...((withdrawn.data as object | null) ?? {}),
          position_id: req.withdraw_position_id,
        } as unknown as RefreshBundleData,
        tx_signatures: withdrawn.tx_signatures,
        transactions: withdrawn.transactions,
        position_id: req.withdraw_position_id,
      };
    }
    collect(withdrawn);
    const { fees_claimed: feesClaimed, amounts_returned: amountsReturned } = withdrawn.data;

    let swapData: SwapData | undefined;
    if (req.swap_spec !== null) {
      const swapped = await runSwap({
        method: 'swap',
        in_mint: req.swap_spec.in_mint,
        out_mint: req.swap_spec.out_mint,
        amount: req.swap_spec.amount,
        max_slippage_bps:
          req.swap_spec.max_slippage_bps ?? dependencies.config.maxSlippageBps,
        pool: req.swap_spec.pool ?? req.deposit_spec.pool,
      });
      if (!swapped.ok || swapped.data === null) {
        return {
          ok: false,
          error: swapped.error ?? 'internal_error',
          data: {
            stage: 'withdrew',
            detail: legDetail(swapped),
            fees_claimed: feesClaimed,
            amounts_returned: amountsReturned,
            position_id: req.withdraw_position_id,
          },
          tx_signatures: [...signatures, ...swapped.tx_signatures],
          transactions: [...receipts, ...swapped.transactions],
          position_id: req.withdraw_position_id,
        };
      }
      swapData = swapped.data;
      collect(swapped);
    }

    const spec = req.deposit_spec;
    const legs: DepositSingleSidedRequest[] = [];
    if (spec.bid_bins.length > 0) {
      legs.push({
        method: 'deposit_single_sided', pool: spec.pool, side: 'bid',
        bin_ids: spec.bid_bins, amounts: spec.bid_amounts,
        expected_active_bin: spec.expected_active_bin,
        max_active_bin_slippage: spec.max_active_bin_slippage,
        strategy_type: 'Spot',
      });
    }
    if (spec.ask_bins.length > 0) {
      legs.push({
        method: 'deposit_single_sided', pool: spec.pool, side: 'ask',
        bin_ids: spec.ask_bins, amounts: spec.ask_amounts,
        expected_active_bin: spec.expected_active_bin,
        max_active_bin_slippage: spec.max_active_bin_slippage,
        strategy_type: 'Spot',
      });
    }
    let positionId: string | null = null;
    const openedIds: string[] = [];
    for (const leg of legs) {
      const deposited = await runDeposit(leg);
      if (!deposited.ok || deposited.data === null) {
        const stage: RefreshBundleData['stage'] = positionId !== null
          ? 'deposited'
          : swapData !== undefined ? 'swapped' : 'withdrew';
        return {
          ok: false,
          error: deposited.error ?? 'internal_error',
          data: {
            stage,
            detail: legDetail(deposited),
            fees_claimed: feesClaimed,
            amounts_returned: amountsReturned,
            ...(swapData === undefined ? {} : { swap: swapData }),
            ...(openedIds.length > 0 ? { position_ids: openedIds } : {}),
            position_id: positionId ?? req.withdraw_position_id,
          },
          tx_signatures: [...signatures, ...deposited.tx_signatures],
          transactions: [...receipts, ...deposited.transactions],
          position_id: positionId ?? req.withdraw_position_id,
        };
      }
      collect(deposited);
      const legId = deposited.data.position_id ?? deposited.position_id;
      if (legId !== null && legId !== undefined && !openedIds.includes(legId)) {
        openedIds.push(legId);
      }
      positionId ??= legId ?? null;
    }
    return {
      ok: true,
      data: {
        position_id: positionId,
        ...(openedIds.length > 0 ? { position_ids: openedIds } : {}),
        stage: 'deposited',
        fees_claimed: feesClaimed,
        amounts_returned: amountsReturned,
        ...(swapData === undefined ? {} : { swap: swapData }),
      },
      error: null,
      tx_signatures: signatures,
      transactions: receipts,
      position_id: positionId,
    };
  };
  handlers.refresh_bundle = async (req) => {
    resetWriteAudit();
    inSequence = true;
    try {
      if (!dependencies.config.jitoEnabled) return await refreshSequential(req);
      try {
        return await refreshViaBundle(req);
      } catch (error) {
        const mapped = recordOutcome(lastWriteAudit, error);
        if (mapped) return mapped as ExecResponse<RefreshBundleData>;
        throw error;
      }
    } finally {
      inSequence = false;
    }
  };
  handlers.writeAudit = () => ({
    ...lastWriteAudit,
    messageHashes: dependencies.policy.takeValidatedMessageHashes(),
  });
  return handlers as M4Handlers;
}
