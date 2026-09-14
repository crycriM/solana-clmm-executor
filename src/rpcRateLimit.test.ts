import { describe, expect, it, vi } from 'vitest';
import {
  RpcCuRateLimiter,
  rateLimitedFetch,
  rpcBodyCu,
  withRpcFetchTiming,
  type RpcFetchTiming,
} from './rpcRateLimit.js';

describe('Alchemy-compatible RPC CU limiting', () => {
  it('prices the M3 history methods and JSON-RPC batches', () => {
    expect(rpcBodyCu(JSON.stringify({ method: 'getTransaction' }))).toBe(40);
    expect(
      rpcBodyCu(
        JSON.stringify([{ method: 'getSignaturesForAddress' }, { method: 'getAccountInfo' }]),
      ),
    ).toBe(50);
    expect(rpcBodyCu('not json')).toBe(40);
  });

  it('serializes concurrent callers and waits for CU refill', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RpcCuRateLimiter(80, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await Promise.all([limiter.acquire(40), limiter.acquire(40), limiter.acquire(40)]);
    expect(sleeps).toEqual([500]);
  });

  it('charges web3 retries because every fetch invocation reacquires tokens', async () => {
    let now = 0;
    const limiter = new RpcCuRateLimiter(40, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const inner = vi.fn(async () => new Response('{}'));
    const wrapped = rateLimitedFetch(limiter, inner as typeof fetch);
    const init = { method: 'POST', body: JSON.stringify({ method: 'getTransaction' }) };
    await wrapped('https://rpc.invalid', init);
    await wrapped('https://rpc.invalid', init);
    expect(now).toBe(1000);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('does not discount a request whose cost exceeds the configured rate', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RpcCuRateLimiter(20, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await limiter.acquire(40);
    await limiter.acquire(40);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('attributes nested fetch time to its read context without leaking to other calls', async () => {
    const limiter = new RpcCuRateLimiter(240);
    const wrapped = rateLimitedFetch(limiter, async () => new Response('{}'));
    const timing: RpcFetchTiming = { cuWaitMs: 0, httpMs: 0, requests: 0 };
    await withRpcFetchTiming(timing, () =>
      wrapped('https://rpc.invalid', {
        method: 'POST',
        body: JSON.stringify({ method: 'getSlot' }),
      }),
    );
    expect(timing.requests).toBe(1);
    expect(timing.cuWaitMs).toBeGreaterThanOrEqual(0);
    expect(timing.httpMs).toBeGreaterThanOrEqual(0);
    await wrapped('https://rpc.invalid', {
      method: 'POST',
      body: JSON.stringify({ method: 'getSlot' }),
    });
    expect(timing.requests).toBe(1);
  });
});
