/** Component coverage for restart, per-run audit logs, and req_seq reset. */
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutorAuditLine } from '../helpers/stdioClient.js';
import { requestsByVerb } from '../helpers/requests.js';
import { readExecutorLog, requireBuiltBridge, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

let kept: ScratchEnv | undefined;

afterAll(() => kept?.dispose());

function newClient(scratch: ScratchEnv): StdioClient {
  const client = new StdioClient(requireBuiltBridge(), scratch.env);
  client.start();
  return client;
}

describe('restart and recovery', () => {
  it('invalid lines never wedge the loop; service continues mid-run', async () => {
    const scratch = kept = scratchEnv();
    const client = newClient(scratch);
    try {
      client.writeRaw('not json');
      const failure = await client.request({ method: 'get_position', position_id: 'after-bad' });
      expect(failure.ok).toBe(false);
      const response = await client.request(requestsByVerb.get_state!); // valid exchange still works
      expect(response.ok).toBe(true);
      const started = readExecutorLog(scratch.logDir).filter((line) => line.kind === 'executor_started');
      expect(started).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('a fresh subprocess gets a fresh audit file and req_seq restarts at 1', async () => {
    const scratch = kept = scratchEnv();
    const first = newClient(scratch);
    try {
      await first.request(requestsByVerb.get_state!);
    } finally { await first.close(); }

    const second = newClient(scratch);
    let records: ExecutorAuditLine[] = [];
    try {
      await second.request(requestsByVerb.get_position!);
      records = readExecutorLog(scratch.logDir);
    } finally { await second.close(); }

    const verbLines = records.filter((line) => line.kind === 'verb');
    expect(verbLines).toHaveLength(2);
    expect(verbLines[0]!.req_seq).toBe(1);
    expect(verbLines[1]!.req_seq).toBe(1);
    expect(verbLines.map((line) => line.method)).toEqual(['get_state', 'get_position']);
  });

  it('every verb line records its redacted request and full response envelope', async () => {
    const scratch = kept = scratchEnv();
    const client = newClient(scratch);
    try {
      const response = await client.request(requestsByVerb.swap!);
      const verbLine = readExecutorLog(scratch.logDir).find((line) => line.kind === 'verb')!;
      expect(verbLine.request).toEqual(requestsByVerb.swap);
      expect(verbLine.response).toEqual(response);
      expect(verbLine.req_seq).toBe(1);
      expect(typeof verbLine.duration_ms).toBe('number');
    } finally {
      await client.close();
    }
    // log file persists after the client goes away
    expect(fs.readdirSync(scratch.logDir).some((f) => f.endsWith('.jsonl'))).toBe(true);
  });
});
