import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JsonlWriter, readJsonl } from './jsonl.js';
import { encodeSwap } from './events.test.js';
import {
  DLMM_PROGRAM_ID,
  SwapStream,
  decodeLogs,
  orderForReplay,
  type ExecutorStreamGapInput,
  type SwapStreamDeps,
} from './swapStream.js';
import type { SwapStreamRow } from './protocol.js';

const POOL = 'FhUkstmiaPRiUio6uENWpV8kXL1cgsiH6FsGHLepXqYQ';
const OTHER_POOL = '6BdMFYgJ4ZHbbXYDNATjJ3QzBhZJFC1c8hqFLdjdvDp';
const FROM = '6pWqTVhrcDiDRky5Y1YHzB2iEAS6fwZU8iGZyPrfEkqK';
const require = createRequire(import.meta.url);
const { utils } = require('@coral-xyz/anchor');

/** SOL/USDC-like: base 9 decimals, quote 6. */
const DECIMALS = { base: 9, quote: 6 };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  stream: SwapStream;
  file: string;
  gaps: ExecutorStreamGapInput[];
  deps: {
    logs: Map<string, {
      slot: number;
      blockTime: number | null;
      logs: string[];
      eventInstructions?: string[];
    }>;
    signatures: Map<string, { slot: number; signature: string; err?: unknown }[]>;
    notified: { pool: string; slot: number; notification: Record<string, unknown> }[];
    subscribeCount: () => number;
    subscriptionFilters: () => string[];
    fireOpen: () => Promise<number>;
    notify: (signature: string, slot: number, logs: string[]) => Promise<void>;
  };
}

function swapLogs(options: {
  pool?: string;
  startBinId: number;
  endBinId: number;
  amountIn?: string;
  amountOut?: string;
  swapForY?: boolean;
  fee?: string;
  feeBps?: string;
}): string[] {
  // 25 bps of the default amountIn (12_500_000_000) = 31_250_000.
  const payload = encodeSwap({
    lbPair: options.pool ?? POOL,
    from: FROM,
    startBinId: options.startBinId,
    endBinId: options.endBinId,
    amountIn: options.amountIn ?? '12500000000',
    amountOut: options.amountOut ?? '1760200000',
    swapForY: options.swapForY ?? true,
    fee: options.fee ?? '31250000',
    feeBps: options.feeBps ?? '2500000000000000000',
  });
  return [
    `Program ${DLMM_PROGRAM_ID} invoke [1]`,
    'Program log: Instruction: Swap2',
    `Program data: ${payload}`,
    `Program ${DLMM_PROGRAM_ID} success`,
  ];
}

function eventCpiSwap(options: Parameters<typeof swapLogs>[0]): string {
  const payload = encodeSwap({
    lbPair: options.pool ?? POOL,
    from: FROM,
    startBinId: options.startBinId,
    endBinId: options.endBinId,
    amountIn: options.amountIn ?? '12500000000',
    amountOut: options.amountOut ?? '1760200000',
    swapForY: options.swapForY ?? true,
    fee: options.fee ?? '31250000',
    feeBps: options.feeBps ?? '2500000000000000000',
  });
  return utils.bytes.bs58.encode(Buffer.concat([
    Buffer.from('e445a52e51cb9a1d', 'hex'),
    Buffer.from(payload, 'base64'),
  ]));
}

