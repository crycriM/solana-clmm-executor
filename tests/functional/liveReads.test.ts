/** Live connectivity and read verbs. Opt-in only (RUN_LIVE=1). */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PositionData, StateData } from '../../src/protocol.js';
import { finishLiveRun, liveReadRunnerInfo, startLiveReadRun, type LiveRun } from './setup.js';
import { readExecutorLog } from '../helpers/stdioClient.js';

const live = liveReadRunnerInfo();
const DEFAULT_SOAK_SECONDS = 30 * 60;
const DEFAULT_READ_INTERVAL_MS = 10_000;
const MINIMUM_SAMPLES = 20;
const MAX_STATE_P95_MS = 2_000;

function nonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

const soakMs = nonNegativeNumber('LIVE_READ_SOAK_SECONDS', DEFAULT_SOAK_SECONDS) * 1000;
const intervalMs = nonNegativeNumber('LIVE_READ_INTERVAL_MS', DEFAULT_READ_INTERVAL_MS);
const timeoutMs = soakMs + Math.max(120_000, MINIMUM_SAMPLES * intervalMs);

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function percentile95(values: number[]): number {
  if (values.length === 0) throw new Error('cannot calculate p95 without samples');
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

describe.skipIf(!live.configured)('live reads', () => {
  const state: { run?: LiveRun; artifact?: string } = {};
  beforeAll(() => {
    state.run = startLiveReadRun(`liveReads-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
  });
  afterAll(async () => {
    // Safety net: guarantee an artifact + exit path even on first-failure.
    if (state.artifact === undefined) {
      state.artifact = await finishLiveRun(state.run!, 'failed');
    }
  });

  it(
    'soaks monotonic live reads, including exact fees, and writes a §7 artifact',
    async () => {
      const run = state.run!;
      try {
        const pool = process.env['LIVE_POOL']!;
        const positionId = process.env['LIVE_POSITION_ID']!;
        const stateSlots: number[] = [];
        const positionSlots: number[] = [];
        const soakStarted = performance.now();
        let samples = 0;
        do {
          const stateRequest = { method: 'get_state' as const, pool };
          const stateResponse = await run.client.request(stateRequest);
          expect(stateResponse.ok).toBe(true);
          const chain = stateResponse.data as StateData;
          expect(Number.isInteger(chain.slot)).toBe(true);
          expect(chain.balances_raw.base).toMatch(/^\d+$/);
          stateSlots.push(chain.slot);
          run.recorder.exchange(stateRequest, stateResponse);

          const positionRequest = { method: 'get_position' as const, position_id: positionId };
          const positionResponse = await run.client.request(positionRequest);
          expect(positionResponse.ok).toBe(true);
          const position = positionResponse.data as PositionData;
          expect(position.position_id).toBe(positionId);
          expect(position.claimable_fee_x_raw).toMatch(/^\d+$/);
          expect(position.claimable_fee_y_raw).toMatch(/^\d+$/);
          positionSlots.push(position.slot);
          run.recorder.exchange(positionRequest, positionResponse);
          run.recorder.setPosition(positionId, position);
          samples += 1;

          const elapsed = performance.now() - soakStarted;
          if (elapsed < soakMs || samples < MINIMUM_SAMPLES) await delay(intervalMs);
        } while (performance.now() - soakStarted < soakMs || samples < MINIMUM_SAMPLES);
        const stateDurations = readExecutorLog(run.scratch.logDir)
          .filter((line) => line.kind === 'verb' && line.method === 'get_state')
          .map((line) => line.duration_ms)
          .filter((duration): duration is number => typeof duration === 'number');
        expect(stateDurations).toHaveLength(samples);
        const p95 = percentile95(stateDurations);
        const elapsedSeconds = (performance.now() - soakStarted) / 1000;
        run.recorder.decision(
          `live_read_soak elapsed_seconds=${elapsedSeconds.toFixed(3)} samples=${samples} interval_ms=${intervalMs}`,
        );
        run.recorder.decision(`executor get_state p95_ms=${p95.toFixed(3)}`);
        // The two read methods may observe adjacent RPC slots. Require each
        // method's own observations to be monotonic, not their interleaving.
        expect(stateSlots.every((slot, i) => i === 0 || slot >= stateSlots[i - 1]!)).toBe(true);
        expect(positionSlots.every((slot, i) => i === 0 || slot >= positionSlots[i - 1]!)).toBe(
          true,
        );
        expect(p95).toBeLessThan(MAX_STATE_P95_MS);

        state.artifact = await finishLiveRun(run, 'clean');
      } finally {
        if (state.artifact === undefined) state.artifact = await finishLiveRun(run, 'failed');
      }

      const artifact = JSON.parse(fs.readFileSync(state.artifact, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(artifact.run_id).toBeTruthy();
      expect(artifact.gateway).toBeTruthy();
      expect(artifact.connector).toBeTruthy();
      expect(artifact.network).toBeTruthy();
      expect(Array.isArray(artifact.exchanges)).toBe(true);
      expect(Array.isArray(artifact.req_seqs)).toBe(true);
      expect(artifact.cleanup).toEqual({ operations: [], final_status: 'clean' });
    },
    timeoutMs,
  );
});
