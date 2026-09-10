/**
 * Client-side Solana JSON-RPC throughput limiter.
 *
 * Alchemy meters Solana methods in throughput compute units (CU). Its free
 * tier is currently 300 CU/s; the executor defaults to 240 CU/s to retain 20%
 * headroom for dashboard/manual traffic sharing the same account. Every
 * web3.js retry passes through this fetch wrapper as well.
 */

import type { FetchFn } from '@solana/web3.js';

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
    this.updatedAt = clock.now();
  }

  acquire(cost: number): Promise<void> {
    const boundedCost = Math.min(Math.max(1, cost), this.maxCuPerSecond);
    const pending = this.queue.then(() => this.waitFor(boundedCost));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(
      this.maxCuPerSecond,
      this.tokens + elapsedSeconds * this.maxCuPerSecond,
    );
    this.updatedAt = now;
  }

  private async waitFor(cost: number): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const waitMs = Math.max(
        1,
        Math.ceil(((cost - this.tokens) / this.maxCuPerSecond) * 1000),
      );
      await this.clock.sleep(waitMs);
    }
  }
}

interface RpcRequestShape { method?: unknown }

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
    await limiter.acquire(rpcBodyCu(init?.body));
    return fetchFn(input, init);
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
