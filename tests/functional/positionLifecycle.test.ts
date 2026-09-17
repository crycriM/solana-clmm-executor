/** Dust position lifecycle and per-bin placement readback. Opt-in only (RUN_LIVE=1). */
import BN from 'bn.js';
import { LBCLMM_PROGRAM_IDS, derivePosition } from '@meteora-ag/dlmm';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { DepositData, PositionData, WithdrawData } from '../../src/protocol.js';
import { finishLiveRun, liveM4RunnerInfo, startLiveRun } from './setup.js';

const live = liveM4RunnerInfo();

describe.skipIf(!live.configured)('dust position lifecycle', () => {
  it('deposits dust bins, reads them back, partial exits, then closes cleanly', async () => {
    const run = startLiveRun(`positionLifecycle-${process.env['LIVE_RUN_ID'] ?? 'x'}`);
    let status: 'clean' | 'failed' = 'failed';
    let positionId: string | undefined;
    let submissionAmbiguous = false;
    try {
      const offsets = process.env['LIVE_DEPOSIT_BIN_OFFSETS']!.split(',').map(Number);
      const depositsEnv = process.env['LIVE_DEPOSIT_AMOUNTS']!.split(',').map(Number);
      const side = process.env['LIVE_DEPOSIT_SIDE'] as 'bid' | 'ask';
      const before = await run.client.request({ method: 'get_state', pool: process.env['LIVE_POOL']! });
      expect(before.ok).toBe(true);
      const expectedActiveBin = Number((before.data as { active_bin: number }).active_bin);
      const bins = offsets.map((offset) => expectedActiveBin + offset);
      const [expectedPosition] = derivePosition(
        new PublicKey(process.env['LIVE_POOL']!),
        new PublicKey(process.env['WALLET_PUBKEY']!),
        new BN(bins[0]!),
        new BN(bins.length),
        new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']),
      );
      const preexisting = await run.client.request({
        method: 'get_position', position_id: expectedPosition.toBase58(),
      });
      expect(preexisting).toMatchObject({ ok: false, error: 'unknown_position' });
      console.info(JSON.stringify({
        kind: 'm4_write_preflight',
        run_id: process.env['LIVE_RUN_ID'],
        wallet: process.env['WALLET_PUBKEY'],
        pool: process.env['LIVE_POOL'],
        side,
        bin_ids: bins,
        amounts: depositsEnv,
        deposits_in_lifecycle: 2,
        expected_active_bin: expectedActiveBin,
        max_active_bin_slippage: Number(process.env['LIVE_MAX_ACTIVE_BIN_SLIPPAGE']),
        wallet_balances_raw: (before.data as { balances_raw: unknown }).balances_raw,
        max_sol_per_tx: process.env['MAX_SOL_PER_TX'],
        max_sol_per_run: process.env['MAX_SOL_PER_RUN'],
        conservative_first_position_rent_sol: 0.22,
      }));
      const depositRequest = {
        method: 'deposit_single_sided' as const,
        pool: process.env['LIVE_POOL']!,
        side,
        bin_ids: bins,
        amounts: depositsEnv,
        expected_active_bin: expectedActiveBin,
        max_active_bin_slippage: Number(process.env['LIVE_MAX_ACTIVE_BIN_SLIPPAGE']),
        strategy_type: 'Spot' as const,
      };
      run.recorder.beforeAfter('wallet', before.data, null);

      const deposit = await run.client.request(depositRequest);
      submissionAmbiguous ||= deposit.error === 'submission_ambiguous';
      run.recorder.exchange(depositRequest, deposit);
      expect(deposit.ok).toBe(true);
      const created = deposit.data as DepositData;
      positionId = deposit.position_id ?? created.position_id;
      expect(positionId).toBe(expectedPosition.toBase58());
      expect(created.bins.reduce((sum, bin) => sum + bin.target_bps, 0)).toBe(10_000);

      const readback = await run.client.request({ method: 'get_position', position_id: positionId! });
      expect(readback.ok).toBe(true);
      const onChain = readback.data as PositionData;
      const realized = onChain.bins.filter((bin) => bins.includes(bin.bin_id));
      expect(realized.map((bin) => bin.bin_id)).toEqual(bins);
      const rawField = side === 'bid' ? 'amount_quote_raw' : 'amount_base_raw';
      const realizedTotal = realized.reduce((sum, bin) => sum + BigInt(bin[rawField]), 0n);
      expect(realizedTotal).toBeGreaterThan(0n);
      const postState = await run.client.request({ method: 'get_state', pool: process.env['LIVE_POOL']! });
      expect(postState.ok).toBe(true);
      const postActive = Number((postState.data as { active_bin: number }).active_bin);
      const tokenDecimals = Number(
        (postState.data as { token_x: { decimals: number }; token_y: { decimals: number } })
        [side === 'bid' ? 'token_y' : 'token_x'].decimals,
      );
      const maxDebitRaw = BigInt(
        Math.round(depositsEnv.reduce((sum, value) => sum + value, 0) * 10 ** tokenDecimals),
      );
      expect(realizedTotal).toBeLessThanOrEqual(maxDebitRaw);
      const driftBins = Math.abs(postActive - expectedActiveBin);
      const toleranceBps = Number(process.env['LIVE_WEIGHT_TOLERANCE_BPS'] ?? 100);
      if (driftBins === 0) {
        for (const [index, bin] of realized.entries()) {
          const actualBps = Number((BigInt(bin[rawField]) * 10_000n) / realizedTotal);
          expect(Math.abs(actualBps - created.bins[index]!.target_bps)).toBeLessThanOrEqual(toleranceBps);
        }
      } else {
        run.recorder.decision(
          `active bin drifted ${driftBins} bins during the dust window; per-bin weights reflect `
          + `price conversion, only the aggregate debit bound (<= ${maxDebitRaw}) is asserted`,
        );
      }
      run.recorder.setPosition(positionId!, onChain);

      const add = await run.client.request(depositRequest);
      submissionAmbiguous ||= add.error === 'submission_ambiguous';
      run.recorder.exchange(depositRequest, add);
      expect(add.ok).toBe(true);
      expect(add.position_id ?? (add.data as DepositData).position_id).toBe(positionId);
      const addedReadback = await run.client.request({
        method: 'get_position', position_id: positionId!,
      });
      expect(addedReadback.ok).toBe(true);
      const addedBins = (addedReadback.data as PositionData).bins
        .filter((bin) => bins.includes(bin.bin_id));
      const addedTotal = addedBins.reduce((sum, bin) => sum + BigInt(bin[rawField]), 0n);
      expect(addedTotal).toBeGreaterThan(realizedTotal);
      run.recorder.setPosition(positionId!, addedReadback.data);

      const partialRequest = { method: 'withdraw' as const, position_id: positionId!, bps: 50 };
      const partial = await run.client.request(partialRequest);
      submissionAmbiguous ||= partial.error === 'submission_ambiguous';
      run.recorder.exchange(partialRequest, partial);
      expect(partial.ok).toBe(true);
      expect((partial.data as WithdrawData).closed).toBe(false);
      run.recorder.cleanupOperation(`withdraw 50% from ${positionId}`);

      const full = await run.client.request({ method: 'withdraw', position_id: positionId!, bps: 100 });
      submissionAmbiguous ||= full.error === 'submission_ambiguous';
      expect(full.ok).toBe(true);
      expect(full.data ? (full.data as WithdrawData).closed : false).toBe(true);
      expect(full.transactions[0]?.status).toBe('finalized');
      run.recorder.exchange({ method: 'withdraw', position_id: positionId!, bps: 100 }, full);
      run.recorder.cleanupOperation(`withdraw 100% from ${positionId} (cleanup)`);
      const after = await run.client.request({ method: 'get_state', pool: process.env['LIVE_POOL']! });
      expect(after.ok).toBe(true);
      run.recorder.beforeAfter('wallet', null, after.data);

      status = 'clean';
    } finally {
      if (status === 'failed' && positionId && !submissionAmbiguous) {
        const cleanup = await run.client.request({
          method: 'withdraw', position_id: positionId, bps: 100,
        }).catch(() => null);
        if (cleanup?.ok && (cleanup.data as WithdrawData | null)?.closed) {
          run.recorder.exchange(
            { method: 'withdraw', position_id: positionId, bps: 100 },
            cleanup,
          );
          run.recorder.cleanupOperation(`emergency cleanup of ${positionId}`);
          status = 'clean';
        }
      }
      const artifact = await finishLiveRun(run, status);
      expect(artifact).toMatch(/artifact-.+\.json$/);
    }
  }, 360_000);
});
