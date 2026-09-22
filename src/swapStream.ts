/**
 * Decoded Meteora swap stream.
 *
 * Subscribes to configured pool logs, decodes DLMM swap events, and appends one JSON
 * line per swap to `SWAP_STREAM_PATH`, where
 * `dlmm_bot.swap_observer.JsonlSwapEventSource` tails it. Read-only: this
 * module never signs and never writes on-chain.
 *
 * Three properties the downstream verifier depends on:
 *
 * - `prev_active_bin`/`new_active_bin` come from the decoded event's
 *   `startBinId`/`endBinId`, never from polling `getActiveBin` — a crossing that
 *   enters and reverts inside one poll interval is the entire reason this feed
 * exists.
 * - `tx_signature` is the real signature, always; nothing is synthesized.
 * - Rows are synchronously flushed before stream processing advances.
 *
 * Gap handling: on reconnect, missed signatures are backfilled from
 * `getSignaturesForAddress` and replayed in slot order before the live tail
 * resumes. The observer dedupes by signature, so overlap is free; a gap is not,
 * so every gap also emits an `executor_stream_gap` line (§7) with its bounds.
 */

import * as web3 from '@solana/web3.js';
import type { Connection, ConfirmedSignatureInfo, Finality, Logs, PublicKey } from '@solana/web3.js';
import { JsonlWriter, readJsonl } from './jsonl.js';
import type { DecodedSwapEvent } from './events.js';
import { decodeTransactionEvents } from './events.js';
import { decodeLogs, orderForReplay } from './swapRows.js';
import { withRetry } from './vendor/lp-monitor/meteoraReads.js';
import {
  forceDisconnect,
  offSocketOpen,
  onSocketOpen,
  rpcSocket,
  type SocketLike,
} from './socketTeardown.js';
import type { SwapStreamRow } from './protocol.js';

export { decodeLogs, orderForReplay } from './swapRows.js';
export type { PoolDecimals } from './swapRows.js';

/** Meteora DLMM program id (mainnet-beta; devnet shares this address). */
export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

export interface SwapStreamLog {
  write(line: ExecutorStreamGapInput): void;
}

/** The subset of the §7 gap line the stream produces. */
export interface ExecutorStreamGapInput {
  kind: 'executor_stream_gap';
  ts: number;
  pool: string;
  from_signature: string | null;
  to_signature: string | null;
  from_slot: number | null;
  to_slot: number | null;
  backfilled: number;
  recovery_source?: 'slot' | 'history' | 'none';
  recovery_complete?: boolean;
}

/** Everything the stream needs from its host; tests inject all of it. */
export interface SwapStreamDeps {
  connection: Connection;
  /** Writes one row per line. */
  writer: Pick<JsonlWriter, 'append' | 'path'> & Partial<Pick<JsonlWriter, 'close'>>;
  /** §7 executor JSONL, for `executor_stream_gap` lines. */
  log: SwapStreamLog;
  /** Pools subscribed, decoded, and emitted. */
  pools: readonly string[];
  /** Mint decimals by pool, for decimal/raw conversion. */
  decimals?: (pool: string) => { base: number; quote: number } | null;
  /** Wall clock, injectable. */
  now?: () => number;
  /** Subscription/transaction commitment; defaults to confirmed. */
  commitment?: Finality;
  /** Pause between retries, injectable so tests stay fast. */
  retryDelayMs?: number;
  /** Bound graceful unsubscribe/queue drain so subprocess shutdown cannot hang. */
  shutdownTimeoutMs?: number;
  /** Surface asynchronous callback failures without corrupting stdout. */
  reportError?: (detail: string) => void;
  /** Resolve a slot to a block time; the live path uses getBlockTime. */
  blockTime?: (slot: number) => Promise<number | null>;
  /** Fetch transaction log messages for a signature (backfill + block time). */
  fetchLogs?: (
    signature: string,
  ) => Promise<{
    slot: number;
    blockTime: number | null;
    logs: string[];
    eventInstructions?: string[];
  } | null>;
  /** Fetch every transaction in one slot for last-resort gap recovery. */
  fetchBlock?: (
    slot: number,
  ) => Promise<{
    blockTime: number | null;
    transactions: {
      signature: string;
      err: unknown;
      logs: string[];
      eventInstructions?: string[];
    }[];
  } | null>;
  /** List signatures for a pool, newest first (backfill). */
  fetchSignatures?: (
    pool: string,
    options: { limit: number; until?: string; before?: string },
  ) => Promise<ConfirmedSignatureInfo[]>;
}

