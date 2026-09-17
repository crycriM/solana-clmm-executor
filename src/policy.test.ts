import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { loadConfig } from './config.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import { buildAddLiquidityOneSideInstruction } from './dlmmWeighted.js';
import { deriveWeightedDepositAddresses } from './dlmmAccounts.js';
import { baseEnv, TEST_BASE_MINT, TEST_POOL, TEST_QUOTE_MINT } from './testing.js';

const BLOCKHASH = '11111111111111111111111111111111';

function fixture() {
  const wallet = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const config = loadConfig(baseEnv({ WALLET_PUBKEY: wallet.publicKey.toBase58() }));
  const policy = new TransactionPolicy(config, wallet.publicKey);
  const tx = (instruction: TransactionInstruction) => new Transaction({
    feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH,
  }).add(instruction);
  const transfer = (lamports = 1) => tx(SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: recipient, lamports,
  }));
  return { wallet, recipient, config, policy, tx, transfer };
}

function rejectRule(fn: () => unknown, rule: string) {
  try {
    fn();
    expect.unreachable('policy must reject');
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRejected);
    expect((error as PolicyRejected).rule).toBe(rule);
  }
}

describe('TransactionPolicy', () => {
  it('accepts a final transaction whose program, writable keys, and signer are known', () => {
    const { policy, transfer, recipient } = fixture();
    const decision = policy.validate(transfer(), {
      writableAccounts: [recipient], amounts: { solSpendLamports: 1, maxSlippageBps: 0 },
    });
    expect(decision.messageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an unknown program', () => {
    const { policy, tx, wallet } = fixture();
    const instruction = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0),
    });
    rejectRule(() => policy.validate(tx(instruction), { writableAccounts: [], amounts: {} }), 'program_id_allowlist');
  });

  it('rejects an unknown writable account', () => {
    const { policy, transfer } = fixture();
    rejectRule(() => policy.validate(transfer(), { writableAccounts: [], amounts: {} }), 'writable_account_allowlist');
  });

  it('rejects a builder that declares a pool or mint outside configuration', () => {
    const { policy, transfer, recipient } = fixture();
    rejectRule(() => policy.validate(transfer(), {
      writableAccounts: [recipient], pools: [Keypair.generate().publicKey], amounts: {},
    }), 'pool_allowlist');
    rejectRule(() => policy.validate(transfer(), {
      writableAccounts: [recipient], mints: [Keypair.generate().publicKey], amounts: {},
    }), 'mint_allowlist');
  });

  it('requires the configured wallet to pay the fee and be the sole signer', () => {
    const { policy, transfer, wallet, recipient } = fixture();
    const wrongPayer = transfer();
    wrongPayer.feePayer = Keypair.generate().publicKey;
    rejectRule(() => policy.validate(wrongPayer, { writableAccounts: [recipient], amounts: {} }), 'fee_payer');

    const extra = Keypair.generate().publicKey;
    const instruction = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: extra, isSigner: true, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });
    rejectRule(() => policy.validate(new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(instruction), {
      writableAccounts: [], amounts: {},
    }), 'only_wallet_signer');
  });

  it('enforces SOL per-transaction and per-run caps only at signing admission', () => {
    const { policy, transfer, recipient, config } = fixture();
    rejectRule(() => policy.validate(transfer(), {
      writableAccounts: [recipient], amounts: { solSpendLamports: config.maxSolPerTx * 1_000_000_000 + 1 },
    }), 'sol_per_tx_cap');

    // Model two transactions that both simulated before either was admitted.
    // The second `commit` must still reject rather than overrun the run cap.
    config.maxSolPerTx = 2;
    config.maxSolPerRun = 1;
    const halfRun = Math.floor((config.maxSolPerRun * 1_000_000_000) / 2) + 1;
    const a = policy.validate(transfer(), { writableAccounts: [recipient], amounts: { solSpendLamports: halfRun } });
    const b = policy.validate(transfer(), { writableAccounts: [recipient], amounts: { solSpendLamports: halfRun } });
    policy.commit(a);
    rejectRule(() => policy.commit(b), 'sol_per_run_cap');
  });

  it('enforces slippage and Compute Budget priority-fee caps', () => {
    const { policy, transfer, recipient, config, wallet } = fixture();
    rejectRule(() => policy.validate(transfer(), {
      writableAccounts: [recipient], amounts: { maxSlippageBps: config.maxSlippageBps + 1 },
    }), 'slippage_cap');
    rejectRule(() => policy.validate(transfer(), {
      writableAccounts: [recipient],
      amounts: { maxActiveBinSlippage: config.maxActiveBinSlippageBins + 1 },
    }), 'active_bin_slippage_cap');

    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: BigInt(config.maxPriorityFeeLamports + 1) * 1_000_000n,
      }),
    );
    rejectRule(() => policy.validate(tx, { writableAccounts: [], amounts: {} }), 'priority_fee_cap');
  });

  it('caps total priority fee, not only micro-lamports-per-CU', () => {
    const { policy, wallet, config } = fixture();
    const allowed = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.maxPriorityFeeLamports }),
    );
    expect(() => policy.validate(allowed, { writableAccounts: [], amounts: {} })).not.toThrow();

    const noLimit = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    );
    rejectRule(() => policy.validate(noLimit, { writableAccounts: [], amounts: {} }), 'priority_fee_cap');
  });

  it('fails closed when a versioned transaction includes unresolved lookup tables', () => {
    // The v0-message object is intentionally not constructed here: web3 only
    // emits a lookup reference when the table account is supplied.  This small
    // assertion protects the public branch used by M4 builders.
    const { policy } = fixture();
    const fake = {
      message: { addressTableLookups: [{}], getAccountKeys: () => { throw new Error('not reached'); } },
    } as never;
    rejectRule(() => policy.validate(fake, { writableAccounts: [], amounts: {} }), 'address_lookup_tables');
  });

  it('validates an expanded v0 message with the same signer and writable rules', () => {
    const { policy, wallet, recipient } = fixture();
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 1 })],
    }).compileToV0Message();
    const decision = policy.validate(new VersionedTransaction(message), {
      writableAccounts: [recipient], amounts: { solSpendLamports: 1 }, addressLookupTableAccounts: [],
    });
    expect(decision.messageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds the decoded native deposit accounts and payload before signing', () => {
    const { policy, wallet } = fixture();
    const reserve = Keypair.generate().publicKey;
    const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const tokenMint = new PublicKey(TEST_BASE_MINT);
    const addresses = deriveWeightedDepositAddresses({
      pool: new PublicKey(TEST_POOL), wallet: wallet.publicKey,
      lowerBinId: 98, upperBinId: 99, tokenMint, tokenProgram, reserve,
    });
    const weights = [{ binId: 98, weight: 32_767 }, { binId: 99, weight: 32_767 }];
    const instruction = buildAddLiquidityOneSideInstruction({
      position: addresses.position, lbPair: new PublicKey(TEST_POOL), userToken: addresses.userToken,
      reserve, tokenMint,
      binArrayLower: addresses.lowerBinArray, binArrayUpper: addresses.upperBinArray,
      sender: wallet.publicKey, tokenProgram,
    }, { amount: 150n, activeId: 100, maxActiveBinSlippage: 0, binLiquidityDist: weights });
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, addresses.userToken, wallet.publicKey, tokenMint,
      ),
      instruction,
    );
    const expected = {
      position: addresses.position, pool: TEST_POOL, userToken: addresses.userToken, reserve,
      tokenMint: TEST_BASE_MINT,
      binArrayLower: addresses.lowerBinArray, binArrayUpper: addresses.upperBinArray,
      tokenProgram,
      positionLowerBinId: addresses.positionLowerBinId, positionWidth: addresses.positionWidth,
      lowerBinArrayIndex: addresses.lowerBinArrayIndex,
      upperBinArrayIndex: addresses.upperBinArrayIndex,
      amountRaw: 150n, activeId: 100, maxActiveBinSlippage: 0, weights,
    };
    const writableAccounts = [
      addresses.position, addresses.userToken, reserve,
      addresses.lowerBinArray, addresses.upperBinArray,
    ];
    expect(() => policy.validate(tx, {
      writableAccounts, pools: [TEST_POOL], mints: [TEST_BASE_MINT],
      amounts: { maxActiveBinSlippage: 0 }, nativeDeposit: expected,
    })).not.toThrow();

    rejectRule(() => policy.validate(tx, {
      writableAccounts, pools: [TEST_POOL], mints: [TEST_BASE_MINT],
      amounts: { maxActiveBinSlippage: 0 },
    }), 'native_deposit_binding');

    rejectRule(() => policy.validate(tx, {
      writableAccounts, pools: [TEST_POOL], mints: [TEST_BASE_MINT],
      amounts: { maxActiveBinSlippage: 0 },
      nativeDeposit: { ...expected, maxActiveBinSlippage: 1 },
    }), 'native_deposit_binding');
  });

});

