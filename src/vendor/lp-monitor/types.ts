// Meteora-only position types. Raw string fields accompany every decimal-scaled
// amount so BN-sized values remain exact; per-bin raw fields mirror position
// totals.

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
  /** Raw on-chain u64-as-string beside every decimal field. */
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