function harness(
  overrides: Partial<SwapStreamDeps> & { initialRows?: unknown[] } = {},
): Harness {
  const { initialRows = [], ...depOverrides } = overrides;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapstream-'));
  dirs.push(dir);
  const file = path.join(dir, 'swaps.jsonl');
  const writer = new JsonlWriter(file);
  for (const row of initialRows) writer.append(row);
  const gaps: ExecutorStreamGapInput[] = [];
  const logs = new Map<string, {
    slot: number;
    blockTime: number | null;
    logs: string[];
    eventInstructions?: string[];
  }>();
  const signatures = new Map<string, { slot: number; signature: string; err?: unknown }[]>();
  const notified: { pool: string; slot: number; notification: Record<string, unknown> }[] = [];
  const subscriptionFilters: string[] = [];
  let subscribes = 0;

  const openListeners: (() => void)[] = [];
  const socket = {
    on(event: string, listener: () => void) {
      if (event === 'open') openListeners.push(listener);
      return socket;
    },
    close() { return undefined; },
  };
  const connection = {
    _rpcWebSocket: socket,
    onLogs(filter: { toBase58(): string }, callback: (n: unknown, ctx: { slot: number }) => void) {
      subscribes += 1;
      subscriptionFilters.push(filter.toBase58());
      // Recorded so tests can drive the callback directly.
      harnessRef.callback = callback as never;
      return subscribes;
    },
    removeOnLogsListener() { return Promise.resolve(); },
  };
  const harnessRef: { callback?: (n: unknown, ctx: { slot: number }) => void } = {};

  const deps: SwapStreamDeps = {
    connection: connection as never,
    writer,
    log: { write: (line) => gaps.push(line) },
    pools: depOverrides.pools ?? [POOL],
    decimals: () => DECIMALS,
    now: () => 1756900000.5,
    retryDelayMs: 0,
    blockTime: async (slot) => (slot > 0 ? 1756900000 + slot : null),
    fetchLogs: async (signature) => logs.get(signature) ?? null,
    fetchBlock: async () => null,
    fetchSignatures: async (pool) => (signatures.get(pool) ?? []) as never,
    ...depOverrides,
  };
  const stream = new SwapStream(deps);
  return {
    stream,
    file,
    gaps,
    deps: {
      logs,
      signatures,
      notified,
      subscribeCount: () => subscribes,
      subscriptionFilters: () => [...subscriptionFilters],
      /** Simulate the websocket reconnecting after a drop. */
      fireOpen: async () => {
        for (const listener of openListeners) listener();
        await stream.flush();
        return openListeners.length;
      },
      notify: async (signature, slot, logLines) => {
        harnessRef.callback?.(
          { err: null, logs: logLines, signature } as never,
          { slot },
        );
        await stream.flush();
      },
    },
  };
}

/** Drive a log notification through the stream the way onLogs would. */
async function emit(
  h: Harness,
  signature: string,
  slot: number,
  logLines: string[],
  err: unknown = null,
): Promise<SwapStreamRow[]> {
  return h.stream.handleNotification({ err: err as never, logs: logLines, signature }, slot);
}

