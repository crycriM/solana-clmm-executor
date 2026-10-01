/** Protocol-to-DLMM withdrawal normalization (M4 §3.4). */

import type { WithdrawRequest } from './protocol.js';

export interface NormalizedWithdrawal {
  /** Protocol fraction echoed in WithdrawData. */
  fraction: number;
  /** DLMM removeLiquidity BPS: 10_000 is a full withdrawal. */
  dlmmBps: number;
  /** Full exits must claim fees and close only if the account is empty. */
  shouldClaimAndClose: boolean;
}

/**
 * The wire carries an integer percent (1..100, enforced by `parseRequest`);
 * the DLMM program takes basis points. Keep the conversion isolated so no SDK
 * call can accidentally remove one percent on a requested full exit.
 */
export function normalizeWithdrawal({ percent }: Pick<WithdrawRequest, 'percent'>): NormalizedWithdrawal {
  return {
    fraction: percent / 100,
    dlmmBps: percent * 100,
    shouldClaimAndClose: percent === 100,
  };
}
