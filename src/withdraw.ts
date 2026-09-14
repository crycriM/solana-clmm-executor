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
 * The wire protocol intentionally uses an integer percent despite the legacy
 * field name `bps`: 100 means 100%, not 100 bps.  Keep conversion isolated so
 * no SDK call can accidentally remove one percent on a requested full exit.
 */
export function normalizeWithdrawal(request: Pick<WithdrawRequest, 'bps'>): NormalizedWithdrawal {
  const percent = Math.min(100, Math.max(1, request.bps));
  return {
    fraction: percent / 100,
    dlmmBps: percent * 100,
    shouldClaimAndClose: percent === 100,
  };
}
