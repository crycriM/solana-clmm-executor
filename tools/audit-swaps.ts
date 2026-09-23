/**
 * Independent completeness audit for a swap capture (tools/capture-swaps.sh).
 *
 * Re-derives the expected swap rows for one pool from chain history
 * (getSignaturesForAddress → getParsedTransaction → decodeLogs) over a slot
 * window and diffs them against the JSONL, per signature. Read-only.
 *
 *   set -a; . .env.capture; set +a
 *   npx tsx tools/audit-swaps.ts <capture.jsonl> [from_slot] [to_slot]
 *
 * Default window: the capture's first..last row slot. Cost is one
 * getTransaction per successful pool transaction in the window, so audit
 * sampled windows of a long soak rather than the whole file.
 *
 * Reads go through the executor's CU limiter. Alchemy's CU/s budget is
 * account-wide, so a capture on the same key keeps its SOLANA_RPC_MAX_CU_PER_SECOND
 * and the audit takes AUDIT_MAX_CU_PER_SECOND (default 50) of what is left.
 */
import fs from 'node:fs';
import { Connection, PublicKey, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { decodeLogs, DLMM_PROGRAM_ID } from '../src/swapStream.js';
import { RpcCuRateLimiter, rateLimitedFetch } from '../src/rpcRateLimit.js';

const [file, fromArg, toArg] = process.argv.slice(2);
const pool = process.env['POOL_ALLOWLIST']?.split(',')[0];
const rpc = process.env['SOLANA_RPC_URL'];
if (!file || !pool || !rpc) {
  console.error('usage: audit-swaps.ts <capture.jsonl> [from_slot] [to_slot] (needs POOL_ALLOWLIST, SOLANA_RPC_URL)');
  process.exit(2);
}

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l) as { tx_signature: string; slot: number; pool: string })
  .filter((r) => r.pool === pool);
if (rows.length === 0) throw new Error(`no rows for ${pool} in ${file}`);
const fromSlot = Number(fromArg ?? Math.min(...rows.map((r) => r.slot)));
const toSlot = Number(toArg ?? Math.max(...rows.map((r) => r.slot)));
const limiter = new RpcCuRateLimiter(Number(process.env['AUDIT_MAX_CU_PER_SECOND'] ?? 50));
// Our wrapper owns 429 backoff (it pauses the bucket); web3.js's own retry would bypass it.
const conn = new Connection(rpc, {
  commitment: 'finalized',
  disableRetryOnRateLimit: true,
  fetch: rateLimitedFetch(limiter, globalThis.fetch, { attempts: 10 }),
});

// Newest-first pages; start from the newest captured signature at or below
// toSlot so the walk begins inside the window instead of at chain tip.
const anchor = rows.filter((r) => r.slot <= toSlot).sort((a, b) => b.slot - a.slot)[0];
const history: ConfirmedSignatureInfo[] = [];
let before: string | undefined = anchor?.slot === toSlot ? undefined : anchor?.tx_signature;
for (;;) {
  const page = await conn.getSignaturesForAddress(new PublicKey(pool), { limit: 1000, before }, 'finalized');
  history.push(...page.filter((s) => s.slot >= fromSlot && s.slot <= toSlot));
  if (page.length < 1000 || page.at(-1)!.slot < fromSlot) break;
  before = page.at(-1)!.signature;
}
// The anchor itself is excluded by `before`; it is in the window by definition.
if (before !== undefined && anchor) history.push({ signature: anchor.tx_signature, slot: anchor.slot, err: null } as ConfirmedSignatureInfo);

const expected = new Map<string, number>();
let fetched = 0;
for (const info of history) {
  if (info.err) continue;
  const tx = await conn.getParsedTransaction(info.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 1 });
  fetched += 1;
  if (!tx) throw new Error(`transaction unavailable: ${info.signature}`);
  const events = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)
    .filter((ix) => 'data' in ix && ix.programId.toBase58() === DLMM_PROGRAM_ID)
    .map((ix) => (ix as { data: string }).data);
  // Decimals only scale amounts, and the audit counts rows; null would drop them.
  const n = decodeLogs({ err: null, logs: tx.meta?.logMessages ?? [], signature: info.signature },
    { slot: tx.slot, blockTime: tx.blockTime ?? 0, ts: 0 }, [pool], () => ({ base: 0, quote: 0 }), events).length;
  if (n > 0) expected.set(info.signature, n);
}

const captured = new Map<string, number>();
for (const r of rows) if (r.slot >= fromSlot && r.slot <= toSlot) captured.set(r.tx_signature, (captured.get(r.tx_signature) ?? 0) + 1);
const missing = [...expected].filter(([s, n]) => (captured.get(s) ?? 0) < n);
const extra = [...captured].filter(([s, n]) => (expected.get(s) ?? 0) < n);
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const report = {
  pool, file, from_slot: fromSlot, to_slot: toSlot,
  history_signatures: history.length, fetched_transactions: fetched,
  expected_rows: sum(expected), captured_rows: sum(captured),
  missing: missing.map(([s]) => s), extra: extra.map(([s]) => s),
  complete: missing.length === 0 && extra.length === 0,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.complete ? 0 : 1);
