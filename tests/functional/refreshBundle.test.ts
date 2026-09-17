/**
 * refresh_bundle end-to-end flow. Opt-in only
 * (RUN_LIVE=1 plus RUN_LIVE_M5=1). With JITO_ENABLED=true on the executor this
 * same request exercises the bundle path and the response carries
 * `data.bundle_id` plus ordered `component_signatures`.
 */
import { describe, expect, it } from 'vitest';
import type { RefreshBundleRequest, PositionData } from '../../src/protocol.js';
import { finishLiveRun, liveM5RunnerInfo, startLiveRun } from './setup.js';

const live = liveM5RunnerInfo();

describe.skipIf(!live.configured)('refresh bundle', () => {
  it('withdraws a seeded dust position, swaps, redeposits, and restores state', async () => {
    const run = startLiveRun(`refreshBundle-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const pool = process.env['LIVE_POOL']!;
      const positionId = process.env['LIVE_POSITION_ID']!;
      const offsets = process.env['LIVE_DEPOSIT_BIN_OFFSETS']!.split(',').map(Number);
      const amounts = process.env['LIVE_DEPOSIT_AMOUNTS']!.split(',').map(Number);
      const side = process.env['LIVE_DEPOSIT_SIDE'] as 'bid' | 'ask';
      const state = await run.client.request({ method: 'get_state', pool });
      expect(state.ok).toBe(true);
      const activeBin = Number((state.data as { active_bin: number }).active_bin);
      const bins = offsets.map((offset) => activeBin + offset);
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
          expected_active_bin: activeBin,
          max_active_bin_slippage: Number(process.env['LIVE_MAX_ACTIVE_BIN_SLIPPAGE']),
          bid_bins: side === 'bid' ? bins : [],
          ask_bins: side === 'ask' ? bins : [],
          bid_amounts: side === 'bid' ? amounts : [],
          ask_amounts: side === 'ask' ? amounts : [],
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
      // from chain — the test records, never retries.
      const oldGone = await run.client.request({ method: 'withdraw', position_id: positionId, bps: 1 });
      expect(oldGone.ok).toBe(false);
      run.recorder.decision(`old position ${positionId} reported ${oldGone.error} after full refresh`);

      const after = await run.client.request({
        method: 'get_position', position_id: data.position_id!,
      });
      expect(after.data ? (after.data as PositionData).position_id : undefined).toBeTruthy();
      run.recorder.setPosition(data.position_id!, after.data);
      run.recorder.beforeAfter(`position:${positionId}`, before.data, after.data);

      // The re-deposited position is owned by this run; close it so the
      // campaign leaves no test-created exposure.
      const close = await run.client.request({
        method: 'withdraw', position_id: data.position_id!, bps: 100,
      });
      run.recorder.exchange(
        { method: 'withdraw', position_id: data.position_id!, bps: 100 }, close,
      );
      expect(close.ok).toBe(true);
      expect((close.data as { closed: boolean }).closed).toBe(true);
      expect(close.transactions[0]?.status).toBe('finalized');
      run.recorder.cleanupOperation(`withdraw 100% from ${data.position_id} (cleanup)`);
      status = 'clean';
    } finally {
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  }, 360_000);
});
