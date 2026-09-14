/** Read-only Meteora DLMM access for M2.
 *
 * Pool construction (the expensive metadata read) is cached for the process
 * lifetime.  Active-bin, wallet-token, reserve, position, and slot data are
 * deliberately refreshed for every verb invocation.
 */

import { createRequire } from 'node:module';
import DecimalDefault from 'decimal.js';
import { LBCLMM_PROGRAM_IDS, POSITION_V2_DISC, type LbPosition } from '@meteora-ag/dlmm';
import { Connection, PublicKey, type AccountInfo, type ParsedAccountData } from '@solana/web3.js';
import type { ExecutorConfig } from './config.js';
import type { ExecutorLine } from './log.js';
import type { PositionData, StateData, TokenMeta } from './protocol.js';
import { bnToDecimal, bnToRaw, withRetry } from './vendor/lp-monitor/meteoraReads.js';
import { getSolanaConnection } from './vendor/lp-monitor/solana.js';
import { withRpcFetchTiming, type RpcFetchTiming } from './rpcRateLimit.js';
import {
  getTokenMapping,
  getTokenPrices,
  type TokenMapping,
} from './vendor/lp-monitor/tokenMapping.js';

const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;
const require = createRequire(import.meta.url);
const DlmmSdk = (
  require('@meteora-ag/dlmm') as {
    default: {
      create(connection: Connection, address: PublicKey): Promise<PoolReader>;
    };
  }
).default;
const DLMM_PROGRAM_ID = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);

export class UnknownPositionError extends Error {}
export class RpcReadError extends Error {}
export class InvalidPoolError extends Error {}

/** Structural slice used by the orchestration and by recorded-RPC unit fakes. */
export interface ReadConnection {
  readonly rpcEndpoint: string;
  getAccountInfoAndContext(
    address: PublicKey,
  ): Promise<{ context: { slot: number }; value: AccountInfo<Buffer> | null }>;
  getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey },
  ): Promise<{
    context: { slot: number };
    value: { account: { data: ParsedAccountData | Buffer } }[];
  }>;
  getTokenAccountBalance(
    address: PublicKey,
  ): Promise<{ context: { slot: number }; value: { amount: string } }>;
  getSlot(): Promise<number>;
}

export interface PoolReader {
  readonly pubkey: PublicKey;
  readonly lbPair: { binStep: number };
  readonly tokenX: { publicKey: PublicKey; reserve: PublicKey; mint: { decimals: number } };
  readonly tokenY: { publicKey: PublicKey; reserve: PublicKey; mint: { decimals: number } };
  getActiveBin(): Promise<{ binId: number }>;
  getFeeInfo(): { baseFeeRatePercentage: { mul(value: number): { toString(): string } } };
  getPosition(address: PublicKey): Promise<LbPosition>;
}

export interface MeteoraReadDependencies {
  connections?: ReadConnection[];
  createPool?: (connection: ReadConnection, address: PublicKey) => Promise<PoolReader>;
  tokenMapping?: (mint: string) => Promise<TokenMapping>;
  tokenPrices?: (ids: string[]) => Promise<Map<string, number>>;
  audit?: (line: ExecutorLine) => void;
  now?: () => number;
  retries?: number;
  retryDelayMs?: number;
  priceTtlMs?: number;
}

export interface ReadAuditContext {
  attempt: number;
  rpcEndpoint: string | null;
  readTimingsMs?: Record<string, number>;
  rpcCuWaitMs?: Record<string, number>;
  rpcHttpMs?: Record<string, number>;
}

interface Endpoint {
  connection: ReadConnection;
  url: string;
}

interface PoolMetadata {
  address: string;
  binStepBps: number;
  baseFeeBps: number;
  tokenX: TokenMeta;
  tokenY: TokenMeta;
  reserveX: PublicKey;
  reserveY: PublicKey;
  mappingX: TokenMapping;
  mappingY: TokenMapping;
  /** Cached for M3/M4 price conversions; decimal token-Y per token-X factor. */
  lamportPriceScale: string;
}

interface PoolCacheEntry {
  metadata: PoolMetadata;
  readers: Map<string, PoolReader>;
}

