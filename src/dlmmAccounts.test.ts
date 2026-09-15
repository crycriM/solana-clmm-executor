import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  INITIALIZE_BIN_ARRAY_DISCRIMINATOR,
  INITIALIZE_POSITION_PDA_DISCRIMINATOR,
  buildWeightedDepositPreparation,
  deriveWeightedDepositAddresses,
  prepareWeightedDepositAccounts,
} from './dlmmAccounts.js';

const pool = new PublicKey('11111111111111111111111111111111');

function addresses(lowerBinId = 98, upperBinId = 99) {
  return deriveWeightedDepositAddresses({
    pool,
    wallet: Keypair.generate().publicKey,
    lowerBinId,
    upperBinId,
    tokenMint: new PublicKey('So11111111111111111111111111111111111111112'),
    tokenProgram: TOKEN_PROGRAM_ID,
    reserve: Keypair.generate().publicKey,
  });
}

describe('weighted deposit account preparation', () => {
  it('derives a deterministic position PDA and two covering bin arrays', () => {
    const a = addresses();
    const b = deriveWeightedDepositAddresses({
      pool: a.pool, wallet: a.wallet, lowerBinId: 98, upperBinId: 99,
      tokenMint: a.tokenMint, tokenProgram: a.tokenProgram, reserve: a.reserve,
    });
    expect(b.position.equals(a.position)).toBe(true);
    expect(a.positionWidth).toBe(2);
    expect(a.upperBinArrayIndex).toBeGreaterThan(a.lowerBinArrayIndex);
    expect(a.userToken.equals(b.userToken)).toBe(true);
  });

  it('initializes only missing Meteora accounts and always uses idempotent ATA creation', () => {
    const derived = addresses();
    const plan = buildWeightedDepositPreparation(derived, {
      position: false, lowerBinArray: false, upperBinArray: false, bitmapExtension: true,
    });
    expect(plan.instructions).toHaveLength(4);
    expect(plan.instructions[0]!.data.subarray(0, 8)).toEqual(INITIALIZE_BIN_ARRAY_DISCRIMINATOR);
    expect(plan.instructions[1]!.data.subarray(0, 8)).toEqual(INITIALIZE_BIN_ARRAY_DISCRIMINATOR);
    expect(plan.instructions[2]!.data.subarray(0, 8)).toEqual(INITIALIZE_POSITION_PDA_DISCRIMINATOR);
    expect(plan.instructions[2]!.keys.filter((key) => key.isSigner).every(
      (key) => key.pubkey.equals(derived.wallet),
    )).toBe(true);
    expect(plan.instructions[3]!.keys.some((key) => key.pubkey.equals(SystemProgram.programId))).toBe(true);
    expect(plan.estimatedRentLamports).toBeGreaterThan(0);
  });

  it('adds no Meteora initialization when all deterministic accounts exist', () => {
    const plan = buildWeightedDepositPreparation(addresses(), {
      position: true, lowerBinArray: true, upperBinArray: true, bitmapExtension: true,
    });
    expect(plan.instructions).toHaveLength(1);
  });

  it('rejects a position wider than Meteora permits', () => {
    expect(() => addresses(0, 70)).toThrow('exceeds 70');
  });

  it('checks existing deterministic accounts belong to Meteora', async () => {
    const derived = addresses();
    const account = (owner: PublicKey) => ({ owner }) as never;
    await expect(prepareWeightedDepositAccounts({
      getMultipleAccountsInfo: async () => [
        account(derived.programId), account(derived.programId), account(derived.programId),
      ],
    }, derived)).resolves.toMatchObject({ instructions: expect.any(Array) });

    await expect(prepareWeightedDepositAccounts({
      getMultipleAccountsInfo: async () => [
        account(Keypair.generate().publicKey), account(derived.programId), account(derived.programId),
      ],
    }, derived)).rejects.toThrow('position is not owned by Meteora');
  });
});
