/**
 * Bootstrap for opt-in live functional suites (plan §7, §10).
 *
 * Live runs drive `dist/bridge.js`, record a §7 artifact, and always run
 * cleanup. Write runs additionally require DRY_RUN=false +
 * LIVE_WRITE_CONFIRM=yes + LIVE_RUN_ID; M2 read runs remain dry-run.
 * Collection is already gated by vitest.config.ts (RUN_LIVE=1); if the runner
 * configuration is incomplete the suites skip instead of activating a
 * campaign.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  requireProductionBridge,
  readExecutorLog,
  requireLiveWriteConfig,
  liveWriteGatewayEnv,
  RunRecorder,
  scratchEnv,
  StdioClient,
  type ScratchEnv,
} from '../helpers/stdioClient.js';

export function liveRunnerInfo(): { configured: boolean; reason: string } {
  try {
    requireLiveWriteConfig();
    liveWriteGatewayEnv();
    return { configured: true, reason: '' };
  } catch (error) {
    return { configured: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** M4 campaign inputs are explicit and relative to a fresh active-bin read. */
export function liveM4RunnerInfo(): { configured: boolean; reason: string } {
  const result = liveM4Configuration();
  if (process.env['RUN_LIVE_M4'] === '1' && !result.configured) {
    throw new Error(`M4 live campaign is not configured: ${result.reason}`);
  }
  return result;
}

function liveM4Configuration(): { configured: boolean; reason: string } {
  const common = liveRunnerInfo();
  if (!common.configured) return common;
  for (const key of [
    'LIVE_DEPOSIT_SIDE',
    'LIVE_DEPOSIT_BIN_OFFSETS',
    'LIVE_DEPOSIT_AMOUNTS',
    'LIVE_MAX_ACTIVE_BIN_SLIPPAGE',
  ]) {
    if (!process.env[key]) return { configured: false, reason: `${key} required for M4 writes` };
  }
  const side = process.env['LIVE_DEPOSIT_SIDE'];
  if (side !== 'bid' && side !== 'ask') {
    return { configured: false, reason: 'LIVE_DEPOSIT_SIDE must be bid|ask' };
  }
  const offsets = process.env['LIVE_DEPOSIT_BIN_OFFSETS']!.split(',').map(Number);
  const amounts = process.env['LIVE_DEPOSIT_AMOUNTS']!.split(',').map(Number);
  if (offsets.length === 0 || offsets.length !== amounts.length ||
      offsets.some((value) => !Number.isSafeInteger(value)) ||
      amounts.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { configured: false, reason: 'M4 offsets/amounts must be equal non-empty numeric lists' };
  }
  if (offsets.some((value, index) => index > 0 && value !== offsets[index - 1]! + 1)) {
    return { configured: false, reason: 'LIVE_DEPOSIT_BIN_OFFSETS must be contiguous' };
  }
  if ((side === 'bid' && offsets.some((value) => value >= 0)) ||
      (side === 'ask' && offsets.some((value) => value < 0))) {
    return { configured: false, reason: 'M4 bin offsets cross the active bin for the selected side' };
  }
  const slippage = Number(process.env['LIVE_MAX_ACTIVE_BIN_SLIPPAGE']);
  if (!Number.isSafeInteger(slippage) || slippage < 0) {
    return { configured: false, reason: 'LIVE_MAX_ACTIVE_BIN_SLIPPAGE must be a non-negative integer' };
  }
  const requestTimeout = Number(process.env['LIVE_REQUEST_TIMEOUT_MS'] ?? 90_000);
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 30_000) {
    return { configured: false, reason: 'LIVE_REQUEST_TIMEOUT_MS must be an integer >= 30000' };
  }
  return common;
}

/** M5 verbs are not implemented; this extra switch prevents accidental collection. */
export function liveM5RunnerInfo(): { configured: boolean; reason: string } {
  if (process.env['RUN_LIVE_M5'] !== '1') {
    return { configured: false, reason: 'RUN_LIVE_M5=1 required' };
  }
  const common = liveM4Configuration();
  if (!common.configured) throw new Error(`M5 live campaign is not configured: ${common.reason}`);
  for (const key of ['LIVE_POSITION_ID', 'LIVE_BASE_MINT', 'LIVE_QUOTE_MINT', 'LIVE_SWAP_AMOUNT']) {
    if (!process.env[key]) throw new Error(`M5 live campaign is not configured: ${key} required`);
  }
  return common;
}

/** M2 reads are explicitly live but remain DRY_RUN=true and need no write confirmation. */
export function liveReadRunnerInfo(): { configured: boolean; reason: string } {
  const result = liveReadConfiguration();
  if (process.env['RUN_LIVE_READS'] === '1' && !result.configured) {
    throw new Error(`live read campaign is not configured: ${result.reason}`);
  }
  return result;
}

