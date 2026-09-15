/** M1 stubs plus the M2 read-only handler composition. */
import type {
  ExecHandlers,
  ExecResponse,
  StateData,
  PositionData,
  TxReceipt,
  WithdrawData,
} from './protocol.js';
import { errorResponse } from './protocol.js';
import {
  InvalidPoolError,
  RpcReadError,
  UnknownPositionError,
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
import {
  executeLegacyTransaction,
  SimulationFailed,
  SubmissionAmbiguous,
  type ExecutedTransaction,
  type ExecutionCommitment,
  type ExecutionConnection,
} from './transactions.js';
import type { Transaction } from '@solana/web3.js';

export const STUB_POSITION = 'stub_position_001';
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
      return ok(
        {
          position_id: STUB_POSITION,
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
        STUB_POSITION,
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
    async swap(req) {
      return ok(
        {
          amount_in: 1,
          amount_out: 150,
          amount_in_raw: '1000000000',
          amount_out_raw: '150000000',
          price_realized: 150,
          route: req.pool === null ? 'jupiter' : 'meteora',
        },
        [receipt('swap')],
      );
    },
    async refresh_bundle(req) {
      const transactions = [receipt('withdraw', 'finalized')];
      if (req.swap_spec !== null) transactions.push(receipt('swap'));
      transactions.push(receipt('deposit_single_sided'));
      return ok(
        {
          position_id: STUB_POSITION,
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
                  route: 'jupiter',
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

/** The read surface every handler set needs; `MeteoraReads` satisfies it. */
export interface ReadHandlersSource {
  getState(pool: string): Promise<StateData>;
  getPosition(positionId: string): Promise<PositionData>;
}

/** M2: real read verbs with the still-gated M1 write stubs. */
export function createReadHandlers(reads: ReadHandlersSource): ExecHandlers {
  const handlers = createStubHandlers();
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

/** M4 writes derive every transaction from these reads; no client tx is accepted. */
export interface WriteReads extends ReadHandlersSource, DepositWriteReads {
  getPosition(positionId: string): Promise<PositionData>;
}

export interface WriteDependencies {
  connection: AccountPresenceConnection & ExecutionConnection;
  signer: Signer;
  policy: TransactionPolicy;
  commitment: ExecutionCommitment;
  execute?: (
    tx: Transaction,
    options: Parameters<typeof executeLegacyTransaction>[1],
  ) => Promise<ExecutedTransaction>;
}

/** Per-attempt write metadata for the bridge audit line; no key material. */
export interface WriteAuditContext {
  policyDecision: 'allowed' | 'rejected' | null;
  policyRule: string | null;
  messageHash: string | null;
  blockhash: string | null;
  simulationOk: boolean | null;
  simulationLogs?: string[];
  signerId: string | null;
}

export interface M4Handlers extends ExecHandlers {
  /** The most recent write attempt; read verbs are not written here. */
  writeAudit(): WriteAuditContext;
}

function emptyWriteAudit(signerId: string): WriteAuditContext {
  return {
    policyDecision: null,
    policyRule: null,
    messageHash: null,
    blockhash: null,
    simulationOk: null,
    signerId,
  };
}

function disabledWrite<D>(): ExecResponse<D> {
  return errorResponse('internal_error', 'write verb is not enabled') as ExecResponse<D>;
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
      error instanceof WeightedDepositEncodingError) {
    return errorResponse('bad_request', error.message) as ExecResponse<never>;
  }
  return null;
}

/**
 * M4 write composition: policy-bound deposit and withdrawal on one signed
 * transaction each. `swap`/`refresh_bundle` stay disabled until M5.
 */
export function createM4Handlers(reads: WriteReads, dependencies: WriteDependencies): M4Handlers {
  const handlers = createReadHandlers(reads) as ExecHandlers & Partial<M4Handlers>;
  let lastWriteAudit = emptyWriteAudit(dependencies.signer.signerId);
  const resetWriteAudit = (): WriteAuditContext => {
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
  const recordOutcome = (audit: WriteAuditContext, error: unknown): ExecResponse<never> | null => {
    if (error instanceof PolicyRejected) {
      audit.policyDecision = 'rejected';
      audit.policyRule = error.rule;
      audit.blockhash = error.blockhash ?? null;
      audit.simulationOk = error.simulationOk ?? null;
    }
    if (error instanceof SimulationFailed) {
      audit.policyDecision = 'allowed';
      audit.messageHash = error.policy?.messageHash ?? null;
      audit.blockhash = error.blockhash ?? null;
      audit.simulationOk = false;
      audit.simulationLogs = error.logs;
    }
    if (error instanceof SubmissionAmbiguous) {
      audit.policyDecision = error.policy ? 'allowed' : audit.policyDecision;
      audit.messageHash = error.policy?.messageHash ?? audit.messageHash;
      audit.blockhash = error.blockhash ?? audit.blockhash;
      if (error.policy) audit.simulationOk = true;
    }
    return writeErrorResponse(error);
  };

  handlers.deposit_single_sided = async (req) => {
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
      audit.messageHash = executed.policy.messageHash;
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

  handlers.withdraw = async (req) => {
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
      audit.messageHash = executed.policy.messageHash;
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

  handlers.swap = async () => {
    resetWriteAudit();
    return disabledWrite();
  };
  handlers.refresh_bundle = async () => {
    resetWriteAudit();
    return disabledWrite();
  };
  handlers.writeAudit = () => lastWriteAudit;
  return handlers as M4Handlers;
}