/** Last emitted position per pool; the backfill cursor. */
export interface StreamCursor {
  slot: number;
  signature: string;
}

export class SwapStreamError extends Error {}


/**
 * Live swap stream with reconnect backfill.
 *
 * `start()` registers the subscription; `close()` drains queued processing and
 * closes the sink. A WebSocket reopen automatically queues `recoverAll()`
 * before later live callbacks; tests can also call `recover()` directly.
 */
export class SwapStream {
  private readonly connection: Connection;
  private readonly writer: Pick<JsonlWriter, 'append' | 'path'> & Partial<Pick<JsonlWriter, 'close'>>;
  private readonly log: SwapStreamLog;
  private readonly pools: readonly string[];
  private readonly decimalsOf: (pool: string) => { base: number; quote: number } | null;
  private readonly now: () => number;
  private readonly commitment: Finality;
  private readonly retryDelayMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly reportError: (detail: string) => void;
  private readonly blockTimeOf: (slot: number) => Promise<number | null>;
  private readonly logsOf: (
    signature: string,
  ) => Promise<{
    slot: number;
    blockTime: number | null;
    logs: string[];
    eventInstructions?: string[];
  } | null>;
  private readonly signaturesOf: (
    pool: string,
    options: { limit: number; until?: string; before?: string },
  ) => Promise<ConfirmedSignatureInfo[]>;
  private readonly blockOf: NonNullable<SwapStreamDeps['fetchBlock']>;

  private readonly subscriptions: number[] = [];
  private readonly cursors = new Map<string, StreamCursor>();
  private readonly seen = new Map<string, Set<string>>();
  private queue: Promise<void> = Promise.resolve();
  private openedOnce = false;
  private socket: SocketLike | null = null;
  private readonly onSocketOpen = (): void => {
    if (this.closed) return;
    if (!this.openedOnce) {
      this.openedOnce = true;
      if (this.cursors.size === 0) return;
    }
    this.enqueue(async () => {
      await this.recoverAll();
    });
  };
  private closed = false;

  constructor(deps: SwapStreamDeps) {
    this.connection = deps.connection;
    this.writer = deps.writer;
    this.log = deps.log;
    this.pools = [...deps.pools];
    this.decimalsOf = deps.decimals ?? (() => null);
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.commitment = deps.commitment ?? 'confirmed';
    this.retryDelayMs = deps.retryDelayMs ?? 1000;
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 2_000;
    this.reportError = deps.reportError ?? (() => undefined);
    this.blockTimeOf =
      deps.blockTime ?? ((slot) => this.connection.getBlockTime(slot));
    this.logsOf =
      deps.fetchLogs ??
      (async (signature) => {
        const tx = await this.connection.getParsedTransaction(signature, {
          commitment: this.commitment,
          maxSupportedTransactionVersion: 1,
        });
        if (tx === null) return null;
        return {
          slot: tx.slot,
          blockTime: tx.blockTime ?? null,
          logs: tx.meta?.logMessages ?? [],
          eventInstructions: (tx.meta?.innerInstructions ?? [])
            .flatMap((group) => group.instructions)
            .filter(
              (instruction) =>
                'programId' in instruction &&
                'data' in instruction &&
                instruction.programId.toBase58() === DLMM_PROGRAM_ID,
            )
            .map((instruction) => (instruction as { data: string }).data),
        };
      });
    this.signaturesOf =
      deps.fetchSignatures ??
      ((pool, options) =>
        this.connection.getSignaturesForAddress(newPublicKey(pool), options as never));
    this.blockOf =
      deps.fetchBlock ??
      (async (slot) => {
        const block = await this.connection.getParsedBlock(slot, {
          commitment: this.commitment,
          maxSupportedTransactionVersion: 1,
          transactionDetails: 'full',
          rewards: false,
        });
        if (block === null) return null;
        return {
          blockTime: block.blockTime ?? null,
          transactions: block.transactions.map((item) => ({
            signature: item.transaction.signatures[0]!,
            err: item.meta?.err ?? null,
            logs: item.meta?.logMessages ?? [],
            eventInstructions: (item.meta?.innerInstructions ?? [])
              .flatMap((group) => group.instructions)
              .filter(
                (instruction) =>
                  'data' in instruction &&
                  instruction.programId.toBase58() === DLMM_PROGRAM_ID,
              )
              .map((instruction) => (instruction as { data: string }).data),
          })),
        };
      });
    for (const pool of this.pools) {
      if (this.decimalsOf(pool) === null) {
        throw new SwapStreamError(`token decimals unavailable for pool ${pool}`);
      }
    }
    this.restoreCursors();
  }

