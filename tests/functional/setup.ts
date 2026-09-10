/**
 * Bootstrap for opt-in live functional suites (plan §7, §10).
 *
 * Live runs drive `dist/bridge.js` with DRY_RUN=false + LIVE_WRITE_CONFIRM=yes
 * + LIVE_RUN_ID, record a §7 artifact, and always run cleanup. Collection is
 * already gated by vitest.config.ts (RUN_LIVE=1); if the runner configuration
 * is incomplete the suites skip instead of activating a campaign.
 */

import { requireBuiltBridge, readExecutorLog, requireLiveWriteConfig, RunRecorder, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

export function liveRunnerInfo(): { configured: boolean; reason: string } {
  try {
    requireLiveWriteConfig();
    return { configured: true, reason: '' };
  } catch (error) {
    return { configured: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface LiveRun {
  scratch: ScratchEnv;
  client: StdioClient;
  recorder: RunRecorder;
}

/** Start a live subprocess; callers must always pass this to finishLiveRun. */
export function startLiveRun(runId: string): LiveRun {
  requireBuiltBridge();
  requireLiveWriteConfig();
  const scratch = scratchEnv({ DRY_RUN: 'false' });
  if (scratch.env['DRY_RUN'] !== 'false') {
    throw new Error('live run attempted without DRY_RUN=false');
  }
  const recorder = new RunRecorder(runId);
  const client = new StdioClient(requireBuiltBridge(), scratch.env);
  client.start();
  recorder.ingestStarted(readExecutorLog(scratch.logDir));
  return { scratch, client, recorder };
}

/** Close the run: audit ingest, cleanup status, artifact write, exit. */
export async function finishLiveRun(run: LiveRun, cleanupStatus: 'clean' | 'failed'): Promise<string> {
  run.recorder.ingestAudit(readExecutorLog(run.scratch.logDir));
  run.recorder.finish(cleanupStatus);
  const dir = process.env['TEST_ARTIFACT_DIR'] ?? 'logs/test-artifacts';
  const file = run.recorder.write(dir);
  await run.client.close();
  run.scratch.dispose();
  return file;
}