// Keep the configured mint in the test module so it is evident the policy is
// driven by config rather than accepting arbitrary public keys.
void TEST_BASE_MINT;
void TEST_POOL;

function systemCreate(from: PublicKey, target: PublicKey, lamports: number): TransactionInstruction {
  const data = Buffer.alloc(52);
  data.writeUInt32LE(0, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  data.writeBigUInt64LE(165n, 12);
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer().copy(data, 20);
  return new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: target, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function jupiterFixture() {
  const wallet = Keypair.generate();
  const router = Keypair.generate();
  const config = loadConfig(baseEnv({
    WALLET_PUBKEY: wallet.publicKey.toBase58(),
    JUPITER_PROGRAM_ALLOWLIST: router.publicKey.toBase58(),
  }));
  const policy = new TransactionPolicy(config, wallet.publicKey);
  const inMint = new PublicKey(TEST_QUOTE_MINT);
  const outMint = new PublicKey(TEST_BASE_MINT);
  const source = getAssociatedTokenAddressSync(inMint, wallet.publicKey);
  const destination = getAssociatedTokenAddressSync(outMint, wallet.publicKey);
  const poolAccount = Keypair.generate().publicKey;
  const amountIn = 1_000_000n;
  const minOut = 990_000n;
  const routerData = Buffer.alloc(17);
  routerData[0] = 2;
  routerData.writeBigUInt64LE(amountIn, 1);
  routerData.writeBigUInt64LE(minOut, 9);
  const routerInstruction = (
    authority: PublicKey = wallet.publicKey,
    authoritySigns = true,
  ) => new TransactionInstruction({
    programId: router.publicKey,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: authoritySigns, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: poolAccount, isSigner: false, isWritable: true },
    ],
    data: routerData,
  });
  const build = (instructions: TransactionInstruction[]) => new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions,
    }).compileToV0Message(),
  );
  const baseInput = {
    writableAccounts: [source, destination],
    mints: [inMint, outMint],
    amounts: { maxSlippageBps: 50, solSpendLamports: 5_000 },
    jupiterSwap: {
      routerProgram: router.publicKey,
      sourceTokenAccount: source,
      destinationTokenAccount: destination,
      tokenProgram: TOKEN_PROGRAM_ID,
      amountInRaw: amountIn,
      minOutRaw: minOut,
    },
    addressLookupTableAccounts: [],
  };
  return {
    wallet, router, policy, source, destination, routerInstruction,
    routerData, build, baseInput, amountIn, minOut,
  };
}

