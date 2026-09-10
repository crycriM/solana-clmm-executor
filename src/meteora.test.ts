import fs from 'node:fs';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { LBCLMM_PROGRAM_IDS, POSITION_V2_DISC, type LbPosition } from '@meteora-ag/dlmm';
import { PublicKey, type AccountInfo, type ParsedAccountData } from '@solana/web3.js';
import { createReadHandlers } from './handlers.js';
import {
  MeteoraReads,
  type PoolReader,
  type ReadConnection,
} from './meteora.js';
import { loadConfig } from './config.js';
import { baseEnv, TEST_BASE_MINT, TEST_POOL } from './testing.js';
import type { ExecutorLine } from './log.js';

interface StateFixture {
  slot: number;
  active_bin: number;
  bin_step_bps: number;
  base_fee_percent: string;
  token_x: TokenFixture;
  token_y: TokenFixture;
}
interface TokenFixture {
  mint: string;
  decimals: number;
  symbol: string;
  coingecko_id: string;
  wallet_raw: string;
  reserve_raw: string;
  usd: number;
}
interface PositionFixture {
  position_id: string;
  active_bin: number;
  lower_bin_id: number;
  upper_bin_id: number;
  total_x_raw: string;
  total_y_raw: string;
  fee_x_raw: string;
  fee_y_raw: string;
  bins: {
    bin_id: number;
    price_per_token: string;
    x_raw: string;
    y_raw: string;
    bin_liquidity: string;
    position_liquidity: string;
  }[];
}

const state = JSON.parse(
  fs.readFileSync(new URL('../fixtures/rpc/pool-state.json', import.meta.url), 'utf8'),
) as StateFixture;
const position = JSON.parse(
  fs.readFileSync(new URL('../fixtures/rpc/position.json', import.meta.url), 'utf8'),
) as PositionFixture;
const owner = new PublicKey('Vote111111111111111111111111111111111111111');
const poolAddress = new PublicKey(TEST_POOL);
const reserveX = new PublicKey('SysvarRent111111111111111111111111111111111');
const reserveY = new PublicKey('SysvarC1ock11111111111111111111111111111111');

function parsed(raw: string): ParsedAccountData {
  return { program: 'spl-token', space: 165, parsed: { info: { tokenAmount: { amount: raw } } } };
}

function positionAccount(positionOwner = owner): AccountInfo<Buffer> {
  const data = Buffer.alloc(72);
  POSITION_V2_DISC.copy(data, 0);
  poolAddress.toBuffer().copy(data, 8);
  positionOwner.toBuffer().copy(data, 40);
  return {
    data,
    executable: false,
    lamports: 1,
    owner: new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']),
    rentEpoch: 0,
  };
}

class FakeConnection implements ReadConnection {
  readonly rpcEndpoint: string;
  account: AccountInfo<Buffer> | null = positionAccount();
  fail = false;

  constructor(endpoint = 'https://primary.rpc.test') {
    this.rpcEndpoint = endpoint;
  }

  async getAccountInfoAndContext() {
    if (this.fail) throw new Error('offline');
    return { context: { slot: state.slot }, value: this.account };
  }

  async getParsedTokenAccountsByOwner(_owner: PublicKey, filter: { mint: PublicKey }) {
    if (this.fail) throw new Error('offline');
    const raw = filter.mint.equals(new PublicKey(TEST_BASE_MINT))
      ? state.token_x.wallet_raw
      : state.token_y.wallet_raw;
    return { context: { slot: state.slot }, value: [{ account: { data: parsed(raw) } }] };
  }

  async getTokenAccountBalance(address: PublicKey) {
    if (this.fail) throw new Error('offline');
    return {
      context: { slot: state.slot },
      value: { amount: address.equals(reserveX) ? state.token_x.reserve_raw : state.token_y.reserve_raw },
    };
  }

  async getSlot() {
    if (this.fail) throw new Error('offline');
    return state.slot;
  }
}

function fakePool(): PoolReader {
  return {
    pubkey: poolAddress,
    lbPair: { binStep: state.bin_step_bps },
    tokenX: {
      publicKey: new PublicKey(state.token_x.mint),
      reserve: reserveX,
      mint: { decimals: state.token_x.decimals },
    },
    tokenY: {
      publicKey: new PublicKey(state.token_y.mint),
      reserve: reserveY,
      mint: { decimals: state.token_y.decimals },
    },
    async getActiveBin() {
      return { binId: state.active_bin };
    },
    getFeeInfo() {
      return {
        baseFeeRatePercentage: {
          mul: (value: number) => ({ toString: () => String(Number(state.base_fee_percent) * value) }),
        },
      };
    },
    async getPosition() {
      return {
        publicKey: new PublicKey(position.position_id),
        version: 1,
        positionData: {
          owner,
          lowerBinId: position.lower_bin_id,
          upperBinId: position.upper_bin_id,
          totalXAmount: position.total_x_raw,
          totalYAmount: position.total_y_raw,
          feeX: new BN(position.fee_x_raw),
          feeY: new BN(position.fee_y_raw),
          positionBinData: position.bins.map((bin) => ({
            binId: bin.bin_id,
            price: bin.price_per_token,
            pricePerToken: bin.price_per_token,
            binXAmount: bin.x_raw,
            binYAmount: bin.y_raw,
            binLiquidity: bin.bin_liquidity,
            positionLiquidity: bin.position_liquidity,
            positionXAmount: bin.x_raw,
            positionYAmount: bin.y_raw,
            positionFeeXAmount: '0',
            positionFeeYAmount: '0',
            positionRewardAmount: [],
          })),
        },
      } as unknown as LbPosition;
    },
  };
}

