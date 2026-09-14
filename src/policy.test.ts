import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import { baseEnv, TEST_BASE_MINT, TEST_POOL } from './testing.js';

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
});

// Keep the configured mint in the test module so it is evident the policy is
// driven by config rather than accepting arbitrary public keys.
void TEST_BASE_MINT;
void TEST_POOL;
