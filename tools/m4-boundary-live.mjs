#!/usr/bin/env node
/**
 * M4 live boundary campaign. Manual release-gate evidence
 * companion to `npm run test:live:m4`; drives dist/bridge.js over stdio with the
 * the same safety guards (DRY_RUN=false + LIVE_WRITE_CONFIRM + run id).
 *
 * Phase A (cap=2): deposit whose expected_active_bin is 5 bins stale must be
 * rejected before signing with zero token/position delta.
 * Phase B (cap=0): a zero active-bin tolerance is accepted by policy as zero
 * (never inflated to the SDK wrapper default) and the dust position is closed
 * in the same phase.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SECRET_RE = /(PRIVATE_KEY|WALLET_SECRET(?!_ARN)|MNEMONIC|SEED|KMS_PLAINTEXT)/i;
for (const [key, value] of Object.entries(process.env)) {
  if (SECRET_RE.test(key) && value) throw new Error(`secret-bearing env var present: ${key}`);
}
if (process.env['DRY_RUN'] !== 'false' || process.env['LIVE_WRITE_CONFIRM'] !== 'yes') {
  throw new Error('boundary campaign requires DRY_RUN=false and LIVE_WRITE_CONFIRM=yes');
}
const runId = process.env['LIVE_RUN_ID'];
if (!runId) throw new Error('LIVE_RUN_ID required');
const pool = process.env['LIVE_POOL'];
const wallet = process.env['WALLET_PUBKEY'];
const side = process.env['LIVE_BOUNDARY_SIDE'] ?? 'bid';

class Bridge {
  constructor(extraEnv) {
    const dir = fs.mkdtempSync('/tmp/m4-boundary-');
    this.env = {
      ...process.env, EXECUTOR_LOG_DIR: dir, SWAP_STREAM_PATH: path.join(dir, 'swaps.jsonl'),
      ...extraEnv,
    };
    this.child = spawn('node', ['dist/bridge.js'], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        this.lines.push(JSON.parse(line));
        const waiters = this.waiting ?? [];
        this.waiting = undefined;
        for (const w of waiters) w(this.lines[this.lines.length - 1]);
      }
    });
    this.dir = dir;
  }
  async request(req, timeoutMs = 120_000) {
    if (this.waiting) throw new Error('strict single-flight violated');
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${req.method}`)), timeoutMs);
      this.waiting = [(r) => { clearTimeout(timer); resolve(r); }];
    });
    this.child.stdin.write(JSON.stringify(req) + '\n');
    return response;
  }
  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => this.child.once('close', resolve));
    return this.dir;
  }
}

async function balances(client) {
  const state = await client.request({ method: 'get_state', pool });
  return { active_bin: state.data.active_bin, balances_raw: state.data.balances_raw };
}

const exchanges = [];
async function runPhase(name, extraEnv, body) {
  const client = new Bridge(extraEnv);
  try {
    await body(client);
  } finally {
    const dir = await client.close();
    const evidence = `logs/test-artifacts/evidence-${runId}/${name}`;
    fs.mkdirSync(evidence, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(evidence, f));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (side !== 'bid' && side !== 'ask') throw new Error('LIVE_BOUNDARY_SIDE must be bid|ask');
  const amount = 0.01;

  await runPhase('phaseA-stale-reject', { MAX_ACTIVE_BIN_SLIPPAGE_BINS: '2' }, async (client) => {
    const before = await balances(client);
    const stale = before.active_bin + (side === 'bid' ? -5 : 5);
    const bins = side === 'bid' ? [stale - 2, stale - 1] : [stale, stale + 1];
    const request = {
      method: 'deposit_single_sided', pool, side, bin_ids: bins,
      amounts: [amount, amount], expected_active_bin: stale,
      max_active_bin_slippage: 2, strategy_type: 'Spot',
    };
    const response = await client.request(request);
    exchanges.push({ phase: 'A', request, response });
    const after = await balances(client);
    exchanges.push({ phase: 'A', delta_check: {
      balances_unchanged: JSON.stringify(before.balances_raw) === JSON.stringify(after.balances_raw),
      before: before.balances_raw, after: after.balances_raw,
    } });
    if (response.ok) throw new Error('phase A: stale deposit must not succeed');
    if (JSON.stringify(before.balances_raw) !== JSON.stringify(after.balances_raw)) {
      throw new Error('phase A: rejected deposit changed wallet balances');
    }
  });

  await runPhase('phaseB-zero-tolerance', { MAX_ACTIVE_BIN_SLIPPAGE_BINS: '0' }, async (client) => {
    const before = await balances(client);
    const active = before.active_bin;
    const bins = side === 'bid' ? [active - 2, active - 1] : [active, active + 1];
    const request = {
      method: 'deposit_single_sided', pool, side, bin_ids: bins,
      amounts: [amount, amount], expected_active_bin: active,
      max_active_bin_slippage: 0, strategy_type: 'Spot',
    };
    const deposit = await client.request(request);
    exchanges.push({ phase: 'B', request, response: deposit });
    if (!deposit.ok) {
      throw new Error(`phase B: zero-tolerance deposit rejected (${deposit.error}); `
        + 'policy must accept tolerance 0 as zero, not inflate it to the SDK default');
    }
    const positionId = deposit.position_id ?? deposit.data.position_id;
    const close = await client.request({ method: 'withdraw', position_id: positionId, bps: 100 });
    exchanges.push({ phase: 'B', request: { method: 'withdraw', position_id: positionId, bps: 100 }, response: close });
    if (!close.ok || close.data?.closed !== true || close.transactions[0]?.status !== 'finalized') {
      throw new Error(`phase B: close incomplete: ${JSON.stringify(close.error ?? close.data?.closed)}`);
    }
    const gone = await client.request({ method: 'get_position', position_id: positionId });
    if (gone.ok) throw new Error('phase B: closed position still readable');
    const after = await balances(client);
    exchanges.push({ phase: 'B', delta_check: {
      returned_raw: close.data?.amounts_returned, before: before.balances_raw, after: after.balances_raw,
    } });
  });

  const artifactDir = 'logs/test-artifacts';
  const file = path.join(artifactDir, `artifact-m4-boundary-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    run_id: runId, generated_at: new Date().toISOString(), wallet, pool, side, exchanges,
    cleanup: { operations: ['phase B position closed at 100%'], final_status: 'clean' },
  }, null, 2) + '\n');
  console.log(JSON.stringify({ kind: 'm4_boundary_result', artifact: file, status: 'passed' }));
}

main().catch((error) => {
  console.error(JSON.stringify({ kind: 'm4_boundary_result', status: 'failed', error: String(error) }));
  process.exitCode = 1;
});
