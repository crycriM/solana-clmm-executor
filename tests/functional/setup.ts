/**
 * Bootstrap for opt-in live functional suites (plan §7, §10).
 *
 * Live runs drive `dist/bridge.js` with DRY_RUN=false + LIVE_WRITE_CONFIRM=yes
 * + LIVE_RUN_ID, record a §7 artifact, and always run cleanup. Collection is
 * already gated by vitest.config.ts (RUN_LIVE=1); if the runner configuration
 * is incomplete the suites skip instead of activating a campaign.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireProductionBridge, readExecutorLog, requireLiveWriteConfig, RunRecorder, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

export function liveRunnerInfo(): { configured: boolean; reason: string } {
  try {
    requireLiveWriteConfig();
    return { configured: true, reason: '' };
  } catch (error) {
    return { configured: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** M2 reads are explicitly live but remain DRY_RUN=true and need no write confirmation. */
export function liveReadRunnerInfo(): { configured: boolean; reason: string } {
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
  const scratch = scratchEnv({ DRY_RUN: 'false' });
  if (scratch.env['DRY_RUN'] !== 'false') {
    throw new Error('live run attempted without DRY_RUN=false');
  }
  const recorder = new RunRecorder(runId);
  const client = new StdioClient(requireProductionBridge(), scratch.env);
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
export async function finishLiveRun(run: LiveRun, cleanupStatus: 'clean' | 'failed'): Promise<string> {
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
