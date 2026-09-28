import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DepthSampler } from './depthSampler.js';
import { JsonlWriter, readJsonl } from './jsonl.js';

function sampler(read: (pool: string) => Promise<unknown>) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'depth-')), 'depth.jsonl');
  const s = new DepthSampler({
    pools: ['A', 'B'],
    intervalMs: 60_000,
    read,
    writer: new JsonlWriter(file),
    now: () => 1_000_000,
  });
  return { s, rows: () => readJsonl(file) };
}

describe('depth sampler', () => {
  it('writes one row per pool per tick, and a failed read as an error row', async () => {
    const { s, rows } = sampler(async (pool) => {
      if (pool === 'B') throw new RangeError('rpc down');
      return { pool, active_bin: 7 };
    });
    await s.tick();
    expect(rows()).toEqual([
      { pool: 'A', active_bin: 7 },
      { ts: 1000, pool: 'B', error: 'RangeError' },
    ]);
    s.close();
  });

  it('writes nothing once closed, even from a tick already in flight', async () => {
    let release!: () => void;
    const { s, rows } = sampler(
      (pool) => new Promise((resolve) => (release = () => resolve({ pool }))),
    );
    const inFlight = s.tick();
    s.close();
    release();
    await inFlight;
    expect(rows()).toEqual([]);
  });
});
