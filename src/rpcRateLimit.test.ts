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

  it('prices the write and confirmation methods at Alchemy throughput CU', () => {
    expect(rpcBodyCu(JSON.stringify({ method: 'sendTransaction' }))).toBe(20);
    expect(rpcBodyCu(JSON.stringify({ method: 'simulateTransaction' }))).toBe(20);
    expect(rpcBodyCu(JSON.stringify({ method: 'getGenesisHash' }))).toBe(10);
    expect(rpcBodyCu(JSON.stringify({ method: 'getLargestAccounts' }))).toBe(40);
  });

  function fakeClock(): {
    clock: { now: () => number; sleep: (ms: number) => Promise<void> };
    sleeps: number[];
  } {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    };
  }

  it('backs off exponentially, drains the bucket, then retries a 429', async () => {
    const { clock, sleeps } = fakeClock();
    const limiter = new RpcCuRateLimiter(240, clock);
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 429 }) : new Response('{}');
    });
    const wrapped = rateLimitedFetch(limiter, inner as typeof fetch, {
      sleep: clock.sleep,
      random: () => 0,
    });
    const response = await wrapped('https://rpc.invalid', {
      method: 'POST',
      body: JSON.stringify({ method: 'getSlot' }),
    });
    expect(response.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBe(1_000);
    expect(sleeps.at(-1)).toBeGreaterThan(0);
  });

  it('honors Retry-After for the 429 cooldown', async () => {
    const { clock, sleeps } = fakeClock();
    const limiter = new RpcCuRateLimiter(240, clock);
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } })
        : new Response('{}');
    });
    const wrapped = rateLimitedFetch(limiter, inner as typeof fetch, { sleep: clock.sleep });
    await wrapped('https://rpc.invalid', {
      method: 'POST',
      body: JSON.stringify({ method: 'getSlot' }),
    });
    expect(sleeps[0]).toBe(2_000);
  });

  it('returns the final 429 once attempts are exhausted', async () => {
    const { clock, sleeps } = fakeClock();
    const limiter = new RpcCuRateLimiter(240, clock);
    const inner = vi.fn(async () => new Response('{}', { status: 429 }));
    const wrapped = rateLimitedFetch(limiter, inner as typeof fetch, {
      attempts: 3,
      sleep: clock.sleep,
      random: () => 0,
    });
    const response = await wrapped('https://rpc.invalid', {
      method: 'POST',
      body: JSON.stringify({ method: 'getSlot' }),
    });
    expect(response.status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleeps.filter((ms) => ms >= 1_000)).toEqual([1_000, 2_000]);
  });

  it('passes non-429 failures straight through without retrying', async () => {
    const { clock, sleeps } = fakeClock();
    const limiter = new RpcCuRateLimiter(240, clock);
    const inner = vi.fn(async () => new Response('{}', { status: 500 }));
    const wrapped = rateLimitedFetch(limiter, inner as typeof fetch, { sleep: clock.sleep });
    const response = await wrapped('https://rpc.invalid', {
      method: 'POST',
      body: JSON.stringify({ method: 'getSlot' }),
    });
    expect(response.status).toBe(500);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
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
