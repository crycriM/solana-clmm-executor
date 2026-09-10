/** Plan §8.2 — live connectivity and read verbs. Opt-in only (RUN_LIVE=1). */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PositionData, StateData } from '../../src/protocol.js';
import {
  finishLiveRun,
  liveReadRunnerInfo,
  startLiveReadRun,
  type LiveRun,
} from './setup.js';

const live = liveReadRunnerInfo();

describe.skipIf(!live.configured)('live reads', () => {
  const state: { run?: LiveRun; artifact?: string } = {};
  beforeAll(() => { state.run = startLiveReadRun(`liveReads-${process.env['LIVE_RUN_ID'] ?? 'x'}`); });
  afterAll(async () => {
    // Safety net: guarantee an artifact + exit path even on first-failure.
    if (state.artifact === undefined) {
      state.artifact = await finishLiveRun(state.run!, 'failed');
    }
  });

  it('performs 20 monotonic live reads, including exact fees, and writes a §7 artifact', async () => {
    const run = state.run!;
    try {
      const pool = process.env['LIVE_POOL']!;
      const positionId = process.env['LIVE_POSITION_ID']!;
      const slots: number[] = [];
      const stateDurations: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        const stateRequest = { method: 'get_state' as const, pool };
        const stateResponse = await run.client.request(stateRequest);
        stateDurations.push(performance.now() - started);
        expect(stateResponse.ok).toBe(true);
        const chain = stateResponse.data as StateData;
        expect(Number.isInteger(chain.slot)).toBe(true);
        expect(chain.balances_raw.base).toMatch(/^\d+$/);
        slots.push(chain.slot);
        run.recorder.exchange(stateRequest, stateResponse);

        const positionRequest = { method: 'get_position' as const, position_id: positionId };
        const positionResponse = await run.client.request(positionRequest);
        expect(positionResponse.ok).toBe(true);
        const position = positionResponse.data as PositionData;
        expect(position.position_id).toBe(positionId);
        expect(position.claimable_fee_x_raw).toMatch(/^\d+$/);
        expect(position.claimable_fee_y_raw).toMatch(/^\d+$/);
        slots.push(position.slot);
        run.recorder.exchange(positionRequest, positionResponse);
        run.recorder.setPosition(positionId, position);
      }
      expect(slots.every((slot, i) => i === 0 || slot >= slots[i - 1]!)).toBe(true);
      stateDurations.sort((a, b) => a - b);
      const p95 = stateDurations[Math.ceil(stateDurations.length * 0.95) - 1]!;
      run.recorder.decision(`get_state p95_ms=${p95.toFixed(3)}`);
      expect(p95).toBeLessThan(400);

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
