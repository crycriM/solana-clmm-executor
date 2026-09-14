/**
 * Client-side Solana JSON-RPC throughput limiter.
 *
 * Alchemy meters Solana methods in throughput compute units (CU). Its free
 * tier is currently 300 CU/s; the executor defaults to 240 CU/s to retain 20%
 * headroom for dashboard/manual traffic sharing the same account. Every
 * web3.js retry passes through this fetch wrapper as well.
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
  getAccountInfo: 10,
  getBalance: 10,
  getTokenAccountsByDelegate: 10,
  getTokenAccountsByOwner: 10,
  getBlockTime: 20,
  getLatestBlockhash: 20,
  getMultipleAccounts: 20,
  getProgramAccounts: 20,
  getSignatureStatuses: 20,
  getSlot: 20,
  getTokenAccountBalance: 20,
  getBlock: 40,
  getSignaturesForAddress: 40,
  getTransaction: 40,
};

export const DEFAULT_RPC_MAX_CU_PER_SECOND = 240;

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

export function rateLimitedFetch(
  limiter: RpcCuRateLimiter,
  fetchFn: FetchFn = globalThis.fetch,
): FetchFn {
  return async (input, init) => {
    const timing = readTiming.getStore();
    const queuedAt = performance.now();
    await limiter.acquire(rpcBodyCu(init?.body));
    if (timing) timing.cuWaitMs += performance.now() - queuedAt;
    const fetchAt = performance.now();
    try {
      return await fetchFn(input, init);
    } finally {
      if (timing) {
        timing.httpMs += performance.now() - fetchAt;
        timing.requests += 1;
      }
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
