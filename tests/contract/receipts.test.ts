/** Plan §7 contract gate: receipt envelope conformance (protocol.ts shapes). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecResponse, TxReceipt } from '../../src/protocol.js';
import { requestsByVerb } from '../helpers/requests.js';
import { requireBuiltBridge, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

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

const STATUS: TxReceipt['status'][] = ['confirmed', 'finalized', 'pending', 'failed'];

/** Receipts must be chain-observable truth: never estimates (plan §2). */
function expectReceipts(response: ExecResponse): void {
  expect(Array.isArray(response.tx_signatures)).toBe(true);
  expect(Array.isArray(response.transactions)).toBe(true);
  expect(response.transactions).toHaveLength(response.tx_signatures.length);
  for (const [i, tx] of response.transactions.entries()) {
    expect(tx.signature).toBe(response.tx_signatures[i]);
    expect(Number.isInteger(tx.slot)).toBe(true);
    expect(['number', 'null']).toContain(typeof tx.block_time);
    expect(Number.isInteger(tx.fee_lamports)).toBe(true);
    expect(STATUS).toContain(tx.status);
  }
}

describe('receipt envelope', () => {
  it.each(['deposit_single_sided', 'withdraw', 'swap', 'refresh_bundle'] as const)
  ('%s pairs tx_signatures with fully-formed TxReceipts', async (verb) => {
    const response = await client.request(requestsByVerb[verb]!);
    expect(response.ok).toBe(true);
    expectReceipts(response);
  });

  it.each(['get_state', 'get_position'] as const)
  ('%s is a pure read: no receipts on the envelope', async (verb) => {
    const response = await client.request(requestsByVerb[verb]!);
    expect(response.ok).toBe(true);
    expect(response.tx_signatures).toEqual([]);
    expect(response.transactions).toEqual([]);
  });

  it('error envelopes never carry receipts', async () => {
    const bad = scratchEnv();
    const raw = new StdioClient(requireBuiltBridge(), bad.env);
    raw.start();
    try {
      const response = await raw.request({ method: 'withdraw', bps: 100 } as never);
      expect(response.ok).toBe(false);
      expectReceipts(response);
      expect(response.transactions).toHaveLength(0);
    } finally {
      await raw.close();
      bad.dispose();
    }
  });
});