interface PriceCacheEntry {
  expiresAt: number;
  prices: Map<string, number>;
}

function decimal(raw: string, places: number): number {
  return new Decimal(raw).div(new Decimal(10).pow(places)).toNumber();
}

function rawSdkAmount(value: string): string {
  return new Decimal(value).floor().toFixed(0);
}

function parsedTokenRaw(data: ParsedAccountData | Buffer): string {
  if (Buffer.isBuffer(data)) throw new Error('RPC returned an unparsed token account');
  const amount = (data.parsed as { info?: { tokenAmount?: { amount?: unknown } } }).info
    ?.tokenAmount?.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new Error('RPC token account omitted its raw amount');
  }
  return amount;
}

function positionHeader(account: AccountInfo<Buffer> | null): {
  pool: PublicKey;
  owner: PublicKey;
} | null {
  if (
    account === null ||
    !account.owner.equals(DLMM_PROGRAM_ID) ||
    account.data.length < 72 ||
    !account.data.subarray(0, 8).equals(POSITION_V2_DISC)
  ) {
    return null;
  }
  return {
    pool: new PublicKey(account.data.subarray(8, 40)),
    owner: new PublicKey(account.data.subarray(40, 72)),
  };
}

function safeEndpoint(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-rpc-endpoint';
  }
}

export class MeteoraReads {
  private readonly endpoints: Endpoint[];
  private readonly wallet: PublicKey;
  private readonly pools = new Map<string, PoolCacheEntry>();
  private readonly prices = new Map<string, PriceCacheEntry>();
  private readonly createPool: NonNullable<MeteoraReadDependencies['createPool']>;
  private readonly tokenMapping: NonNullable<MeteoraReadDependencies['tokenMapping']>;
  private readonly tokenPrices: NonNullable<MeteoraReadDependencies['tokenPrices']>;
  private readonly audit: NonNullable<MeteoraReadDependencies['audit']>;
  private readonly now: NonNullable<MeteoraReadDependencies['now']>;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly priceTtlMs: number;
  private operationAttempt = 1;
  private operationEndpoint: string | null = null;
  private operationTimings: Record<string, number> | null = null;
  private operationCuWait: Record<string, number> | null = null;
  private operationHttp: Record<string, number> | null = null;

  constructor(
    private readonly config: ExecutorConfig,
    wallet: PublicKey,
    dependencies: MeteoraReadDependencies = {},
  ) {
    this.wallet = wallet;
    const configured = dependencies.connections ?? this.configuredConnections();
    if (configured.length === 0) throw new RpcReadError('No RPC endpoint configured');
    this.endpoints = configured.map((connection) => ({
      connection,
      url: connection.rpcEndpoint,
    }));
    this.createPool =
      dependencies.createPool ??
      (async (connection, address) =>
        DlmmSdk.create(connection as Connection, address) as Promise<PoolReader>);
    this.tokenMapping = dependencies.tokenMapping ?? getTokenMapping;
    this.tokenPrices = dependencies.tokenPrices ?? getTokenPrices;
    this.audit = dependencies.audit ?? (() => undefined);
    this.now = dependencies.now ?? Date.now;
    this.retries = Math.max(1, dependencies.retries ?? 3);
    this.retryDelayMs = dependencies.retryDelayMs ?? 250;
    this.priceTtlMs = dependencies.priceTtlMs ?? 30_000;
  }

  private configuredConnections(): ReadConnection[] {
    const read = getSolanaConnection(this.config) as unknown as ReadConnection;
    if (this.config.rpcWriteUrl === this.config.rpcReadUrl) return [read];
    return [read, getSolanaConnection(this.config, { write: true }) as unknown as ReadConnection];
  }