describe('swap event → stream row mapping', () => {
  it('maps a decoded swap onto the §6 row schema', () => {
    const rows = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 8123, endBinId: 8127 }), signature: 'sigA' },
      { slot: 301234567, blockTime: 1756900001, ts: 1756900001.4 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tx_signature: 'sigA',
      slot: 301234567,
      block_time: 1756900001,
      ts: 1756900001.4,
      pool: POOL,
      direction: 'up',
      prev_active_bin: 8123,
      new_active_bin: 8127,
    });
    // swapForY: the taker sold quote (6 dp) for base (9 dp).
    expect(rows[0]!.amount_in).toBeCloseTo(12500, 6);
    expect(rows[0]!.amount_in_raw).toBe('12500000000');
    expect(rows[0]!.amount_out).toBeCloseTo(1.7602, 9);
    expect(rows[0]!.amount_out_raw).toBe('1760200000');
    expect(rows[0]!.fee_bps).toBeCloseTo(25, 4);
  });

  it('takes prev/new active bin from the event, never a poll diff', () => {
    // A crossing that enters and reverts inside one poll interval: the event
    // still reports both ends, which is the entire point of §6.
    const rows = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 9000, endBinId: 9000 }), signature: 'sigB' },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows[0]).toMatchObject({ prev_active_bin: 9000, new_active_bin: 9000 });
  });

  it('derives direction down when the active bin falls', () => {
    const rows = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 8127, endBinId: 8124 }), signature: 'sigC' },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows[0]!.direction).toBe('down');
  });

  it('keeps a > 2^53 raw amount exact (BN.toNumber regression)', () => {
    const huge = '10000000411680503305';
    // swapForY=false: the taker sold base (9 decimals), so the huge raw is
    // scaled by 1e9 and the decimal keeps all 20 significant digits.
    const rows = decodeLogs(
      {
        err: null,
        logs: swapLogs({ startBinId: 1, endBinId: 1, amountIn: huge, amountOut: '1', swapForY: false }),
        signature: 'sigD',
      },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows[0]!.amount_in_raw).toBe(huge);
    // The decimal is string-derived, not a float round-trip of a lost u64.
    expect(rows[0]!.amount_in).toBeCloseTo(10000000411.680504, 5);
    // Above 2^53 a Number could not have preserved this at all.
    expect(huge).not.toBe(String(Number(huge)));
  });

  it('scales amount_in by the token actually sold', () => {
    const quoteSwap = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 1, endBinId: 1, amountIn: '4200000000', swapForY: true }), signature: 'q' },
      { slot: 1, blockTime: 1, ts: 1 }, [POOL], () => DECIMALS,
    );
    const baseSwap = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 1, endBinId: 1, amountIn: '4200000000', swapForY: false }), signature: 'b' },
      { slot: 1, blockTime: 1, ts: 1 }, [POOL], () => DECIMALS,
    );
    // Same raw, different token: quote (6 dp) vs base (9 dp).
    expect(quoteSwap[0]!.amount_in).toBeCloseTo(4200, 6);
    expect(baseSwap[0]!.amount_in).toBeCloseTo(4.2, 9);
    expect(quoteSwap[0]!.amount_in_raw).toBe(baseSwap[0]!.amount_in_raw);
  });

  it('drops failed transactions: their swaps never landed', () => {
    const rows = decodeLogs(
      { err: { InstructionError: [0, 'Custom'] }, logs: swapLogs({ startBinId: 1, endBinId: 2 }), signature: 'sigE' },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows).toEqual([]);
  });

  it('ignores swaps on pools outside the configuration', () => {
    const rows = decodeLogs(
      { err: null, logs: swapLogs({ pool: OTHER_POOL, startBinId: 1, endBinId: 2 }), signature: 'sigF' },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows).toEqual([]);
  });

  it('omits bins_crossed when the event has aggregate amounts only', () => {
    const rows = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 8123, endBinId: 8126 }), signature: 'sigG' },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => DECIMALS,
    );
    expect(rows[0]!.bins_crossed).toBeUndefined();
  });

  it('does not guess token decimals on a metadata cache miss', () => {
    const rows = decodeLogs(
      { err: null, logs: swapLogs({ startBinId: 1, endBinId: 2 }), signature: 'no-meta' },
      { slot: 1, blockTime: 1, ts: 1 },
      [POOL],
      () => null,
    );
    expect(rows).toEqual([]);
  });

  it('emits nothing when the log carries no DLMM event', () => {
    expect(
      decodeLogs({ err: null, logs: ['Program log: Instruction: Transfer'], signature: 's' }, { slot: 1, blockTime: 1, ts: 1 }, [POOL], () => DECIMALS),
    ).toEqual([]);
  });
});

