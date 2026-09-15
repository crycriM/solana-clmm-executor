import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_FEE_2_DISCRIMINATOR,
  CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR,
  REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR,
  buildClaimFee2Instruction,
  buildClosePositionIfEmptyInstruction,
  buildRemoveLiquidityByRange2Instruction,
  decodeRemoveLiquidityByRangePayload,
} from './dlmmWithdraw.js';

const key = (): PublicKey => Keypair.generate().publicKey;

function accounts() {
  return {
    position: key(), pool: key(), bitmapExtension: null, userTokenX: key(), userTokenY: key(),
    reserveX: key(), reserveY: key(), tokenXMint: key(), tokenYMint: key(),
    tokenXProgram: TOKEN_PROGRAM_ID, tokenYProgram: TOKEN_PROGRAM_ID,
    sender: key(), binArrays: [key(), key()],
  };
}

describe('native Meteora withdrawal codec', () => {
  it('encodes and decodes uniform range removal with empty hook slices', () => {
    const instruction = buildRemoveLiquidityByRange2Instruction(accounts(), {
      fromBinId: 98, toBinId: 99, bpsToRemove: 10_000,
    });
    expect(instruction.data.subarray(0, 8)).toEqual(REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR);
    expect(decodeRemoveLiquidityByRangePayload(instruction.data)).toEqual({
      fromBinId: 98, toBinId: 99, bpsToRemove: 10_000,
    });
    expect(instruction.keys).toHaveLength(17);
  });

  it('builds fee claim and close in the expected order', () => {
    const a = accounts();
    const claim = buildClaimFee2Instruction(a, { fromBinId: 98, toBinId: 99 });
    const close = buildClosePositionIfEmptyInstruction(a.position, a.sender);
    expect(claim.data.subarray(0, 8)).toEqual(CLAIM_FEE_2_DISCRIMINATOR);
    expect(claim.data.readUInt32LE(16)).toBe(0);
    expect(close.data).toEqual(CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR);
    expect(close.keys[1]!.isSigner).toBe(true);
  });

  it('rejects invalid BPS and inverted ranges', () => {
    expect(() => buildRemoveLiquidityByRange2Instruction(accounts(), {
      fromBinId: 98, toBinId: 99, bpsToRemove: 0,
    })).toThrow('BPS');
    expect(() => buildRemoveLiquidityByRange2Instruction(accounts(), {
      fromBinId: 99, toBinId: 98, bpsToRemove: 100,
    })).toThrow('inverted');
  });
});
