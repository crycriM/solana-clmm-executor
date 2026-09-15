/** Plan §7 components gate: SWAP_STREAM_PATH handling (spec §6). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { requestsByVerb } from '../helpers/requests.js';
import { BRIDGE_PATH, requireBuiltBridge, scratchEnv, subprocessEnv, type ScratchEnv } from '../helpers/stdioClient.js';

requireBuiltBridge();

function run(scratch: ScratchEnv, input: string): { status: number; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(process.execPath, [BRIDGE_PATH], {
    // 20s tolerates the full parallel suite's subprocess contention; a genuine
    // hang on the stream socket would still be caught well inside this bound.
    input, encoding: 'utf8', timeout: 20000, env: subprocessEnv(scratch),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

describe('swap stream file', () => {
  it('SWAP_STREAM_PATH is required configuration', () => {
    const bad = scratchEnv({ SWAP_STREAM_PATH: undefined });
    try {
      const result = run(bad, JSON.stringify(requestsByVerb.get_state) + '\n');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    } finally {
      bad.dispose();
    }
  });

  it('no decoded swap is ever fabricated: the file stays empty with no feed', () => {
    // The stream is live but the RPC in this environment delivers nothing, so
    // the file may be created yet must contain no rows. A single synthetic row
    // here would become a fake fill in verify_log.py (spec §6).
    const scratch = scratchEnv();
    try {
      run(scratch, [requestsByVerb.swap, { ...requestsByVerb.swap!, pool: '11111111111111111111111111111111' }]
        .map((r) => JSON.stringify(r)).join('\n') + '\n');
      if (fs.existsSync(scratch.swapStreamPath)) {
        const contents = fs.readFileSync(scratch.swapStreamPath, 'utf8').trim();
        expect(contents).toBe('');
      }
      expect(path.dirname(scratch.swapStreamPath).startsWith(os.tmpdir())).toBe(true);
    } finally {
      scratch.dispose();
    }
  });

  it('the bridge never writes anything but responses to stdout while streaming', () => {
    // The stream shares the process with the verb loop (spec §2). Any stray
    // write from it corrupts the protocol channel.
    const scratch = scratchEnv();
    try {
      const result = run(scratch, JSON.stringify(requestsByVerb.get_state) + '\n');
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      // Exactly one envelope, and it parses: no log line leaked onto stdout.
      const response = JSON.parse(lines[0]!);
      expect(response).toHaveProperty('ok');
      expect(response).toHaveProperty('error');
      expect(result.stderr).not.toMatch(/^\{"/);
    } finally {
      scratch.dispose();
    }
  });

  it('containment: a stream that cannot start still serves the verb loop', () => {
    // An unwritable stream path must not take the executor down with it; the
    // failure is reported on stderr instead (spec §6: the missing feed makes
    // verify_log.py fail closed, which is visible without a crash).
    const scratch = scratchEnv({ SWAP_STREAM_PATH: '/dev/null/unwritable/swaps.jsonl' });
    try {
      const result = run(scratch, JSON.stringify(requestsByVerb.get_state) + '\n');
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toHaveProperty('ok');
      expect(result.stderr).toMatch(/swap stream unavailable/);
    } finally {
      scratch.dispose();
    }
  });

  it('terminates when stdin closes instead of hanging on the stream socket', () => {
    // The stream's RPC websocket holds timers and handles; if they outlive the
    // verb loop the executor never exits and ExecBridge never sees the restart
    // it relies on (spec §2).
    const scratch = scratchEnv();
    try {
      const result = run(scratch, JSON.stringify(requestsByVerb.get_state) + '\n');
      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
    } finally {
      scratch.dispose();
    }
  });
});