  get path(): string {
    return this.writer.path;
  }

  cursor(pool: string): StreamCursor | undefined {
    return this.cursors.get(pool);
  }

  /** Resume from the last complete rows already on disk after process restart. */
  private restoreCursors(): void {
    let rows: unknown[];
    try {
      rows = readJsonl(this.writer.path);
    } catch (error) {
      throw new SwapStreamError(
        `cannot read existing swap stream: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const value of rows) {
      if (value === null || typeof value !== 'object') continue;
      const row = value as Partial<SwapStreamRow>;
      if (
        typeof row.pool !== 'string' ||
        !this.pools.includes(row.pool) ||
        typeof row.tx_signature !== 'string' ||
        !Number.isSafeInteger(row.slot)
      ) continue;
      this.remember(row.pool, row.tx_signature);
      const cursor = this.cursors.get(row.pool);
      if (!cursor || row.slot! >= cursor.slot) {
        this.cursors.set(row.pool, { slot: row.slot!, signature: row.tx_signature });
      }
    }
  }

  /** Bound replay-dedupe memory while keeping a generous reconnect overlap. */
  private remember(pool: string, signature: string): void {
    let known = this.seen.get(pool);
    if (known === undefined) {
      known = new Set();
      this.seen.set(pool, known);
    }
    known.add(signature);
    if (known.size > 4096) known.delete(known.values().next().value as string);
  }

  /** Serialize live callbacks and reconnect replays in their arrival order. */
  private enqueue(work: () => Promise<unknown>): void {
    if (this.closed) return;
    this.queue = this.queue
      .then(async () => { await work(); })
      .catch((error: unknown) => {
        this.reportError(error instanceof Error ? error.message : String(error));
      });
  }

  /** Exposed for deterministic shutdown and tests. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Watch for socket reconnects; each one triggers a gap replay. */
  private attachReconnectListener(): void {
    if (this.socket !== null) return;
    this.socket = rpcSocket(this.connection);
    if (this.socket === null) return;
    onSocketOpen(this.connection, this.onSocketOpen);
  }

  /**
   * Subscribe once per configured pool. Idempotent.
   *
   * Solana's mentions filter accepts one public key. Watching the program
   * itself would require a transaction fetch for every DLMM swap on mainnet
   * because current Meteora events are delivered through event-CPI. Pool
   * subscriptions keep that read load bounded while the decoder still accepts
   * events only from the DLMM program and filters every row by lbPair.
   */
  start(): void {
    if (this.closed) throw new SwapStreamError('swap stream is closed');
    if (this.subscriptions.length > 0) return;
    this.attachReconnectListener();
    for (const pool of this.pools) {
      this.subscriptions.push(
        this.connection.onLogs(
          newPublicKey(pool),
          (notification, ctx) => {
            this.enqueue(() => this.handleNotification(notification, ctx.slot, pool));
          },
          this.commitment,
        ),
      );
    }
  }

  /**
   * Unsubscribe and drop the backing websocket.
   *
   * `removeOnLogsListener` alone is not enough. `Connection` reconnects its RPC
   * websocket implicitly whenever the socket closes with subscriptions still
   * registered; against a dead endpoint that becomes an endless reconnect loop
   * whose timers and socket handles pin the event loop. The process then never
   * exits when stdin closes, and the keeper's `ExecBridge` never sees the
   * restart it relies on.
   *
   * So teardown empties the subscription registry, stops the client's own
   * reconnect timer, and drops the socket — in that order. Every step is
   * best-effort and reaches into `Connection`/`ws` internals to do it, which is
   * a real liability across library upgrades; it is contained to this method,
   * fails open, and the CLI-level exit in `bridge.ts` is the backstop that
   * guarantees the process still terminates.
   */
  async stop(): Promise<void> {
    const subscriptions = this.subscriptions.splice(0);
    const removals = Promise.all(subscriptions.map(async (subscription) => {
      try {
        await this.connection.removeOnLogsListener(subscription);
      } catch {
        // A socket that never connected rejects here; teardown continues.
      }
    }));
    // Providers are not trusted to acknowledge unsubscribe. Since close()
    // already marked the stream closed, callbacks arriving here are ignored.
    await settleWithin(removals, this.shutdownTimeoutMs);
    offSocketOpen(this.connection, this.onSocketOpen);
    forceDisconnect(this.connection);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
    const drained = await settleWithin(this.flush(), this.shutdownTimeoutMs);
    if (!drained) this.reportError('swap stream shutdown abandoned pending recovery');
    this.writer.close?.();
  }

  /**
   * Handle one log notification: decode, resolve block time, append, advance.
   *
   * `block_time` is resolved before the row is written and is never null.
   * A signature whose time cannot be resolved is held out rather than emitted
   * with a placeholder, and an operational gap is recorded with its bounds.
   */
  async handleNotification(
    notification: Pick<Logs, 'err' | 'logs' | 'signature'>,
    slot: number,
    subscribedPool?: string,
  ): Promise<SwapStreamRow[]> {
    if (this.closed) return [];
    if (notification.err) return [];
    let logs = notification.logs;
    let eventInstructions: string[] = [];
    let effectiveSlot = slot;
    let transactionBlockTime: number | null = null;
    let events = decodeTransactionEvents(logs);
    let affected = new Set(
      events
        .filter((event): event is DecodedSwapEvent => event.name === 'Swap')
        .map((event) => event.lbPair.toBase58())
        .filter((pool) => this.pools.includes(pool)),
    );

    // Current Meteora uses Anchor event-CPI, so the event is an inner
    // instruction rather than a `Program data:` log. Fetch only transactions
    // whose logs identify a swap; this avoids one RPC read for every DLMM call.
    if (affected.size === 0 && logs.some((line) => line.includes('Instruction: Swap'))) {
      let tx: Awaited<ReturnType<typeof this.logsOf>> = null;
      try {
        tx = await withRetry(async () => {
          const value = await this.logsOf(notification.signature);
          if (value === null) throw new SwapStreamError('transaction unavailable');
          return value;
        }, this.commitment === 'finalized' ? 1 : 6, this.retryDelayMs);
      } catch {
        if (this.closed) return [];
        this.reportError(`live transaction unavailable for ${notification.signature}`);
        const slotBackfill = await this.recoverSlot(subscribedPool, slot, notification.signature);
        if (slotBackfill !== null) return [];
        // The notification itself proves a potentially relevant transaction
        // existed. If a durable cursor is available, immediately replay the
        // pool history so a transient HTTP 429 cannot become silent loss. The
        // recovery path always writes executor_stream_gap with its bounds and
        // backfilled count. Before the first emitted row there is no bounded
        // history cursor, so record the exact failed notification directly.
        if (subscribedPool && this.cursors.has(subscribedPool)) {
          await this.recover(subscribedPool);
        } else {
          for (const pool of subscribedPool ? [subscribedPool] : this.pools) {
            const cursor = this.cursors.get(pool);
            this.log.write({
              kind: 'executor_stream_gap',
              ts: this.now(),
              pool,
              from_signature: cursor?.signature ?? null,
              to_signature: notification.signature,
              from_slot: cursor?.slot ?? null,
              to_slot: slot,
              backfilled: 0,
              recovery_source: 'none',
              recovery_complete: false,
            });
          }
        }
        return [];
      }
      logs = tx.logs;
      eventInstructions = tx.eventInstructions ?? [];
      effectiveSlot = tx.slot;
      transactionBlockTime = tx.blockTime;
      events = decodeTransactionEvents(logs, eventInstructions);
      affected = new Set(
        events
          .filter((event): event is DecodedSwapEvent => event.name === 'Swap')
          .map((event) => event.lbPair.toBase58())
          .filter((pool) => this.pools.includes(pool)),
      );
    }
    if (affected.size === 0) return [];
    const ts = this.now();
    const blockTime = transactionBlockTime ?? (await this.resolveBlockTime(effectiveSlot));
    if (blockTime === null) {
      for (const pool of affected) {
        const cursor = this.cursors.get(pool);
        this.log.write({
          kind: 'executor_stream_gap',
          ts,
          pool,
          from_signature: cursor?.signature ?? null,
          to_signature: notification.signature,
          from_slot: cursor?.slot ?? null,
          to_slot: effectiveSlot,
          backfilled: 0,
        });
      }
      this.reportError(`block time unavailable for slot ${effectiveSlot}`);
      return [];
    }
    const rows = decodeLogs(
      { err: null, logs, signature: notification.signature },
      { slot: effectiveSlot, blockTime, ts },
      this.pools,
      this.decimalsOf,
      eventInstructions,
    );
    return this.emit(rows);
  }

  /**
   * Last-resort recovery for a known notification slot.
   *
   * Finalized blocks can remain available when an individual transaction or
   * address-history lookup is rate-limited. One block read costs the same 40
   * Alchemy CU as getTransaction and may recover several swaps at once.
   * Returns null only when the block itself could not be read.
   */
  private async recoverSlot(
    pool: string | undefined,
    slot: number,
    notificationSignature: string,
  ): Promise<number | null> {
    if (!pool) return null;
    const from = this.cursors.get(pool) ?? null;
    let block: Awaited<ReturnType<typeof this.blockOf>> = null;
    try {
      block = await withRetry(async () => {
        const value = await this.blockOf(slot);
        if (value === null) throw new SwapStreamError('block unavailable');
        return value;
      }, 3, this.retryDelayMs);
    } catch {
      this.reportError(`slot backfill failed for pool ${pool} at slot ${slot}`);
      return null;
    }
    const blockTime = block.blockTime ?? (await this.resolveBlockTime(slot));
    let backfilled = 0;
    const recoveryComplete = blockTime !== null;
    if (recoveryComplete) {
      for (const tx of block.transactions) {
        backfilled += this.emit(decodeLogs(
          { err: tx.err as never, logs: tx.logs, signature: tx.signature },
          { slot, blockTime, ts: this.now() },
          [pool],
          this.decimalsOf,
          tx.eventInstructions ?? [],
        )).length;
      }
    }
    this.log.write({
      kind: 'executor_stream_gap',
      ts: this.now(),
      pool,
      from_signature: from?.signature ?? null,
      to_signature: notificationSignature,
      from_slot: from?.slot ?? null,
      to_slot: slot,
      backfilled,
      recovery_source: 'slot',
      recovery_complete: recoveryComplete,
    });
    return backfilled;
  }

  /**
   * Append rows and advance the per-pool cursor.
   *
   * Dedupe is by signature, so a backfill that overlaps the live tail is free
   * — the second copy is dropped here rather than downstream.
   */
  private emit(rows: readonly SwapStreamRow[]): SwapStreamRow[] {
    if (this.closed) return [];
    const emitted: SwapStreamRow[] = [];
    for (const row of rows) {
      let known = this.seen.get(row.pool);
      if (known === undefined) {
        known = new Set();
        this.seen.set(row.pool, known);
      }
      if (known.has(row.tx_signature)) continue;
      this.writer.append(row);
      this.remember(row.pool, row.tx_signature);
      const cursor = this.cursors.get(row.pool);
      if (!cursor || row.slot >= cursor.slot) {
        this.cursors.set(row.pool, { slot: row.slot, signature: row.tx_signature });
      }
      emitted.push(row);
    }
    return emitted;
  }

  private async resolveBlockTime(slot: number): Promise<number | null> {
    try {
      return await withRetry(async () => {
        const blockTime = await this.blockTimeOf(slot);
        if (blockTime === null) throw new SwapStreamError(`block time unavailable for slot ${slot}`);
        return blockTime;
      }, 3, this.retryDelayMs);
    } catch {
      return null;
    }
  }

  /** Fetch every page newer than `until`, not merely the newest 1000 rows. */
  private async missedSignatures(pool: string, until?: string): Promise<ConfirmedSignatureInfo[]> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      if (this.closed) break;
      const page = await withRetry(
        () => this.signaturesOf(pool, {
          limit: 1000,
          ...(until === undefined ? {} : { until }),
          ...(before === undefined ? {} : { before }),
        }),
        3,
        this.retryDelayMs,
      );
      all.push(...page);
      if (page.length < 1000) break;
      const next = page.at(-1)?.signature;
      if (!next || next === before) break;
      before = next;
    }
    return all;
  }

  /**
   * Replay missed swaps for one pool, oldest first, then resume.
   *
   * Signatures are fetched newest-first and replayed in slot order. The gap
   * line is emitted whether or not anything was found: a gap with zero
   * backfilled swaps distinguishes an empty recovery from silent loss.
   */
  async recover(pool: string): Promise<{ backfilled: number; gap: ExecutorStreamGapInput }> {
    const cursor = this.cursors.get(pool);
    const from = cursor ?? null;
    let signatures: ConfirmedSignatureInfo[] = [];
    let recoveryComplete = true;
    try {
      // With no durable cursor, starting from "now" is intentional; querying
      // an unbounded account history would be both ambiguous and enormous.
      signatures = from === null ? [] : await this.missedSignatures(pool, from.signature);
    } catch {
      this.reportError(`signature backfill failed for pool ${pool}`);
      recoveryComplete = false;
      signatures = [];
    }
    const ordered = orderForReplay(signatures).filter(
      (info) =>
        from === null ||
        info.slot > from.slot ||
        (info.slot === from.slot && info.signature !== from.signature),
    );
    const newestInfo = ordered.at(-1);

    let backfilled = 0;
    let newest: StreamCursor | null = null;
    for (const info of ordered) {
      if (this.closed) {
        recoveryComplete = false;
        break;
      }
      let tx: Awaited<ReturnType<typeof this.logsOf>> = null;
      try {
        tx = await withRetry(async () => {
          const value = await this.logsOf(info.signature);
          if (value === null) throw new SwapStreamError('transaction unavailable');
          return value;
        }, 3, this.retryDelayMs);
      } catch {
        this.reportError(`transaction backfill failed for ${info.signature}`);
        recoveryComplete = false;
        tx = null;
      }
      if (tx === null) continue;
      const blockTime = tx.blockTime ?? (await this.resolveBlockTime(tx.slot));
      if (blockTime === null) {
        this.reportError(`block time unavailable for backfill slot ${tx.slot}`);
        recoveryComplete = false;
        continue;
      }
      const rows = decodeLogs(
        { err: info.err ?? null, logs: tx.logs, signature: info.signature },
        { slot: tx.slot, blockTime, ts: this.now() },
        this.pools,
        this.decimalsOf,
        tx.eventInstructions ?? [],
      );
      backfilled += this.emit(rows).length;
      if (newest === null || tx.slot >= newest.slot) {
        newest = { slot: tx.slot, signature: info.signature };
      }
    }

    const gap: ExecutorStreamGapInput = {
      kind: 'executor_stream_gap',
      ts: this.now(),
      pool,
      from_signature: from?.signature ?? null,
      to_signature: newestInfo?.signature ?? newest?.signature ?? from?.signature ?? null,
      from_slot: from?.slot ?? null,
      to_slot: newestInfo?.slot ?? newest?.slot ?? from?.slot ?? null,
      backfilled,
      recovery_source: 'history',
      recovery_complete: recoveryComplete,
    };
    this.log.write(gap);
    return { backfilled, gap };
  }

  /** Backfill every configured pool; called at startup and after a reconnect. */
  async recoverAll(): Promise<number> {
    let total = 0;
    for (const pool of this.pools) {
      if (this.closed) break;
      total += (await this.recover(pool)).backfilled;
    }
    return total;
  }
}

/** Resolve false at the deadline while permanently observing late rejection. */
async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(() => true, () => true);
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function newPublicKey(value: string): PublicKey {
  return new web3.PublicKey(value);
}
