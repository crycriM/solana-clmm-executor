import { LBCLMM_PROGRAM_IDS, binIdToBinArrayIndex, deriveBinArray } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { binArrayMetasForRange, PreciseBuilderError } from './dlmmPrecise.js';

const pool = new PublicKey('11111111111111111111111111111111');
const program = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);

describe('binArrayMetasForRange', () => {
  it('derives every writable bin-array PDA across a range boundary', () => {
    const first = 69;
    const last = 70;
    const metas = binArrayMetasForRange(first, last, pool, program);
    const lower = binIdToBinArrayIndex(new BN(first));
    const upper = binIdToBinArrayIndex(new BN(last));
    const expected = [];
    for (let index = lower.toNumber(); index <= upper.toNumber(); index += 1) {
      expected.push(deriveBinArray(pool, new BN(index), program)[0].toBase58());
    }
    expect(metas.map((meta) => meta.pubkey.toBase58())).toEqual(expected);
    expect(metas.every((meta) => meta.isWritable && !meta.isSigner)).toBe(true);
  });

  it('refuses an unordered range', () => {
    expect(() => binArrayMetasForRange(2, 1, pool, program)).toThrow(PreciseBuilderError);
  });
});
