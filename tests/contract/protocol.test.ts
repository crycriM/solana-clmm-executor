/** Contract coverage for wire envelopes and fixtures. */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecRequest, ExecResponse, Verb } from '../../src/protocol.js';
import { requireBuiltBridge, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

const requests = JSON.parse(
  fs.readFileSync(new URL('../../fixtures/requests.json', import.meta.url), 'utf8'),
) as Record<Verb, ExecRequest>;
const verbs = Object.keys(requests) as Verb[];

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

function fixture(verb: Verb, result: 'ok' | 'error'): ExecResponse {
  return JSON.parse(
    fs.readFileSync(new URL(`../../fixtures/responses/${verb}.${result}.json`, import.meta.url), 'utf8'),
  ) as ExecResponse;
}

describe.each(verbs)('%s contract envelope', (verb) => {
  it('success response matches fixtures/responses/<verb>.ok.json exactly', async () => {
    const response = await client.request(requests[verb]!);
    expect(response.ok).toBe(true);
    // Implementation-plan T1.3: fixtures omit the M1-only stub marker.
    const data = response.data as Record<string, unknown>;
    expect(data.stub).toBe(true);
    delete data.stub;
    expect(response).toEqual(fixture(verb, 'ok'));
  });

  it('invalid field values yield the canonical bad_request envelope', async () => {
    const field = {
      get_state: 'pool', get_position: 'position_id', deposit_single_sided: 'pool',
      withdraw: 'position_id', quote_swap: 'in_mint', swap: 'in_mint',
      refresh_bundle: 'withdraw_position_id',
    }[verb];
    const broken = { ...requests[verb] } as Record<string, unknown>;
    delete broken[field];
    const response = await client.request(broken as unknown as ExecRequest);
    expect(response).toEqual(fixture(verb, 'error'));
  });
});
