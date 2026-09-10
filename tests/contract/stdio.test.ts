/** Plan §7 contract gate: JSON-lines framing and stdio ordering. */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecRequest, ExecResponse, Verb } from '../../src/protocol.js';
import { requireBuiltBridge, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

const requests = JSON.parse(
  fs.readFileSync(new URL('../../fixtures/requests.json', import.meta.url), 'utf8'),
) as Record<Verb, ExecRequest>;

let scratch: ScratchEnv;
let client: StdioClient;

beforeAll(() => {
  requireBuiltBridge();
  scratch = scratchEnv();
  client = new StdioClient(requireBuiltBridge(), scratch.env);
  client.start();
});

afterAll(async () => {
  await client?.close();
  scratch?.dispose();
});

describe('stdio framing', () => {
  it('answers one response per request, strictly in request order', async () => {
    const sent: ExecRequest[] = [
      requests.get_state!,
      { method: 'get_position', position_id: 'first' },
      requests.swap!,
      { method: 'get_position', position_id: 'last' },
    ];
    const responses: ExecResponse[] = [];
    for (const request of sent) responses.push(await client.request(request));
    expect(responses.map((r) => (r.data as { position_id?: string }).position_id ?? null))
      .toEqual([null, 'first', null, 'last']);
  });

  it.each(['{', '', 'null', '[]', '42', '{"method":"unknown"}', '{"method":"get_state","pool":42}'])
  ('recovers and keeps serving after malformed line %s', async (line) => {
    const bad = scratchEnv();
    const raw = new StdioClient(requireBuiltBridge(), bad.env);
    raw.start();
    try {
      raw.writeRaw(line);
      const failure = await raw.request(requests.get_state!);
      const recovered = await raw.request(requests.get_position!);
      expect(failure.ok).toBe(false);
      expect(failure.error).toBe('bad_request');
      expect(recovered.ok).toBe(true);
    } finally {
      await raw.close();
      bad.dispose();
    }
  });

  it('keeps stdout exclusively JSON responses; diagnostics go to stderr only', async () => {
    const transcript = client.transcript;
    const responses = transcript.filter((entry) => entry.direction === 'resp');
    expect(responses.length).toBeGreaterThan(0);
    for (const entry of responses) expect(() => JSON.parse(JSON.stringify(entry.line))).not.toThrow();
    expect(client.lastStderr()).not.toMatch(/^\{"/);
  });

  it('terminates cleanly with exit code 0 when stdin closes', async () => {
    const code = await client.close();
    expect(code).toBe(0);
  });
});
