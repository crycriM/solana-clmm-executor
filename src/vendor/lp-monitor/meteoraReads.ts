// Read-only Meteora adapter. File persistence and CSV output are intentionally
// omitted. Raw BN values remain available beside decimal-scaled values, and
// mint decimals come from SDK reserves. Actual bin IDs are preserved; SDK
// proportional amounts are floored to raw units while exact fee BNs remain
// unchanged. USD enrichment is handled by the caller. Retries do not sleep
// after the final failed attempt because no further request follows.

import BN from 'bn.js';
import { createRequire } from 'node:module';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { PositionInfo as SdkPositionInfo } from '@meteora-ag/dlmm';
import type { PositionInfo } from './types.js';
import DecimalDefault from 'decimal.js';
const Decimal = DecimalDefault as unknown as typeof DecimalDefault.default;

export class RetryExhausted extends Error {}

/**
 * Exponential-free retry with linear backoff.
 * Retrial across RPC endpoints happens in meteora.ts (which emits
 * rpc_failover); this version is the transport-agnostic core.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (i < retries - 1) {
        onRetry?.(i + 1, lastError);
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
      }
    }
  }
  throw new RetryExhausted(
    `no result after ${retries} attempts: ${lastError?.message ?? 'unknown error'}`,
  );
}

/**
 * Raw BN u64 → decimal Number, guarded against the BN.toNumber() hazard.
 * Decimal =
 * Decimal(bn.toString()) / 10**decimals — exact, no float scaling of an
 * already-lossy Number.
 */
export function bnToDecimal(raw: unknown, decimals: number): number {
  if (raw == null) return 0;
  const bnValue = raw instanceof BN ? raw : typeof raw === 'bigint' ? new BN(raw.toString()) : null;
  if (bnValue === null) return 0;
  if (decimals <= 0) return Number(bnValue.toString());
  return new Decimal(bnValue.toString()).div(new Decimal(10).pow(decimals)).toNumber();
}

/** Raw BN u64 → canonical decimal string via BN.toString() (never toNumber). */
export function bnToRaw(raw: unknown): string {
  if (raw == null) return '0';
  if (raw instanceof BN) return raw.toString();
  if (typeof raw === 'bigint') return raw.toString();
  return '0';
}

type PositionReader = (
  connection: Connection,
  owner: PublicKey,
) => Promise<Map<string, SdkPositionInfo>>;

const readPositions: PositionReader = async (connection, owner) => {
  // The pinned SDK is CommonJS in Node; load lazily so M1 imports never
  // initialize its SDK stack. No connection or signer is created here.
  const sdk = createRequire(import.meta.url)('@meteora-ag/dlmm') as {
    default: { getAllLbPairPositionsByUser: PositionReader };
  };
  return sdk.default.getAllLbPairPositionsByUser(connection, owner);
};

/** Vendored wallet position reads, without CSV/tracking/logging side effects. */
export async function fetchMeteoraPositions(
  connection: Connection,
  walletAddress: string,
  read: PositionReader = readPositions,
): Promise<PositionInfo[]> {
  const pools = await withRetry(() => read(connection, new PublicKey(walletAddress)));
  const positions: PositionInfo[] = [];
  const rawUnits = (value: string): string => new Decimal(value).floor().toFixed(0);
  const scaled = (raw: string, decimals: number): string =>
    new Decimal(raw).div(new Decimal(10).pow(decimals)).toFixed();
  for (const [pool, info] of pools) {
    const dx = info.tokenX.mint.decimals;
    const dy = info.tokenY.mint.decimals;
    for (const entry of info.lbPairPositionsData) {
      const data = entry.positionData;
      const x = rawUnits(data.totalXAmount);
      const y = rawUnits(data.totalYAmount);
      const fx = bnToRaw(data.feeX);
      const fy = bnToRaw(data.feeY);
      positions.push({
        id: entry.publicKey.toBase58(),
        owner: data.owner.toBase58(),
        chain: 'solana',
        pool,
        tokenX: info.tokenX.mint.address.toBase58(),
        tokenY: info.tokenY.mint.address.toBase58(),
        tokenXDecimals: dx,
        tokenYDecimals: dy,
        amountX: scaled(x, dx),
        amountY: scaled(y, dy),
        amountX_raw: x,
        amountY_raw: y,
        lowerBinId: data.lowerBinId,
        upperBinId: data.upperBinId,
        activeBinId: info.lbPair.activeId,
        isInRange:
          info.lbPair.activeId >= data.lowerBinId && info.lbPair.activeId <= data.upperBinId,
        unclaimedFeeX: scaled(fx, dx),
        unclaimedFeeY: scaled(fy, dy),
        unclaimedFeeX_raw: fx,
        unclaimedFeeY_raw: fy,
        liquidityProfile: data.positionBinData.map((bin) => {
          const bx = rawUnits(bin.positionXAmount);
          const by = rawUnits(bin.positionYAmount);
          const share = new Decimal(bin.binLiquidity).gt(0)
            ? new Decimal(bin.positionLiquidity).div(bin.binLiquidity).mul(100).toFixed(2) + '%'
            : '0%';
          return {
            binId: bin.binId,
            price: bin.pricePerToken,
            positionLiquidity: bin.positionLiquidity,
            positionXAmount: scaled(bx, dx),
            positionYAmount: scaled(by, dy),
            positionXAmount_raw: bx,
            positionYAmount_raw: by,
            liquidityShare: share,
          };
        }),
      });
    }
  }
  return positions;
}
