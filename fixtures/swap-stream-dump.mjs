// Test-only entrypoint: decodes the recorded DLMM log fixture through the real
// compiled swap stream and prints the resulting rows as JSON.
//
// This is the cross-language half of gate 3 (spec §6): it proves the rows the
// executor writes are the rows dlmm-bot's JsonlSwapEventSource reads. No RPC,
// websocket, or network access — the decode path is the same code the live
// subscription uses.
//
// Usage: node fixtures/swap-stream-dump.mjs fixtures/rpc/dlmm-swap-logs.json
import fs from 'node:fs';
import { SwapStream } from '../dist/swapStream.js';
import { JsonlWriter } from '../dist/jsonl.js';
import { readJsonl } from '../dist/jsonl.js';

const fixturePath = process.argv[2];
const outPath = process.argv[3] ?? `${fs.mkdtempSync('/tmp/swaps-')}/swaps.jsonl`;
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const pool = fixture.pool;
const DECIMALS = { base: 9, quote: 6 };
const line = { write: () => undefined };
const writer = new JsonlWriter(outPath);
const blockTimes = new Map(fixture.swaps.map((swap) => [swap.slot, swap.blockTime]));
let currentTs = 0;

const stream = new SwapStream({
  connection: {},
  writer,
  log: line,
  pools: [pool],
  decimals: () => DECIMALS,
  now: () => currentTs,
  retryDelayMs: 0,
  blockTime: async (slot) => blockTimes.get(slot) ?? null,
  fetchLogs: async () => null,
  fetchSignatures: async () => [],
});

for (const swap of fixture.swaps) {
  currentTs = swap.blockTime + 0.4;
  await stream.handleNotification(
    { err: null, logs: [`Program data: ${swap.payload}`], signature: swap.signature },
    swap.slot,
  );
}
await stream.close();

// Emit exactly the rows the writer persisted; Python reads the same file.
const persisted = readJsonl(outPath);
process.stdout.write(JSON.stringify(persisted));
if (process.argv[3] === undefined) fs.rmSync(outPath, { force: true });
