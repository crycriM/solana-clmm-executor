/**
 * Read-only pool-depth sampler: every interval, append each allow-listed
 * pool's reserves around the active bin (`MeteoraReads.getDepth`) to a JSONL
 * file next to the swap capture. dlmm-bot's ping-pong soak turns these into
 * the active-bin depth its in-bin fee share needs.
 *
 * A failed read is written as an `error` row rather than raised, so gaps in
 * the series are visible in the file itself and never stop the bridge.
 */

import type { JsonlWriter } from './jsonl.js';

/** Liquidity is read for the active bin and this many bins either side. */
export const DEPTH_BINS_EACH_SIDE = 5;

export class DepthSampler {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private closed = false;

  constructor(
    private readonly options: {
      pools: string[];
      intervalMs: number;
      read: (pool: string) => Promise<unknown>;
      writer: JsonlWriter;
      now?: () => number;
    },
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  /** One sample of every pool; a tick still running when the next fires is skipped. */
  async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (const pool of this.options.pools) {
        let row: unknown;
        try {
          row = await this.options.read(pool);
        } catch (error) {
          row = {
            ts: (this.options.now ?? Date.now)() / 1000,
            pool,
            error: error instanceof Error ? error.name : 'Error',
          };
        }
        if (this.closed) return;
        this.options.writer.append(row);
      }
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.options.writer.close();
  }
}