function harness(
  connections: FakeConnection[] = [new FakeConnection()],
  pricesAvailable = true,
) {
  let creates = 0;
  let mappings = 0;
  let priceCalls = 0;
  const audit: ExecutorLine[] = [];
  const cfg = loadConfig(
    baseEnv({
      WALLET_PUBKEY: owner.toBase58(),
      POOL_ALLOWLIST: TEST_POOL,
      SOLANA_RPC_URL: connections[0]!.rpcEndpoint,
      SOLANA_RPC_WRITE_URL: connections.at(-1)!.rpcEndpoint,
    }),
  );
  const reads = new MeteoraReads(cfg, owner, {
    connections,
    createPool: async () => {
      creates += 1;
      return fakePool();
    },
    tokenMapping: async (mint) => {
      mappings += 1;
      const token = mint === state.token_x.mint ? state.token_x : state.token_y;
      return { address: mint, symbol: token.symbol, coingeckoId: token.coingecko_id, decimals: token.decimals };
    },
    tokenPrices: async () => {
      priceCalls += 1;
      return pricesAvailable
        ? new Map([
            [state.token_x.coingecko_id, state.token_x.usd],
            [state.token_y.coingecko_id, state.token_y.usd],
          ])
        : new Map();
    },
    audit: (line) => audit.push(line),
    now: () => 1_756_900_001_123,
    retries: connections.length,
    retryDelayMs: 0,
  });
  return { reads, audit, counts: () => ({ creates, mappings, priceCalls }) };
}

describe('M2 get_state recorded RPC mapping', () => {
  it('preserves >2^53 raw strings and caches immutable pool metadata', async () => {
    const h = harness();
    const first = await h.reads.getState(TEST_POOL);
    const second = await h.reads.getState(TEST_POOL);

    expect(first.balances_raw.base).toBe('10000000411680503305');
    expect(first.active_bin).toBe(8123);
    expect(first.base_fee_bps).toBe(25);
    expect(first.slot).toBe(state.slot);
    expect(first.fetched_at).toBe(1_756_900_001.123);
    expect(first.tvl_usd).toBe(375_000);
    expect(second).toEqual(first);
    expect(h.counts()).toEqual({ creates: 1, mappings: 2, priceCalls: 1 });
  });

  it('fails over to the distinct endpoint and emits a sanitized audit line', async () => {
    const primary = new FakeConnection('https://user:secret@primary.rpc.test/key');
    primary.fail = true;
    const fallback = new FakeConnection('https://fallback.rpc.test/key');
    const h = harness([primary, fallback]);
    const result = await h.reads.getState(TEST_POOL);
    expect(result.active_bin).toBe(state.active_bin);
    expect(h.reads.auditContext()).toEqual({
      attempt: 2,
      rpcEndpoint: 'https://fallback.rpc.test/key',
    });
    expect(h.audit).toContainEqual({
      kind: 'rpc_failover',
      ts: 1_756_900_001.123,
      from_endpoint: 'https://primary.rpc.test',
      to_endpoint: 'https://fallback.rpc.test',
      error: 'Error',
    });
  });

  it('returns null TVL when either external token price is unavailable', async () => {
    const h = harness([new FakeConnection()], false);
    expect((await h.reads.getState(TEST_POOL)).tvl_usd).toBeNull();
  });

  it('normalizes a non-allow-listed pool and exhausted RPC reads', async () => {
    const good = harness();
    const goodHandlers = createReadHandlers(good.reads);
    const rejected = await goodHandlers.get_state({
      method: 'get_state',
      pool: TEST_BASE_MINT,
    });
    expect(rejected.error).toBe('bad_request');

    const failedConnection = new FakeConnection();
    failedConnection.fail = true;
    const failedHandlers = createReadHandlers(harness([failedConnection]).reads);
    const failed = await failedHandlers.get_state({ method: 'get_state', pool: TEST_POOL });
    expect(failed.error).toBe('rpc_timeout');
  });
});

describe('M2 get_position recorded SDK mapping', () => {
  it('maps exact claimable fees and per-bin raw values without Number conversion', async () => {
    const h = harness();
    const result = await h.reads.getPosition(position.position_id);
    expect(result.owner).toBe(owner.toBase58());
    expect(result.claimable_fee_x_raw).toBe('9007199254740993');
    expect(result.bins[0]!.amount_base_raw).toBe('10000000411680503305');
    expect(result.bins[0]!.liquidity_share).toBeCloseTo(0.0142);
    expect(result.slot).toBe(state.slot);
  });

  it.each(['missing account', 'wrong owner'])('normalizes %s to unknown_position', async (kind) => {
    const connection = new FakeConnection();
    connection.account = kind === 'missing account' ? null : positionAccount(poolAddress);
    const handlers = createReadHandlers(harness([connection]).reads);
    const response = await handlers.get_position({
      method: 'get_position',
      position_id: position.position_id,
    });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('unknown_position');
  });
});