  private async rpc<T>(operation: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    let endpointIndex = 0;
    let attempt = 1;
    try {
      return await withRetry(
        () => {
          const endpoint = this.endpoints[endpointIndex]!;
          this.operationAttempt = Math.max(this.operationAttempt, attempt);
          this.operationEndpoint = endpoint.url;
          return operation(endpoint);
        },
        this.retries,
        this.retryDelayMs,
        (_attempt, error) => {
          const from = this.endpoints[endpointIndex]!;
          endpointIndex = (endpointIndex + 1) % this.endpoints.length;
          attempt += 1;
          const to = this.endpoints[endpointIndex]!;
          if (to.url !== from.url) {
            this.audit({
              kind: 'rpc_failover',
              ts: this.now() / 1000,
              from_endpoint: safeEndpoint(from.url),
              to_endpoint: safeEndpoint(to.url),
              error: error.name || 'RpcError',
            });
          }
        },
      );
    } catch {
      throw new RpcReadError('RPC read failed after retries');
    }
  }

  /** Metadata for bridge.ts's one-line-per-verb operational record. */
  auditContext(): ReadAuditContext {
    return {
      attempt: this.operationAttempt,
      rpcEndpoint: this.operationEndpoint,
      ...(this.operationTimings === null ? {} : { readTimingsMs: this.operationTimings }),
      ...(this.operationCuWait === null ? {} : { rpcCuWaitMs: this.operationCuWait }),
      ...(this.operationHttp === null ? {} : { rpcHttpMs: this.operationHttp }),
    };
  }

  /**
   * Token decimals for a pool, for the swap stream's raw→decimal scaling.
   *
   * Returns null until the pool's metadata has been read once (the first
   * `get_state`/`get_position` on it). The stream treats "unknown" as "emit raw
   * only" rather than guessing a scale — a wrong scale silently corrupts every
   * amount in the row.
   */
  poolDecimals(poolAddress: string): { base: number; quote: number } | null {
    const entry = this.pools.get(poolAddress);
    if (!entry) return null;
    return {
      base: entry.metadata.tokenX.decimals,
      quote: entry.metadata.tokenY.decimals,
    };
  }

  /** Load immutable metadata before the swap stream can emit its first row. */
  async ensurePoolDecimals(poolAddress: string): Promise<{ base: number; quote: number }> {
    if (!this.config.poolAllowlist.includes(poolAddress)) {
      throw new InvalidPoolError('Pool is not allow-listed');
    }
    await this.rpc((endpoint) => this.pool(endpoint, poolAddress));
    const decimals = this.poolDecimals(poolAddress);
    if (decimals === null) throw new RpcReadError('Pool metadata cache was not populated');
    return decimals;
  }

  private beginOperation(): void {
    this.operationAttempt = 1;
    this.operationEndpoint = null;
    this.operationTimings = null;
    this.operationCuWait = null;
    this.operationHttp = null;
  }

  private async pool(endpoint: Endpoint, poolAddress: string): Promise<PoolCacheEntry> {
    const cached = this.pools.get(poolAddress);
    const cachedReader = cached?.readers.get(endpoint.url);
    if (cached && cachedReader) return cached;

    const address = new PublicKey(poolAddress);
    const reader = await this.createPool(endpoint.connection, address);
    if (cached) {
      // A failover endpoint needs its own SDK instance, but immutable metadata
      // remains the first validated copy for the life of the process.
      cached.readers.set(endpoint.url, reader);
      return cached;
    }

    const xMint = reader.tokenX.publicKey.toBase58();
    const yMint = reader.tokenY.publicKey.toBase58();
    const [mappingX, mappingY] = await Promise.all([
      this.tokenMapping(xMint),
      this.tokenMapping(yMint),
    ]);
    const baseFeeBps = Number(reader.getFeeInfo().baseFeeRatePercentage.mul(100).toString());
    if (!Number.isFinite(baseFeeBps)) throw new Error('SDK returned an invalid base fee');
    const entry: PoolCacheEntry = {
      metadata: {
        address: poolAddress,
        binStepBps: reader.lbPair.binStep,
        baseFeeBps,
        tokenX: {
          mint: xMint,
          decimals: reader.tokenX.mint.decimals,
          ...(mappingX.symbol === 'Unknown' ? {} : { symbol: mappingX.symbol }),
        },
        tokenY: {
          mint: yMint,
          decimals: reader.tokenY.mint.decimals,
          ...(mappingY.symbol === 'Unknown' ? {} : { symbol: mappingY.symbol }),
        },
        reserveX: reader.tokenX.reserve,
        reserveY: reader.tokenY.reserve,
        mappingX,
        mappingY,
        lamportPriceScale: new Decimal(10)
          .pow(reader.tokenY.mint.decimals - reader.tokenX.mint.decimals)
          .toFixed(),
      },
      readers: new Map([[endpoint.url, reader]]),
    };
    this.pools.set(poolAddress, entry);
    return entry;
  }