describe('swap stream sink', () => {
  it('bounds shutdown and drops a callback still waiting on provider indexing', async () => {
    type FetchedLogs = {
      slot: number;
      blockTime: number;
      logs: string[];
      eventInstructions: string[];
    };
    let release: ((value: FetchedLogs) => void) | undefined;
    const h = harness({
      shutdownTimeoutMs: 1,
      fetchLogs: async () => new Promise<FetchedLogs>((resolve) => { release = resolve; }),
    });
    h.stream.start();
    const notification = h.deps.notify(
      'slow-provider-index',
      12,
      ['Program log: Instruction: Swap2'],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(release).toBeTypeOf('function');

    await h.stream.close();
    release!({
      slot: 12,
      blockTime: 1756900012,
      logs: ['Program log: Instruction: Swap2'],
      eventInstructions: [eventCpiSwap({ startBinId: 2, endBinId: 3 })],
    });
    await notification;
    expect(fs.existsSync(h.file) ? readJsonl(h.file) : []).toEqual([]);
  });

  it('fetches and decodes current event-CPI swap instructions', async () => {
    const h = harness();
    h.deps.logs.set('sig-cpi', {
      slot: 301234570,
      blockTime: 1756900010,
      logs: ['Program log: Instruction: Swap2'],
      eventInstructions: [eventCpiSwap({ startBinId: 41, endBinId: 44 })],
    });
    const rows = await h.stream.handleNotification(
      { err: null, logs: ['Program log: Instruction: Swap2'], signature: 'sig-cpi' },
      301234570,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tx_signature: 'sig-cpi',
      pool: POOL,
      prev_active_bin: 41,
      new_active_bin: 44,
      block_time: 1756900010,
    });
    await h.stream.close();
  });

  it('backfills a pool-scoped notification after transient transaction-read exhaustion', async () => {
    let attempts = 0;
    const cpi = {
      slot: 12,
      blockTime: 1756900012,
      logs: ['Program log: Instruction: Swap2'],
      eventInstructions: [eventCpiSwap({ startBinId: 2, endBinId: 3 })],
    };
    const h = harness({
      fetchLogs: async (signature) => {
        if (signature === 'seed') return {
          slot: 10,
          blockTime: 1756900010,
          logs: swapLogs({ startBinId: 1, endBinId: 2 }),
        };
        attempts += 1;
        if (attempts <= 6) throw new Error('rate limited');
        return cpi;
      },
      fetchSignatures: async () => [{ slot: 12, signature: 'temporarily-missed', err: null }] as never,
    });
    await emit(h, 'seed', 10, swapLogs({ startBinId: 1, endBinId: 2 }));
    await h.stream.handleNotification(
      { err: null, logs: ['Program log: Instruction: Swap2'], signature: 'temporarily-missed' },
      12,
      POOL,
    );
    expect(attempts).toBe(7);
    expect((readJsonl(h.file) as SwapStreamRow[]).map((row) => row.tx_signature))
      .toEqual(['seed', 'temporarily-missed']);
    expect(h.gaps.at(-1)).toMatchObject({
      pool: POOL,
      from_signature: 'seed',
      to_signature: 'temporarily-missed',
      backfilled: 1,
    });
    await h.stream.close();
  });

  it('records an exact unbounded gap when the first transaction read is unavailable', async () => {
    const h = harness({ fetchLogs: async () => { throw new Error('unavailable'); } });
    await h.stream.handleNotification(
      { err: null, logs: ['Program log: Instruction: Swap2'], signature: 'first-missed' },
      12,
      POOL,
    );
    expect(h.gaps).toContainEqual(expect.objectContaining({
      pool: POOL,
      from_signature: null,
      to_signature: 'first-missed',
      to_slot: 12,
      backfilled: 0,
    }));
    await h.stream.close();
  });

  it('recovers all target-pool swaps from a finalized slot when transaction reads fail', async () => {
    let transactionAttempts = 0;
    const h = harness({
      commitment: 'finalized',
      fetchLogs: async () => {
        transactionAttempts += 1;
        throw new Error('transaction unavailable');
      },
      fetchBlock: async () => ({
        blockTime: 1756900012,
        transactions: [
          {
            signature: 'slot-target-a',
            err: null,
            logs: ['Program log: Instruction: Swap2'],
            eventInstructions: [eventCpiSwap({ startBinId: 2, endBinId: 3 })],
          },
          {
            signature: 'slot-other-pool',
            err: null,
            logs: ['Program log: Instruction: Swap2'],
            eventInstructions: [eventCpiSwap({ pool: OTHER_POOL, startBinId: 3, endBinId: 4 })],
          },
          {
            signature: 'slot-target-b',
            err: null,
            logs: ['Program log: Instruction: Swap2'],
            eventInstructions: [eventCpiSwap({ startBinId: 4, endBinId: 5 })],
          },
        ],
      }),
    });
    await h.stream.handleNotification(
      { err: null, logs: ['Program log: Instruction: Swap2'], signature: 'unavailable-notification' },
      12,
      POOL,
    );
    expect((readJsonl(h.file) as SwapStreamRow[]).map((row) => row.tx_signature))
      .toEqual(['slot-target-a', 'slot-target-b']);
    expect(transactionAttempts).toBe(1);
    expect(h.gaps).toContainEqual(expect.objectContaining({
      pool: POOL,
      to_signature: 'unavailable-notification',
      to_slot: 12,
      backfilled: 2,
      recovery_source: 'slot',
      recovery_complete: true,
    }));
    await h.stream.close();
  });

  it('appends one flushed line per swap and advances the cursor', async () => {
    const h = harness();
    const rows = await emit(h, 'sig1', 301234567, swapLogs({ startBinId: 100, endBinId: 103 }));
    expect(rows).toHaveLength(1);
    expect(readJsonl(h.file)).toHaveLength(1);
    expect(h.stream.cursor(POOL)).toEqual({ slot: 301234567, signature: 'sig1' });
    await h.stream.close();
  });

  it('never emits a row with a missing block time', async () => {
    let attempts = 0;
    const h = harness({ blockTime: async () => { attempts += 1; return null; } });
    const rows = await emit(h, 'sig-no-time', 1, swapLogs({ startBinId: 1, endBinId: 2 }));
    expect(rows).toEqual([]);
    expect(fs.existsSync(h.file) ? readJsonl(h.file) : []).toEqual([]);
    expect(attempts).toBe(3);
    expect(h.gaps[0]).toMatchObject({
      pool: POOL, to_signature: 'sig-no-time', to_slot: 1, backfilled: 0,
    });
    await h.stream.close();
  });

  it('dedupes by tx_signature so backfill overlap is free', async () => {
    const h = harness();
    const logs = swapLogs({ startBinId: 1, endBinId: 2 });
    await emit(h, 'dup', 10, logs);
    await emit(h, 'dup', 10, logs);
    await emit(h, 'other', 11, logs);
    expect(readJsonl(h.file)).toHaveLength(2);
    await h.stream.close();
  });

  it('restores its backfill cursor from an existing stream file', async () => {
    const h = harness({
      initialRows: [{
        tx_signature: 'before-restart', slot: 77, block_time: 1, ts: 1,
        pool: POOL, prev_active_bin: 1, new_active_bin: 2,
      }],
    });
    expect(h.stream.cursor(POOL)).toEqual({ slot: 77, signature: 'before-restart' });
    await emit(h, 'before-restart', 77, swapLogs({ startBinId: 1, endBinId: 2 }));
    expect(readJsonl(h.file)).toHaveLength(1);
    await h.stream.close();
  });

  it('start() subscribes to each configured pool and is idempotent', async () => {
    const h = harness();
    h.stream.start();
    expect(h.deps.subscribeCount()).toBe(1);
    expect(h.deps.subscriptionFilters()).toEqual([POOL]);
    // Idempotent: a reconnect must not stack subscriptions.
    h.stream.start();
    expect(h.deps.subscribeCount()).toBe(1);
    await h.stream.close();
  });

  it('uses one Solana mentions subscription per configured pool', async () => {
    const h = harness({ pools: [POOL, OTHER_POOL] });
    h.stream.start();
    expect(h.deps.subscribeCount()).toBe(2);
    expect(h.deps.subscriptionFilters()).toEqual([POOL, OTHER_POOL]);
    await h.stream.close();
  });

  it('serializes asynchronous callbacks so rows retain notification order', async () => {
    const h = harness({
      blockTime: async (slot) => {
        if (slot === 10) await new Promise((resolve) => setTimeout(resolve, 10));
        return slot;
      },
    });
    h.stream.start();
    const first = h.deps.notify('slow-first', 10, swapLogs({ startBinId: 1, endBinId: 2 }));
    const second = h.deps.notify('fast-second', 11, swapLogs({ startBinId: 2, endBinId: 3 }));
    await Promise.all([first, second]);
    const rows = readJsonl(h.file) as SwapStreamRow[];
    expect(rows.map((row) => row.tx_signature)).toEqual(['slow-first', 'fast-second']);
    await h.stream.close();
  });
});

