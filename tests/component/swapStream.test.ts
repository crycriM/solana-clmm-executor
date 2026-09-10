/** Plan §7 components gate: SWAP_STREAM_PATH handling. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { requestsByVerb } from '../helpers/requests.js';
import { BRIDGE_PATH, requireBuiltBridge, scratchEnv, subprocessEnv, type ScratchEnv } from '../helpers/stdioClient.js';

requireBuiltBridge();

function run(scratch: ScratchEnv, input: string): { status: number; stdout: string } {
  const result = spawnSync(process.execPath, [BRIDGE_PATH], {
    input, encoding: 'utf8', timeout: 10000, env: subprocessEnv(scratch),
  });
  return { status: result.status ?? -1, stdout: result.stdout };
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

  it('dry-run stub never synthesizes swap events on disk', () => {
    const scratch = scratchEnv();
    try {
      run(scratch, [requestsByVerb.swap, { ...requestsByVerb.swap!, pool: '11111111111111111111111111111111' }]
        .map((r) => JSON.stringify(r)).join('\n') + '\n');
      expect(fs.existsSync(scratch.swapStreamPath)).toBe(false);
      expect(path.dirname(scratch.swapStreamPath).startsWith(os.tmpdir())).toBe(true);
    } finally {
      scratch.dispose();
    }
  });
});