  private reader(entry: PoolCacheEntry, endpoint: Endpoint): PoolReader {
    const reader = entry.readers.get(endpoint.url);
    if (!reader) throw new Error('pool reader cache invariant failed');
    return reader;
  }

  private async walletBalance(
    endpoint: Endpoint,
    mint: TokenMeta,
  ): Promise<{ raw: string; slot: number }> {
    const response = await endpoint.connection.getParsedTokenAccountsByOwner(this.wallet, {
      mint: new PublicKey(mint.mint),
    });
    const raw = response.value.reduce(
      (sum, tokenAccount) => sum + BigInt(parsedTokenRaw(tokenAccount.account.data)),
      0n,
    );
    return { raw: raw.toString(), slot: response.context.slot };
  }

  private async reserveBalance(
    endpoint: Endpoint,
    address: PublicKey,
  ): Promise<{ raw: string; slot: number }> {
    const response = await endpoint.connection.getTokenAccountBalance(address);
    if (!/^\d+$/.test(response.value.amount))
      throw new Error('RPC returned invalid reserve amount');
    return { raw: response.value.amount, slot: response.context.slot };
  }

  private async poolPrices(metadata: PoolMetadata): Promise<Map<string, number>> {
    const cached = this.prices.get(metadata.address);
    if (cached && cached.expiresAt > this.now()) return cached.prices;
    const ids = [metadata.mappingX.coingeckoId, metadata.mappingY.coingeckoId].filter(Boolean);
    if (ids.length === 0) return new Map();
    try {
      const prices = await this.tokenPrices(ids);
      this.prices.set(metadata.address, { expiresAt: this.now() + this.priceTtlMs, prices });
      return prices;
    } catch {
      return new Map();
    }
  }

  async getState(poolAddress: string): Promise<StateData> {
    this.beginOperation();
    if (!this.config.poolAllowlist.includes(poolAddress)) {
      throw new InvalidPoolError('Pool is not allow-listed');
    }
    return this.rpc(async (endpoint) => {
      const entry = await this.pool(endpoint, poolAddress);
      const pool = this.reader(entry, endpoint);
      const { metadata } = entry;
      const timings: Record<string, number> = {};
      const cuWait: Record<string, number> = {};
      const http: Record<string, number> = {};
      const measure = async <T>(name: string, read: () => Promise<T>): Promise<T> => {
        const started = performance.now();
        const rpc: RpcFetchTiming = { cuWaitMs: 0, httpMs: 0, requests: 0 };
        try {
          return await withRpcFetchTiming(rpc, read);
        } finally {
          timings[name] = Math.round(performance.now() - started);
          cuWait[name] = Math.round(rpc.cuWaitMs);
          http[name] = Math.round(rpc.httpMs);
        }
      };
      const [active, walletX, walletY, reserveX, reserveY, prices] = await Promise.all([
        measure('active_bin', () => pool.getActiveBin()),
        measure('wallet_base', () => this.walletBalance(endpoint, metadata.tokenX)),
        measure('wallet_quote', () => this.walletBalance(endpoint, metadata.tokenY)),
        measure('reserve_base', () => this.reserveBalance(endpoint, metadata.reserveX)),
        measure('reserve_quote', () => this.reserveBalance(endpoint, metadata.reserveY)),
        measure('prices', () => this.poolPrices(metadata)),
      ]);
      this.operationTimings = timings;
      this.operationCuWait = cuWait;
      this.operationHttp = http;
      const xPrice = prices.get(metadata.mappingX.coingeckoId);
      const yPrice = prices.get(metadata.mappingY.coingeckoId);
      const tvlUsd =
        xPrice === undefined || yPrice === undefined
          ? null
          : decimal(reserveX.raw, metadata.tokenX.decimals) * xPrice +
            decimal(reserveY.raw, metadata.tokenY.decimals) * yPrice;
      return {
        active_bin: active.binId,
        bin_step_bps: metadata.binStepBps,
        base_fee_bps: metadata.baseFeeBps,
        balances: {
          base: decimal(walletX.raw, metadata.tokenX.decimals),
          quote: decimal(walletY.raw, metadata.tokenY.decimals),
        },
        balances_raw: { base: walletX.raw, quote: walletY.raw },
        tvl_usd: tvlUsd,
        token_x: metadata.tokenX,
        token_y: metadata.tokenY,
        // Every balance RPC carries a context slot. A separate getSlot call
        // adds latency/CU and can race ahead of the state we actually read.
        slot: Math.max(walletX.slot, walletY.slot, reserveX.slot, reserveY.slot),
        fetched_at: this.now() / 1000,
      };
    });
  }