function liveReadConfiguration(): { configured: boolean; reason: string } {
  if (process.env['RUN_LIVE'] !== '1') return { configured: false, reason: 'RUN_LIVE=1 required' };
  for (const key of ['SOLANA_RPC_URL', 'LIVE_POOL', 'LIVE_POSITION_ID', 'WALLET_PUBKEY']) {
    if (!process.env[key]) return { configured: false, reason: `${key} required` };
  }
  if (
    !process.env['MINT_ALLOWLIST'] &&
    !(process.env['LIVE_BASE_MINT'] && process.env['LIVE_QUOTE_MINT'])
  ) {
    return { configured: false, reason: 'MINT_ALLOWLIST or both LIVE_*_MINT values required' };
  }
  return { configured: true, reason: '' };
}

export interface LiveRun {
  scratch: ScratchEnv;
  client: StdioClient;
  recorder: RunRecorder;
}

/** Start a live subprocess; callers must always pass this to finishLiveRun. */
export function startLiveRun(runId: string): LiveRun {
  requireProductionBridge();
  requireLiveWriteConfig();
  const scratch = scratchEnv(liveWriteGatewayEnv());
  if (scratch.env['DRY_RUN'] !== 'false') {
    throw new Error('live run attempted without DRY_RUN=false');
  }
  const recorder = new RunRecorder(runId);
  const client = new StdioClient(
    requireProductionBridge(),
    scratch.env,
    Number(process.env['LIVE_REQUEST_TIMEOUT_MS'] ?? 90_000),
  );
  client.start();
  recorder.ingestStarted(readExecutorLog(scratch.logDir));
  return { scratch, client, recorder };
}

/** Start the production M2 entrypoint with real RPC configuration, read-only. */
export function startLiveReadRun(runId: string): LiveRun {
  requireProductionBridge();
  const info = liveReadRunnerInfo();
  if (!info.configured) throw new Error(info.reason);
  const pool = process.env['LIVE_POOL']!;
  const readUrl = process.env['SOLANA_RPC_URL']!;
  const scratch = scratchEnv({
    DRY_RUN: 'true',
    SOLANA_RPC_URL: readUrl,
    SOLANA_RPC_WRITE_URL: process.env['SOLANA_RPC_WRITE_URL'] ?? readUrl,
    ...(process.env['SOLANA_WS_URL'] ? { SOLANA_WS_URL: process.env['SOLANA_WS_URL'] } : {}),
    ...(process.env['SOLANA_RPC_MAX_CU_PER_SECOND']
      ? { SOLANA_RPC_MAX_CU_PER_SECOND: process.env['SOLANA_RPC_MAX_CU_PER_SECOND'] }
      : {}),
    SOLANA_COMMITMENT: process.env['SOLANA_COMMITMENT'] ?? 'confirmed',
    WALLET_PUBKEY: process.env['WALLET_PUBKEY']!,
    POOL_ALLOWLIST: process.env['POOL_ALLOWLIST'] ?? pool,
    MINT_ALLOWLIST:
      process.env['MINT_ALLOWLIST'] ??
      `${process.env['LIVE_BASE_MINT'] ?? ''},${process.env['LIVE_QUOTE_MINT'] ?? ''}`,
  });
  const recorder = new RunRecorder(runId);
  const client = new StdioClient(requireProductionBridge(), scratch.env);
  client.start();
  recorder.ingestStarted(readExecutorLog(scratch.logDir));
  return { scratch, client, recorder };
}

/** Close the run: audit ingest, cleanup status, artifact write, exit. */
export async function finishLiveRun(
  run: LiveRun,
  cleanupStatus: 'clean' | 'failed',
): Promise<string> {
  const dir = process.env['TEST_ARTIFACT_DIR'] ?? 'logs/test-artifacts';
  await run.client.close();
  const audit = readExecutorLog(run.scratch.logDir);
  run.recorder.ingestStarted(audit);
  run.recorder.ingestAudit(audit);
  const evidenceDir = path.join(dir, `evidence-${run.recorder.runId}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (fs.existsSync(run.scratch.swapStreamPath)) {
    const target = path.join(evidenceDir, 'swaps.jsonl');
    fs.copyFileSync(run.scratch.swapStreamPath, target);
    run.recorder.evidenceFile(target);
  }
  for (const name of fs.readdirSync(run.scratch.logDir)) {
    const source = path.join(run.scratch.logDir, name);
    if (!fs.statSync(source).isFile()) continue;
    const target = path.join(evidenceDir, name);
    fs.copyFileSync(source, target);
    run.recorder.evidenceFile(target);
  }
  run.recorder.finish(cleanupStatus);
  const file = run.recorder.write(dir);
  run.scratch.dispose();
  return file;
}
