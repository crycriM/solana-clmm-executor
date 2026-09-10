/** Plan §8.4/§8.7 — refresh_bundle end-to-end keeper verb flow. Opt-in only (RUN_LIVE=1). */
import { describe, expect, it } from 'vitest';
import type { RefreshBundleRequest, PositionData } from '../../src/protocol.js';
import { finishLiveRun, liveRunnerInfo, startLiveRun } from './setup.js';

const live = liveRunnerInfo();

describe.skipIf(!live.configured)('refresh bundle', () => {
  it('withdraws a seeded dust position, swaps, redeposits, and restores state', async () => {
    const run = startLiveRun(`refreshBundle-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const pool = process.env['LIVE_POOL']!;
      const positionId = process.env['LIVE_POSITION_ID'] ?? 'seed-dust';
      const bidBins = (process.env['LIVE_DEPOSIT_BIN_IDS'] ?? '98,99').split(',').map(Number);
      const amounts = (process.env['LIVE_DEPOSIT_AMOUNTS'] ?? '1,1').split(',').map(Number);
      const request: RefreshBundleRequest = {
        method: 'refresh_bundle',
        withdraw_position_id: positionId,
        swap_spec: {
          in_mint: process.env['LIVE_BASE_MINT']!,
          out_mint: process.env['LIVE_QUOTE_MINT']!,
          amount: Number(process.env['LIVE_SWAP_AMOUNT'] ?? 0.01),
        },
        deposit_spec: {
          pool,
          bid_bins: bidBins,
          ask_bins: [],
          bid_amounts: amounts,
          ask_amounts: [],
        },
      };
      const before = await run.client.request({ method: 'get_position', position_id: positionId });
      run.recorder.beforeAfter(`position:${positionId}`, before.data, null);

      const response = await run.client.request(request);
      expect(response.ok).toBe(true);
      const data = response.data as { stage: string; position_id: string | null };
      expect(['deposited', 'withdrew', 'swapped']).toContain(data.stage);
      expect(data.position_id).toBeTruthy();
      run.recorder.exchange(request, response);

      // The old position must be fully gone; partial stage means reconcile
      // from chain (plan §8.9) — the test records, never retries.
      const oldGone = await run.client.request({ method: 'withdraw', position_id: positionId, bps: 1 });
      expect(oldGone.ok).toBe(false);
      run.recorder.decision(`old position ${positionId} reported ${oldGone.error} after full refresh`);

      const after = await run.client.request({
        method: 'get_position', position_id: data.position_id!,
      });
      expect(after.data ? (after.data as PositionData).position_id : undefined).toBeTruthy();
      run.recorder.setPosition(data.position_id!, after.data);
      run.recorder.beforeAfter(`position:${positionId}`, before.data, after.data);
      status = 'clean';
    } finally {
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  });
});
