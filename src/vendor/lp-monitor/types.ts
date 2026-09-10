// vendored from LP-hedging-strategy/lp-monitor/src/services/types.ts @ git aacfe017291681164a1a23b756f4516768699ad0
// co-maintained; strip = Krystal position + error-flag types dropped (Meteora
// only). Delta: *_raw string fields added so raw BN-sized amounts ride beside
// every decimal without BN.toNumber() (opms-spec §3.2, §5).
// Delta (M0 review): per-bin raw fields are required, like position totals.
// Do not edit in place without noting the delta here.

import { RawAmount } from '../../protocol.js';

export interface LiquidityProfileEntry {
  binId: number;
  price: string;
  positionLiquidity: string;
  /** Base-token amount in this bin, decimal-scaled */
  positionXAmount: string;
  /** Quote-token amount in this bin, decimal-scaled */
  positionYAmount: string;
  liquidityShare: string;
  /** Raw on-chain u64-as-string beside every decimal field (spec §3.2). */
  positionXAmount_raw: RawAmount;
  positionYAmount_raw: RawAmount;
}

export interface PositionInfo {
  id: string;
  owner: string;
  chain: string;
  pool: string;
  tokenX: string;
  tokenY: string;
  tokenXSymbol?: string;
  tokenYSymbol?: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  amountX: string;
  amountY: string;
  /** Raw on-chain u64-as-string counterparts of amountX/amountY. */
  amountX_raw: RawAmount;
  amountY_raw: RawAmount;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  isInRange: boolean;
  unclaimedFeeX: string;
  unclaimedFeeY: string;
  /** Raw claimable fee amounts — exact on-chain values. */
  unclaimedFeeX_raw: RawAmount;
  unclaimedFeeY_raw: RawAmount;
  liquidityProfile: LiquidityProfileEntry[];
  tokenXPriceUsd?: number;
  tokenYPriceUsd?: number;
}
