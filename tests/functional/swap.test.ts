/** Swap behavior against the live venue. Opt-in only (RUN_LIVE=1). */
import { describe, expect, it } from 'vitest';
import type { StateData, SwapData, TxReceipt } from '../../src/protocol.js';
import { finishLiveRun, liveM5RunnerInfo, startLiveRun } from './setup.js';

const live = liveM5RunnerInfo();

describe.skipIf(!live.configured)('live swaps', () => {
  it('round-trips dust base-to-quote and back, recording realized prices', async () => {
    const run = startLiveRun(`swap-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    try {
      const pool = process.env['LIVE_POOL']!;
      const baseMint = process.env['LIVE_BASE_MINT']!;
      const quoteMint = process.env['LIVE_QUOTE_MINT']!;
      const amount = Number(process.env['LIVE_SWAP_AMOUNT'] ?? 0.01);
      const slippage = Number(process.env['LIVE_SWAP_SLIPPAGE_BPS'] ?? 50);
      const state = async (): Promise<StateData> => {
        const response = await run.client.request({ method: 'get_state', pool });
        expect(response.ok).toBe(true);
        return response.data as StateData;
      };
      const assertReceipts = (transactions: TxReceipt[]): void => {
        expect(transactions.length).toBeGreaterThan(0);
        expect(transactions.every((tx) => tx.fee_lamports >= 0)).toBe(true);
        expect(transactions.every((tx) => tx.signature.length > 0)).toBe(true);
      };

      const before = await state();
      run.recorder.beforeAfter('wallet', before, null);

      const outRequest = {
        method: 'swap' as const, in_mint: baseMint, out_mint: quoteMint,
        amount, max_slippage_bps: slippage, pool,
      };
      const out = await run.client.request(outRequest);
      expect(out.ok).toBe(true);
      const outData = out.data as SwapData;
      expect(outData.route).toBe('meteora');
      expect(outData.amount_in_raw).toMatch(/^\d+$/);
      expect(outData.amount_out_raw).toMatch(/^\d+$/);
      expect(outData.amount_out).toBeGreaterThan(0);
      expect(Number.isFinite(outData.price_realized)).toBe(true);
      assertReceipts(out.transactions);
      run.recorder.exchange(outRequest, out);

      const mid = await state();
      // The SDK treats wSOL legs as transaction-local (wrap in, unwrap/close
      // after), so only the SPL leg's wallet token balance moves durably; the
      // wSOL side is asserted from the settled receipt amounts instead.
      expect(Number(mid.balances_raw.quote)).toBeGreaterThan(Number(before.balances_raw.quote));
      expect(BigInt(outData.amount_in_raw)).toBeGreaterThan(0n);

      const backRequest = {
        method: 'swap' as const, in_mint: quoteMint, out_mint: baseMint,
        amount: outData.amount_out, max_slippage_bps: slippage, pool,
      };
      const back = await run.client.request(backRequest);
      expect(back.ok).toBe(true);
      const backData = back.data as SwapData;
      expect(backData.route).toBe('meteora');
      expect(backData.amount_out).toBeGreaterThan(0);
      assertReceipts(back.transactions);
      run.recorder.exchange(backRequest, back);

      const after = await state();
      expect(Number(after.balances_raw.quote)).toBeLessThan(Number(mid.balances_raw.quote));
      expect(BigInt(backData.amount_out_raw)).toBeGreaterThan(0n);
      run.recorder.decision(
        `round trip: in ${outData.amount_in} base -> ${outData.amount_out} quote -> `
        + `${backData.amount_out} base; net base lost ${outData.amount_in - backData.amount_out}`,
      );
      run.recorder.beforeAfter('wallet', null, after);
      status = 'clean';
    } finally {
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  });
});
