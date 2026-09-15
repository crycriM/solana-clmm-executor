import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR,
  buildAddLiquidityOneSideInstruction,
  decodeAddLiquidityOneSidePayload,
  deriveNativeBinWeights,
  encodeAddLiquidityOneSidePayload,
} from './dlmmWeighted.js';

const key = (byte: number): PublicKey => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));

describe('native Meteora weighted one-sided deposit', () => {
  it('round-trips the ABI and preserves a zero-bin tolerance', () => {
    const payload = {
      amount: 150_000_000n,
      activeId: 100,
      maxActiveBinSlippage: 0,
      binLiquidityDist: [{ binId: 98, weight: 32_767 }, { binId: 99, weight: 32_767 }],
    };
    const encoded = encodeAddLiquidityOneSidePayload(payload);
    expect(encoded.subarray(0, 8)).toEqual(ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR);
    expect(decodeAddLiquidityOneSidePayload(encoded)).toEqual(payload);
  });

  it('derives quote-side weights without dropping requested bins', () => {
    expect(deriveNativeBinWeights('bid', 150_000_000n, [
      { binId: 98, amountBps: 5_000 },
      { binId: 99, amountBps: 5_000 },
    ], 20)).toEqual([
      { binId: 98, weight: 32_767 },
      { binId: 99, weight: 32_767 },
    ]);
  });

  it('uses the pinned IDL account order and optional-account sentinel', () => {
    const instruction = buildAddLiquidityOneSideInstruction({
      position: key(1), lbPair: key(2), userToken: key(3), reserve: key(4),
      tokenMint: key(5), binArrayLower: key(6), binArrayUpper: key(7),
      sender: key(8), tokenProgram: key(9),
    }, {
      amount: 1n, activeId: 5, maxActiveBinSlippage: 0,
      binLiquidityDist: [{ binId: 4, weight: 65_535 }],
    });
    expect(instruction.keys).toHaveLength(12);
    expect(instruction.keys[0]!.pubkey.equals(key(1))).toBe(true);
    expect(instruction.keys[2]!.pubkey.equals(instruction.programId)).toBe(true);
    expect(instruction.keys[8]!.isSigner).toBe(true);
    expect(decodeAddLiquidityOneSidePayload(instruction.data).maxActiveBinSlippage).toBe(0);
  });
});
