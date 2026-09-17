/**
 * Client-side Solana JSON-RPC throughput limiter.
 *
 * Alchemy meters Solana methods in throughput compute units (CU) at the
 * account level: every app and process sharing the key draws from one budget
 * (300 CU/s on the free tier, evaluated over a 10-second rolling window). The
 * executor defaults to 240 CU/s per process to retain headroom, and every
 * web3.js retry passes through the fetch wrapper as well.
 *
 * A server 429 means the shared budget is already exhausted, so the wrapper
 * pauses the bucket for the server-provided (or exponential) backoff before
 * retrying — a local retry must not keep hammering the account while other
 * traffic recovers. Costs mirror the published table at
 * https://www.alchemy.com/docs/docs/reference/compute-unit-costs (throughput
 * CU where the table lists a distinct value); unknown methods pay a
 * conservative 40 CU.
 */

import type { FetchFn } from '@solana/web3.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RpcFetchTiming {
  cuWaitMs: number;
  httpMs: number;
  requests: number;
}

const readTiming = new AsyncLocalStorage<RpcFetchTiming>();

/** Attribute nested web3.js fetches to one read leg, excluding stream traffic. */
export function withRpcFetchTiming<T>(
  timing: RpcFetchTiming,
  operation: () => Promise<T>,
): Promise<T> {
  return readTiming.run(timing, operation);
}

const METHOD_CU: Readonly<Record<string, number>> = {
  // 10 CU
  getAccountInfo: 10,
  getBalance: 10,
  getBlocks: 10,
  getGenesisHash: 10,
  getMinimumBalanceForRentExemption: 10,
  getRecentPrioritizationFees: 10,
  getTokenAccountsByDelegate: 10,
  getTokenAccountsByOwner: 10,
  // 20 CU
  getBlockHeight: 20,
  getBlockTime: 20,
  getEpochInfo: 20,
  getFeeForMessage: 20,
  getLatestBlockhash: 20,
  getMultipleAccounts: 20,
  getPriorityFeeEstimate: 20,
  getProgramAccounts: 20,
  getSignatureStatuses: 20,
  getSlot: 20,
  getTokenAccountBalance: 20,
  getTokenSupply: 20,
  getTransactionCount: 20,
  getVersion: 20,
  isBlockhashValid: 20,
  sendTransaction: 20,
  simulateTransaction: 20,
  // 40 CU
  getBlock: 40,
  getFirstAvailableBlock: 40,
  getSignaturesForAddress: 40,
  getTransaction: 40,
};

export const DEFAULT_RPC_MAX_CU_PER_SECOND = 240;

/** Attempts made for a 429 before the response is handed back to web3.js. */
export const DEFAULT_RPC_RETRY_ATTEMPTS = 3;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 8_000;

export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Strict one-second token bucket; concurrent callers are serialized. */
export class RpcCuRateLimiter {
  private tokens: number;
  private capacity: number;
  private updatedAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly maxCuPerSecond: number,
    private readonly clock: RateLimiterClock = systemClock,
  ) {
    if (!Number.isFinite(maxCuPerSecond) || maxCuPerSecond <= 0) {
      throw new Error('maxCuPerSecond must be positive');
    }
    this.tokens = maxCuPerSecond;
    this.capacity = maxCuPerSecond;
    this.updatedAt = clock.now();
  }

  acquire(cost: number): Promise<void> {
    const normalizedCost = Math.max(1, cost);
    const pending = this.queue.then(() => this.waitFor(normalizedCost));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  /**
   * Drain the bucket and refuse refill for `ms`.
   *
   * Called when the server answers 429: the account-level budget is already
   * exhausted, so queued callers must wait out the cooldown instead of
   * resuming at the configured rate the moment the retry fires.
   */
  pauseFor(ms: number): void {
    const duration = Math.max(0, ms);
    if (duration === 0) return;
    this.tokens = 0;
    this.updatedAt = Math.max(this.updatedAt, this.clock.now() + duration);
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.maxCuPerSecond);
    this.updatedAt = now;
  }

  private async waitFor(cost: number): Promise<void> {
    // A single RPC may cost more than a deliberately low per-second budget.
    // Grow only the bucket capacity—not its current balance—so the call waits
    // until its full cost has accrued instead of being undercharged.
    this.capacity = Math.max(this.capacity, cost);
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((cost - this.tokens) / this.maxCuPerSecond) * 1000));
      await this.clock.sleep(waitMs);
    }
  }
}

interface RpcRequestShape {
  method?: unknown;
}

/** Sum a JSON-RPC batch's method costs; malformed bodies get a conservative 40 CU. */
export function rpcBodyCu(body: unknown): number {
  if (typeof body !== 'string') return 40;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 40;
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  return requests.reduce<number>((total, request) => {
    const method = (request as RpcRequestShape | null)?.method;
    return total + (typeof method === 'string' ? (METHOD_CU[method] ?? 40) : 40);
  }, 0);
}

export interface RpcRetryOptions {
  /** Total attempts for a 429; 1 disables retrying. */
  attempts?: number;
  /** First backoff step; doubled per attempt, with jitter below the step. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff, including `Retry-After`. */
  maxDelayMs?: number;
  /** Injectable sleep so tests stay fast. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source, always in [0, 1). */
  random?: () => number;
}

/** `Retry-After` seconds when present, else exponential backoff plus jitter. */
function retryDelayMs(
  response: Response,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const header = response.headers.get('retry-after');
  const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  if (Number.isFinite(seconds)) {
    return Math.min(maxDelayMs, Math.max(1, Math.ceil(seconds * 1000)));
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.min(maxDelayMs, exponential + Math.floor(random() * baseDelayMs));
}

export function rateLimitedFetch(
  limiter: RpcCuRateLimiter,
  fetchFn: FetchFn = globalThis.fetch,
  options: RpcRetryOptions = {},
): FetchFn {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RPC_RETRY_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_MS;
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? RETRY_MAX_MS);
  const sleep = options.sleep ?? systemClock.sleep;
  const random = options.random ?? Math.random;
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const timing = readTiming.getStore();
      const queuedAt = performance.now();
      await limiter.acquire(rpcBodyCu(init?.body));
      if (timing) timing.cuWaitMs += performance.now() - queuedAt;
      const fetchAt = performance.now();
      let response: Response;
      try {
        response = await fetchFn(input, init);
      } finally {
        if (timing) {
          timing.httpMs += performance.now() - fetchAt;
          timing.requests += 1;
        }
      }
      if (response.status !== 429 || attempt + 1 >= attempts) return response;
      const delayMs = retryDelayMs(response, attempt, baseDelayMs, maxDelayMs, random);
      limiter.pauseFor(delayMs);
      await sleep(delayMs);
    }
  };
}

const shared = new Map<string, RpcCuRateLimiter>();

/** Share one budget across all Connections using the same RPC origin. */
export function sharedRpcLimiter(endpoint: string, maxCuPerSecond: number): RpcCuRateLimiter {
  const origin = new URL(endpoint).origin;
  const key = `${origin}|${maxCuPerSecond}`;
  let limiter = shared.get(key);
  if (!limiter) {
    limiter = new RpcCuRateLimiter(maxCuPerSecond);
    shared.set(key, limiter);
  }
  return limiter;
}
