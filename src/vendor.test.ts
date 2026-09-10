import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import {
  bnToDecimal,
  bnToRaw,
  withRetry,
  fetchMeteoraPositions,
} from './vendor/lp-monitor/meteoraReads.js';
import { PublicKey } from '@solana/web3.js';
import type { PositionInfo as SdkPositionInfo } from '@meteora-ag/dlmm';
import { getSolanaConnection } from './vendor/lp-monitor/solana.js';
import { loadConfig } from './config.js';
import { baseEnv, TEST_POOL, TEST_BASE_MINT, TEST_QUOTE_MINT } from './testing.js';

describe('vendored BN handling (BN.toNumber regression)', () => {
  it('keeps a > 2^53 raw amount exact as a string', () => {
    // 2^53 = 9007199254740992; one less is exactly the boundary Number loses
    const huge = new BN('10000000411680503305'); // ~10 SESMIC units of SOL-1e9
    expect(bnToRaw(huge)).toBe('10000000411680503305');
    expect(Number(bnToRaw(huge))).toBe(Number('10000000411680503305')); // lossy — we never use this path
  });

  it('decimals come from the exact string, never from toNumber', () => {
    const hugeTokens = new BN('123456789123456789');
    const decimals = 9;
    const expected = Number(BigInt('123456789123456789')) / Math.pow(10, decimals);
    expect(bnToDecimal(hugeTokens, decimals)).toBeCloseTo(expected, 9);
    expect(bnToRaw(hugeTokens)).toBe('123456789123456789');
  });

  it('null and numeric inputs degrade to 0 through the raw path', () => {
    expect(bnToDecimal(null, 9)).toBe(0);
    expect(bnToRaw(42 as never)).toBe('0');
  });
});

describe('withRetry vendored core', () => {
  it('retries then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      3,
      1,
    );
    expect(result).toBe('ok');
  });
});

describe('vendored solana connection', () => {
  it('returns a Connection honoring the config commitment', () => {
    const cfg = loadConfig(baseEnv({ SOLANA_RPC_WRITE_URL: 'https://rpc-write.test' }));
    const read = getSolanaConnection(cfg);
    expect((read as { _rpcEndpoint?: string })._rpcEndpoint).toBe('https://rpc.test');
    const write = getSolanaConnection(cfg, { write: true });
    expect((write as { _rpcEndpoint?: string })._rpcEndpoint).toBe('https://rpc-write.test');
  });
});

describe('vendored wallet read mapping', () => {
  it('preserves SDK raw precision and actual bin IDs without HTTP price lookup or persistence', async () => {
    const owner = new PublicKey(TEST_POOL);
    const huge = '10000000411680503305';
    const row = {
      lbPair: { activeId: 0 },
      tokenX: { mint: { address: new PublicKey(TEST_BASE_MINT), decimals: 9 } },
      tokenY: { mint: { address: new PublicKey(TEST_QUOTE_MINT), decimals: 6 } },
      lbPairPositionsData: [
        {
          publicKey: owner,
          positionData: {
            owner,
            totalXAmount: huge + '.9',
            totalYAmount: '2500000',
            feeX: new BN(huge),
            feeY: new BN('500000'),
            lowerBinId: -1,
            upperBinId: 1,
            positionBinData: [
              {
                binId: -1,
                pricePerToken: '150',
                positionLiquidity: '1',
                binLiquidity: '100',
                positionXAmount: huge + '.9',
                positionYAmount: '2500000',
              },
            ],
          },
        },
      ],
    } as unknown as SdkPositionInfo;
    const connection = getSolanaConnection(loadConfig(baseEnv()));
    const positions = await fetchMeteoraPositions(connection, TEST_POOL, async (conn, key) => {
      expect(conn).toBe(connection);
      expect(key.equals(owner)).toBe(true);
      return new Map([[TEST_POOL, row]]);
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      amountX_raw: huge,
      amountX: '10000000411.680503305',
      amountY: '2.5',
      unclaimedFeeX_raw: huge,
      unclaimedFeeY_raw: '500000',
      lowerBinId: -1,
      upperBinId: 1,
      activeBinId: 0,
      isInRange: true,
      liquidityProfile: [
        {
          binId: -1,
          price: '150',
          positionXAmount_raw: huge,
          positionYAmount_raw: '2500000',
          liquidityShare: '1.00%',
        },
      ],
    });
  });
});
