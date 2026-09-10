/** Plan §8.6 — swap behavior against the live venue. Opt-in only (RUN_LIVE=1). */
import { describe, expect, it } from 'vitest';
import type { SwapData, TxReceipt } from '../../src/protocol.js';
import { finishLiveRun, liveRunnerInfo, startLiveRun } from './setup.js';

const live = liveRunnerInfo();

describe.skipIf(!live.configured)('live swaps', () => {
  it('routes a minimum-size swap and records the realized price', async () => {
    const run = startLiveRun(`swap-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const request = {
        method: 'swap' as const,
        in_mint: process.env['LIVE_BASE_MINT']!,
        out_mint: process.env['LIVE_QUOTE_MINT']!,
        amount: Number(process.env['LIVE_SWAP_AMOUNT'] ?? 0.01),
        max_slippage_bps: Number(process.env['LIVE_SWAP_SLIPPAGE_BPS'] ?? 50),
        pool: null,
      };
      const before = await run.client.request({ method: 'get_state', pool: process.env['LIVE_POOL']! });
      run.recorder.beforeAfter('wallet', before.data, null);

      const response = await run.client.request(request);
      expect(response.ok).toBe(true);
      const data = response.data as SwapData;
      expect(data.amount_in_raw).toMatch(/^\d+$/);
      expect(data.amount_out_raw).toMatch(/^\d+$/);
      expect(data.amount_out).toBeGreaterThan(0);
      expect(Number.isFinite(data.price_realized)).toBe(true);
      expect(response.transactions.every((tx: TxReceipt) => tx.fee_lamports >= 0)).toBe(true);
      run.recorder.exchange(request, response);

      const after = await run.client.request({ method: 'get_state', pool: process.env['LIVE_POOL']! });
      run.recorder.beforeAfter('wallet', before.data, after.data);
      status = 'clean';
    } finally {
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  });
});