  async getPosition(positionId: string): Promise<PositionData> {
    this.beginOperation();
    let address: PublicKey;
    try {
      address = new PublicKey(positionId);
    } catch {
      throw new UnknownPositionError('Position does not exist or is not owned by the wallet');
    }
    const discovered = await this.rpc(async (endpoint) => {
      const response = await endpoint.connection.getAccountInfoAndContext(address);
      return { endpoint, slot: response.context.slot, header: positionHeader(response.value) };
    });
    if (
      discovered.header === null ||
      !discovered.header.owner.equals(this.wallet) ||
      !this.config.poolAllowlist.includes(discovered.header.pool.toBase58())
    ) {
      throw new UnknownPositionError('Position does not exist or is not owned by the wallet');
    }

    try {
      return await this.rpc(async (endpoint) => {
        const poolAddress = discovered.header!.pool.toBase58();
        const entry = await this.pool(endpoint, poolAddress);
        const pool = this.reader(entry, endpoint);
        const [position, active, slot] = await Promise.all([
          pool.getPosition(address),
          pool.getActiveBin(),
          endpoint.connection.getSlot(),
        ]);
        if (!position.positionData.owner.equals(this.wallet)) {
          throw new UnknownPositionError('Position does not exist or is not owned by the wallet');
        }
        const data = position.positionData;
        const dx = entry.metadata.tokenX.decimals;
        const dy = entry.metadata.tokenY.decimals;
        const feeXRaw = bnToRaw(data.feeX);
        const feeYRaw = bnToRaw(data.feeY);
        return {
          position_id: positionId,
          pool: poolAddress,
          owner: data.owner.toBase58(),
          active_bin: active.binId,
          min_bin_id: data.lowerBinId,
          max_bin_id: data.upperBinId,
          bins: data.positionBinData.map((bin) => {
            const xRaw = rawSdkAmount(bin.positionXAmount);
            const yRaw = rawSdkAmount(bin.positionYAmount);
            const liquidity = new Decimal(bin.binLiquidity);
            return {
              bin_id: bin.binId,
              bin_price: Number(bin.pricePerToken),
              amount_base: decimal(xRaw, dx),
              amount_quote: decimal(yRaw, dy),
              amount_base_raw: xRaw,
              amount_quote_raw: yRaw,
              liquidity_share: liquidity.isZero()
                ? 0
                : new Decimal(bin.positionLiquidity).div(liquidity).toNumber(),
            };
          }),
          claimable_fee_x: bnToDecimal(data.feeX, dx),
          claimable_fee_y: bnToDecimal(data.feeY, dy),
          claimable_fee_x_raw: feeXRaw,
          claimable_fee_y_raw: feeYRaw,
          total_base: decimal(rawSdkAmount(data.totalXAmount), dx),
          total_quote: decimal(rawSdkAmount(data.totalYAmount), dy),
          slot: Math.max(discovered.slot, slot),
        };
      });
    } catch (error) {
      if (error instanceof UnknownPositionError) throw error;
      throw error;
    }
  }
}