describe('TransactionPolicy Jupiter swap binding', () => {
  it('accepts a router instruction bound to the wallet, amounts, and ATAs', () => {
    const f = jupiterFixture();
    const decision = f.policy.validate(f.build([f.routerInstruction()]), f.baseInput);
    expect(decision.messageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts idempotent ATA setup and transaction-local wrap/transfer steps', () => {
    const f = jupiterFixture();
    const ephemeral = Keypair.generate().publicKey;
    const transfer = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: f.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: ephemeral, isSigner: false, isWritable: true },
      ],
      data: (() => {
        const data = Buffer.alloc(12);
        data.writeUInt32LE(2, 0);
        data.writeBigUInt64LE(100_000n, 4);
        return data;
      })(),
    });
    expect(() => f.policy.validate(f.build([
      systemCreate(f.wallet.publicKey, ephemeral, 2_000_000),
      transfer,
      createAssociatedTokenAccountIdempotentInstruction(
        f.wallet.publicKey, f.destination, f.wallet.publicKey, new PublicKey(TEST_BASE_MINT),
      ),
      f.routerInstruction(),
    ]), f.baseInput)).not.toThrow();
  });

  it('rejects a router payload that changes the amount or the minimum output', () => {
    const f = jupiterFixture();
    const tampered = Buffer.from(f.routerData);
    tampered.writeBigUInt64LE(f.amountIn + 1n, 1);
    const tamperedOut = Buffer.from(f.routerData);
    tamperedOut.writeBigUInt64LE(f.minOut - 10_000n, 9);
    const swapWith = (data: Buffer) => new TransactionInstruction({
      programId: f.routerInstruction().programId,
      keys: f.routerInstruction().keys,
      data,
    });
    rejectRule(() => f.policy.validate(f.build([swapWith(tampered)]), f.baseInput),
      'jupiter_swap_binding');
    rejectRule(() => f.policy.validate(f.build([swapWith(tamperedOut)]), f.baseInput),
      'jupiter_swap_binding');
  });

  it('rejects a foreign transfer authority or a second router instruction', () => {
    const f = jupiterFixture();
    // A foreign key marked signer is promoted into the message header and
    // fails the sole-signer rule before the binding is even consulted.
    rejectRule(() => f.policy.validate(
      f.build([f.routerInstruction(Keypair.generate().publicKey)]), f.baseInput,
    ), 'only_wallet_signer');
    rejectRule(() => f.policy.validate(
      f.build([f.routerInstruction(Keypair.generate().publicKey, false)]), f.baseInput,
    ), 'jupiter_swap_binding');
    rejectRule(() => f.policy.validate(
      f.build([f.routerInstruction(), f.routerInstruction()]), f.baseInput,
    ), 'jupiter_swap_binding');
  });

  it('rejects wallet SOL leaving toward an account not created in the transaction', () => {
    const f = jupiterFixture();
    const stranger = Keypair.generate().publicKey;
    const transfer = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: f.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: stranger, isSigner: false, isWritable: true },
      ],
      data: (() => {
        const data = Buffer.alloc(12);
        data.writeUInt32LE(2, 0);
        data.writeBigUInt64LE(1_000_000n, 4);
        return data;
      })(),
    });
    rejectRule(() => f.policy.validate(f.build([transfer, f.routerInstruction()]), f.baseInput),
      'jupiter_swap_binding');
  });

  it('rejects a token program step that touches an unbound wallet account', () => {
    const f = jupiterFixture();
    const foreignAta = Keypair.generate().publicKey;
    const transferChecked = new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: foreignAta, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(TEST_QUOTE_MINT), isSigner: false, isWritable: false },
        { pubkey: f.wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });
    rejectRule(() => f.policy.validate(
      f.build([transferChecked, f.routerInstruction()]), f.baseInput,
    ), 'jupiter_swap_binding');
  });

  it('rejects a Jupiter swap delivered as a legacy transaction', () => {
    const f = jupiterFixture();
    const legacy = new Transaction({ feePayer: f.wallet.publicKey, recentBlockhash: BLOCKHASH })
      .add(f.routerInstruction());
    rejectRule(() => f.policy.validate(legacy, f.baseInput), 'jupiter_swap_binding');
  });
});