describe('gap handling and backfill', () => {
  it('replays missed swaps in slot order and records the gap bounds', async () => {
    const h = harness();
    h.stream.start();
    await emit(h, 'sig-known', 100, swapLogs({ startBinId: 1, endBinId: 2 }));
    // Three swaps happened while the socket was down, delivered newest-first.
    h.deps.signatures.set(POOL, [
      { slot: 103, signature: 'sig-c' },
      { slot: 101, signature: 'sig-a' },
      { slot: 102, signature: 'sig-b' },
    ] as never);
    for (const [i, sig] of ['sig-a', 'sig-b', 'sig-c'].entries()) {
      h.deps.logs.set(sig, {
        slot: 101 + i,
        blockTime: 1756900000 + 101 + i,
        logs: swapLogs({ startBinId: 10 + i, endBinId: 11 + i }),
      });
    }

    const result = await h.stream.recover(POOL);

    expect(result.backfilled).toBe(3);
    const rows = readJsonl(h.file) as SwapStreamRow[];
    // Oldest first, after the already-known swap.
    expect(rows.map((r) => r.tx_signature)).toEqual(['sig-known', 'sig-a', 'sig-b', 'sig-c']);
    expect(rows.slice(1).map((r) => r.slot)).toEqual([101, 102, 103]);
    expect(h.gaps).toHaveLength(1);
    expect(h.gaps[0]).toMatchObject({
      kind: 'executor_stream_gap',
      pool: POOL,
      from_signature: 'sig-known',
      to_signature: 'sig-c',
      from_slot: 100,
      to_slot: 103,
      backfilled: 3,
    });
    await h.stream.close();
  });

  it('replays the gap when the socket reopens, not only on an explicit call', async () => {
    // The live path is: websocket drops → client reconnects → 'open' fires →
    // replay whatever was missed. Asserting the wired trigger, not just recover().
    const h = harness();
    await emit(h, 'sig-known', 100, swapLogs({ startBinId: 1, endBinId: 2 }));
    h.deps.signatures.set(POOL, [{ slot: 101, signature: 'sig-a' }] as never);
    h.deps.logs.set('sig-a', {
      slot: 101,
      blockTime: 1756900101,
      logs: swapLogs({ startBinId: 5, endBinId: 6 }),
    });
    h.stream.start();
    const opens = await h.deps.fireOpen();
    expect(opens).toBeGreaterThan(0);
    await h.stream.flush();
    const rows = readJsonl(h.file) as SwapStreamRow[];
    expect(rows.map((r) => r.tx_signature)).toEqual(['sig-known', 'sig-a']);
    await h.stream.close();
  });

  it('records a zero-backfill gap so verify_log can tell it from silent loss', async () => {
    const h = harness();
    const result = await h.stream.recover(POOL);
    expect(result.backfilled).toBe(0);
    expect(h.gaps[0]).toMatchObject({
      from_signature: null,
      to_signature: null,
      backfilled: 0,
    });
    await h.stream.close();
  });

  it('emits the gap line even when the signature fetch fails', async () => {
    const h = harness({
      fetchSignatures: async () => {
        throw new Error('rpc down');
      },
    });
    const result = await h.stream.recover(POOL);
    expect(result.backfilled).toBe(0);
    expect(h.gaps).toHaveLength(1);
    expect(h.gaps[0]!.backfilled).toBe(0);
    await h.stream.close();
  });

  it('skips backfill signatures whose transaction cannot be resolved', async () => {
    const h = harness();
    h.deps.signatures.set(POOL, [{ slot: 5, signature: 'ghost' }] as never);
    // No entry in h.deps.logs: getTransaction returns null (pruned/dropped).
    const result = await h.stream.recover(POOL);
    expect(result.backfilled).toBe(0);
    expect(h.gaps[0]!.backfilled).toBe(0);
    await h.stream.close();
  });

  it('orders a newest-first signature list for slot-ordered replay', () => {
    const ordered = orderForReplay([
      { slot: 9, signature: 'c' },
      { slot: 1, signature: 'a' },
      { slot: 5, signature: 'b' },
    ] as never);
    expect(ordered.map((o) => o.slot)).toEqual([1, 5, 9]);
  });

  it('recoverAll backfills every configured pool', async () => {
    const h = harness({ pools: [POOL, OTHER_POOL] });
    // A cursor per pool first: backfill is bounded by the last emitted swap,
    // so a restart with no cursor intentionally replays nothing.
    await emit(h, 'seed-p', 6, swapLogs({ startBinId: 1, endBinId: 2 }));
    await emit(
      h,
      'seed-o',
      6,
      swapLogs({ pool: OTHER_POOL, startBinId: 1, endBinId: 2 }),
    );
    h.deps.signatures.set(POOL, [{ slot: 7, signature: 'p1' }] as never);
    h.deps.logs.set('p1', { slot: 7, blockTime: 1756900007, logs: swapLogs({ startBinId: 1, endBinId: 2 }) });
    h.deps.signatures.set(OTHER_POOL, [{ slot: 8, signature: 'o1' }] as never);
    h.deps.logs.set('o1', {
      slot: 8,
      blockTime: 1756900008,
      logs: swapLogs({ pool: OTHER_POOL, startBinId: 3, endBinId: 4 }),
    });
    expect(await h.stream.recoverAll()).toBe(2);
    expect(h.gaps.map((g) => g.pool).sort()).toEqual([OTHER_POOL, POOL].sort());
    await h.stream.close();
  });

  it('pages through more than 1000 missed signatures using before + until', async () => {
    const calls: { limit: number; until?: string; before?: string }[] = [];
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      slot: 1101 - index,
      signature: `page-${index}`,
      err: null,
    }));
    const h = harness({
      fetchSignatures: async (_pool, options) => {
        calls.push(options);
        return (options.before ? [{ slot: 101, signature: 'page-last', err: null }] : firstPage) as never;
      },
      fetchLogs: async (signature) => {
        const info = [...firstPage, { slot: 101, signature: 'page-last' }]
          .find((row) => row.signature === signature)!;
        return { slot: info.slot, blockTime: info.slot, logs: [] };
      },
    });
    await emit(h, 'seed', 100, swapLogs({ startBinId: 1, endBinId: 2 }));
    const result = await h.stream.recover(POOL);
    expect(result.backfilled).toBe(0);
    expect(calls).toEqual([
      { limit: 1000, until: 'seed' },
      { limit: 1000, until: 'seed', before: 'page-999' },
    ]);
    expect(result.gap).toMatchObject({ to_signature: 'page-0', to_slot: 1101 });
    await h.stream.close();
  });

  it('replays nothing without a cursor rather than querying unbounded history', async () => {
    // No durable cursor means "we have never emitted"; paging a pool's whole
    // signature history would be both ambiguous and enormous. The gap is
    // recorded so the first cycle is visibly unbounded, not silently short.
    const h = harness();
    h.deps.signatures.set(POOL, [{ slot: 999, signature: 'ancient' }] as never);
    const result = await h.stream.recover(POOL);
    expect(result.backfilled).toBe(0);
    expect(h.gaps[0]!.from_signature).toBeNull();
    await h.stream.close();
  });
});
