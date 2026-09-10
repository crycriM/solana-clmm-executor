/** Plan §8.2 stream half — live swap stream completeness (spec §6). Opt-in only (RUN_LIVE=1). */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SwapStreamRow } from '../../src/protocol.js';
import { finishLiveRun, liveReadRunnerInfo, startLiveReadRun } from './setup.js';

const live = liveReadRunnerInfo();

function rows(path: string): SwapStreamRow[] {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SwapStreamRow);
}

describe.skipIf(!live.configured)('live swap stream', () => {
  it('tails the configured pool and appends well-formed rows', async () => {
    const run = startLiveReadRun(`swapStream-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const pool = process.env['LIVE_POOL']!;
      // A successful request proves the production subprocess completed pool
      // metadata warm-up and reached its stdio loop before the observation
      // window starts. Otherwise a startup failure is indistinguishable from
      // an inactive pool when all we inspect is an empty stream file.
      const stateRequest = { method: 'get_state' as const, pool };
      const stateResponse = await run.client.request(stateRequest);
      run.recorder.exchange(stateRequest, stateResponse);
      expect(stateResponse.ok, 'production bridge failed its readiness read').toBe(true);
      // The stream starts with the bridge; give it a window to observe swaps.
      const windowMs = Number(process.env['LIVE_STREAM_WINDOW_MS'] ?? 60_000);
      await new Promise((resolve) => setTimeout(resolve, windowMs));

      const observed = rows(run.scratch.swapStreamPath);
      run.recorder.decision(`observed ${observed.length} swap rows in ${windowMs}ms`);
      expect(observed.length, 'busy-pool window produced no swaps').toBeGreaterThan(0);

      for (const row of observed) {
        // Spec §6 invariants, checked against live data rather than fixtures.
        expect(row.tx_signature).toBeTruthy();
        expect(Number.isSafeInteger(row.slot)).toBe(true);
        expect(Number.isSafeInteger(row.block_time)).toBe(true);
        expect(row.pool).toBe(pool);
        expect(Number.isSafeInteger(row.prev_active_bin)).toBe(true);
        expect(Number.isSafeInteger(row.new_active_bin)).toBe(true);
        for (const key of ['amount_in_raw', 'amount_out_raw'] as const) {
          const value = row[key];
          if (value !== undefined) expect(value).toMatch(/^\d+$/);
        }
      }
      // Slot ordering is what the backfill and the observer both rely on.
      const slots = observed.map((r) => r.slot);
      expect(slots).toEqual([...slots].sort((a, b) => a - b));

      status = 'clean';
    } finally {
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  });
});
