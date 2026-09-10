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
  MeteoraReads,
  RpcReadError,
  UnknownPositionError,
} from './meteora.js';

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
      return ok(
        {
          position_id: STUB_POSITION,
          pool: req.pool,
          side: req.side,
          bins: req.bin_ids.map((bin_id, i) => ({ bin_id, amount: req.amounts[i] })),
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

/** M2: real read verbs with the still-gated M1 write stubs. */
export function createReadHandlers(reads: MeteoraReads): ExecHandlers {
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
