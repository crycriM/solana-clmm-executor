/**
 * Non-mutating M4 baseline for the wallet/position already configured for M2/M3.
 * It intentionally does not require a signer, a key file, or write confirmation.
 */
import { describe, expect, it } from 'vitest';
import type { PositionData, StateData } from '../../src/protocol.js';
import { finishLiveRun, liveReadRunnerInfo, startLiveReadRun } from './setup.js';

const live = liveReadRunnerInfo();

describe.skipIf(!live.configured)('existing wallet position readback', () => {
  it('reads the configured owned position with exact raw bin quantities and no mutations', async () => {
    const run = startLiveReadRun(`m4-existing-position-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const pool = process.env['LIVE_POOL']!;
      const positionId = process.env['LIVE_POSITION_ID']!;
      const [stateResponse, positionResponse] = await Promise.all([
        run.client.request({ method: 'get_state', pool }),
        run.client.request({ method: 'get_position', position_id: positionId }),
      ]);
      expect(stateResponse.ok).toBe(true);
      expect(positionResponse.ok).toBe(true);
      const state = stateResponse.data as StateData;
      const position = positionResponse.data as PositionData;
      expect(position.position_id).toBe(positionId);
      expect(position.pool).toBe(pool);
      expect(position.owner).toBe(process.env['WALLET_PUBKEY']);
      expect(position.bins.length).toBeGreaterThan(0);
      expect(position.bins.every((bin) => (
        Number.isSafeInteger(bin.bin_id) &&
        bin.bin_id >= position.min_bin_id && bin.bin_id <= position.max_bin_id &&
        /^\d+$/.test(bin.amount_base_raw) && /^\d+$/.test(bin.amount_quote_raw)
      ))).toBe(true);
      expect(new Set(position.bins.map((bin) => bin.bin_id)).size).toBe(position.bins.length);
      expect(Number.isInteger(state.active_bin)).toBe(true);
      run.recorder.exchange({ method: 'get_state', pool }, stateResponse);
      run.recorder.exchange({ method: 'get_position', position_id: positionId }, positionResponse);
      run.recorder.setPosition(positionId, position);
      run.recorder.decision('M4 existing-position baseline: read-only; no signer or write verb invoked');
      status = 'clean';
    } finally {
      await finishLiveRun(run, status);
    }
  });
});
