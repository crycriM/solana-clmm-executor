/** Plan §8.2 — live connectivity and read verbs. Opt-in only (RUN_LIVE=1). */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PositionData, StateData } from '../../src/protocol.js';
import { finishLiveRun, liveRunnerInfo, startLiveRun, type LiveRun } from './setup.js';

const live = liveRunnerInfo();

describe.skipIf(!live.configured)('live reads', () => {
  const state: { run?: LiveRun; artifact?: string } = {};
  beforeAll(() => { state.run = startLiveRun(`liveReads-${process.env['LIVE_RUN_ID'] ?? 'x'}`); });
  afterAll(() => {
    // Safety net: guarantee an artifact + exit path even on first-failure.
    if (state.artifact === undefined) {
      void finishLiveRun(state.run!, 'failed').then((file) => { state.artifact = file; });
    }
  });

  it('reads chain state, a seeded dust position, and writes a §7 artifact', async () => {
    const run = state.run!;
    try {
      const pool = process.env['LIVE_POOL']!;
      const stateResponse = await run.client.request({ method: 'get_state', pool });
      expect(stateResponse.ok).toBe(true);
      const chain = stateResponse.data as StateData;
      expect(Number.isInteger(chain.slot)).toBe(true);
      expect(chain.balances_raw.base).toMatch(/^\d+$/);
      run.recorder.exchange({ method: 'get_state', pool }, stateResponse);

      const positionId = process.env['LIVE_POSITION_ID'] ?? 'seed-dust';
      const positionResponse = await run.client.request({ method: 'get_position', position_id: positionId });
      expect(positionResponse.ok).toBe(true);
      const position = positionResponse.data as PositionData;
      expect(position.position_id).toBe(positionId);
      run.recorder.setPosition(positionId, position);

      state.artifact = await finishLiveRun(run, 'clean');
    } finally {
      if (state.artifact === undefined) state.artifact = await finishLiveRun(run, 'failed');
    }

    const artifact = JSON.parse(fs.readFileSync(state.artifact, 'utf8')) as Record<string, unknown>;
    expect(artifact.run_id).toBeTruthy();
    expect(artifact.gateway).toBeTruthy();
    expect(artifact.connector).toBeTruthy();
    expect(artifact.network).toBeTruthy();
    expect(Array.isArray(artifact.exchanges)).toBe(true);
    expect(Array.isArray(artifact.req_seqs)).toBe(true);
    expect(artifact.cleanup).toEqual({ operations: [], final_status: 'clean' });
  });
});
