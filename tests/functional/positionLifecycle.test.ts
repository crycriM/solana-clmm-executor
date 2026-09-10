/** Plan §8.3/§8.4 — dust position lifecycle + per-bin placement readback. Opt-in only (RUN_LIVE=1). */
import { describe, expect, it } from 'vitest';
import type { DepositData, PositionData, WithdrawData } from '../../src/protocol.js';
import { finishLiveRun, liveRunnerInfo, startLiveRun } from './setup.js';

const live = liveRunnerInfo();

describe.skipIf(!live.configured)('dust position lifecycle', () => {
  it('deposits dust bins, reads them back, partial exits, then closes cleanly', async () => {
    const run = startLiveRun(`positionLifecycle-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const binsEnv = (process.env['LIVE_DEPOSIT_BIN_IDS'] ?? '98,99').split(',').map(Number);
      const depositsEnv = (process.env['LIVE_DEPOSIT_AMOUNTS'] ?? '1,1').split(',').map(Number);
      const depositRequest = {
        method: 'deposit_single_sided' as const,
        pool: process.env['LIVE_POOL']!,
        side: 'bid' as const,
        bin_ids: binsEnv,
        amounts: depositsEnv,
        strategy_type: 'Spot' as const,
      };
      const before = await run.client.request({ method: 'get_state', pool: depositRequest.pool });
      run.recorder.beforeAfter('wallet', null, before.data);

      const deposit = await run.client.request(depositRequest);
      expect(deposit.ok).toBe(true);
      const created = deposit.data as DepositData;
      const positionId = deposit.position_id ?? created.position_id;
      expect(positionId).toBeTruthy();
      run.recorder.exchange(depositRequest, deposit);

      const readback = await run.client.request({ method: 'get_position', position_id: positionId! });
      expect(readback.ok).toBe(true);
      const onChain = readback.data as PositionData;
      expect(onChain.bins.map((b) => b.bin_id).sort()).toEqual([...binsEnv].sort(Number));
      run.recorder.setPosition(positionId!, onChain);

      const partial = await run.client.request({ method: 'withdraw', position_id: positionId!, bps: 50 });
      expect((partial.data as WithdrawData).closed).toBe(false);
      run.recorder.cleanupOperation(`withdraw 50bps from ${positionId}`);

      const full = await run.client.request({ method: 'withdraw', position_id: positionId!, bps: 100 });
      expect(full.data ? (full.data as WithdrawData).closed : false).toBe(true);
      run.recorder.exchange({ method: 'withdraw', position_id: positionId!, bps: 100 }, full);
      run.recorder.cleanupOperation(`withdraw 100bps from ${positionId} (cleanup)`);

      status = 'clean';
    } finally {
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  });
});
