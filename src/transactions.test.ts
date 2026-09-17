import { createPrivateKey, sign as signEd25519 } from 'node:crypto';
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import type { Signer } from './signer.js';
import {
  executeLegacyTransaction,
  executeVersionedTransaction,
  type ExecutionConnection,
} from './transactions.js';
import { baseEnv } from './testing.js';

const BLOCKHASH = '11111111111111111111111111111111';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)]! + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function fixture(simulationError: unknown = null) {
  const keypair = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, keypair.secretKey.subarray(0, 32)]),
    format: 'der', type: 'pkcs8',
  });
  let signCalls = 0;
  const signer: Signer = {
    publicKey: keypair.publicKey,
    signerId: keypair.publicKey.toBase58(),
    sign: async (message) => {
      signCalls += 1;
      return signEd25519(null, message, privateKey);
    },
  };
  const calls: string[] = [];
  const connection: ExecutionConnection = {
    async getLatestBlockhash() { calls.push('blockhash'); return { blockhash: BLOCKHASH, lastValidBlockHeight: 7 }; },
    async simulateTransaction() { calls.push('simulate'); return { value: { err: simulationError, logs: ['program log'] } }; },
    async sendRawTransaction(raw) {
      calls.push(`send:${raw.length > 0}`);
      return base58(raw.subarray(1, 65));
    },
    async confirmTransaction() { calls.push('confirm'); return { value: { err: null } }; },
    async getTransaction() { calls.push('receipt'); return { slot: 42, blockTime: 1_700_000_000, meta: { fee: 5_000 } }; },
  };
  const config = loadConfig(baseEnv({ WALLET_PUBKEY: keypair.publicKey.toBase58() }));
  const policy = new TransactionPolicy(config, keypair.publicKey);
  const tx = new Transaction({ feePayer: keypair.publicKey }).add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey, toPubkey: recipient, lamports: 1,
  }));
  return { tx, recipient, connection, signer, policy, calls, signCalls: () => signCalls };
}

describe('executeLegacyTransaction', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('enforces policy, simulates unsigned, signs once, and returns the chain receipt', async () => {
    const f = fixture();
    const result = await executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'confirmed',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    });
    expect(f.calls).toEqual(['blockhash', 'simulate', expect.stringMatching(/^send:true$/), 'confirm', 'receipt']);
    expect(f.signCalls()).toBe(1);
    expect(result.receipt).toMatchObject({
      signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/),
      slot: 42,
      fee_lamports: 5_000,
      status: 'confirmed',
    });
    expect(result.policy.messageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails simulation before signing, submitting, or spending the run reservation', async () => {
    const f = fixture({ InstructionError: [0, 'Custom'] });
    await expect(executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'confirmed',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    })).rejects.toMatchObject({ logs: ['program log'] });
    expect(f.calls).toEqual(['blockhash', 'simulate']);
    expect(f.signCalls()).toBe(0);
  });

  it('rejects policy before simulation and never asks the signer to handle it', async () => {
    const f = fixture();
    await expect(executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'confirmed',
      policyInput: { writableAccounts: [], amounts: {} },
    })).rejects.toMatchObject({
      rule: 'writable_account_allowlist',
      blockhash: BLOCKHASH,
    } satisfies Partial<PolicyRejected>);
    expect(f.calls).toEqual(['blockhash']);
    expect(f.signCalls()).toBe(0);
  });

  it('returns the deterministic signature when submission acknowledgement is ambiguous', async () => {
    const f = fixture();
    f.connection.sendRawTransaction = async () => {
      f.calls.push('send:throw');
      throw new Error('timeout');
    };
    await expect(executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'confirmed',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    })).rejects.toMatchObject({
      signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/),
      blockhash: BLOCKHASH,
      policy: { messageHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(f.calls).toEqual(['blockhash', 'simulate', 'send:throw']);
  });

  it('retries post-confirmation receipt indexing lag', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let receiptAttempts = 0;
    f.connection.getTransaction = async () => {
      f.calls.push('receipt');
      receiptAttempts += 1;
      return receiptAttempts < 3
        ? null
        : { slot: 42, blockTime: 1_700_000_000, meta: { fee: 5_000 } };
    };
    const pending = executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'confirmed',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.receipt).toMatchObject({ slot: 42, fee_lamports: 5_000 });
    expect(receiptAttempts).toBe(3);
    expect(f.calls).toEqual([
      'blockhash', 'simulate', expect.stringMatching(/^send:true$/), 'confirm',
      'receipt', 'receipt', 'receipt',
    ]);
  });
});

describe('executeVersionedTransaction', () => {
  afterEach(() => { vi.useRealTimers(); });

  function versionedFixture(simulationError: unknown = null, meta: unknown = undefined) {
    const f = fixture(simulationError);
    const message = new TransactionMessage({
      payerKey: f.signer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({
        fromPubkey: f.signer.publicKey, toPubkey: f.recipient, lamports: 1,
      })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    if (meta !== undefined) {
      f.connection.getTransaction = async () => {
        f.calls.push('receipt');
        return {
          slot: 42, blockTime: 1_700_000_000,
          meta: { fee: 5_000, ...(meta as object) },
        };
      };
    }
    return { ...f, tx };
  }

  const options = (f: ReturnType<typeof versionedFixture>) => ({
    connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'confirmed' as const,
    policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
  });

  it('writes a fresh blockhash into the v0 message and settles with receipt meta', async () => {
    const f = versionedFixture(null, {
      preBalances: [10, 0],
      postBalances: [9, 1],
      preTokenBalances: [],
      postTokenBalances: [],
    });
    const result = await executeVersionedTransaction(f.tx, options(f));
    expect(f.calls).toEqual([
      'blockhash', 'simulate', expect.stringMatching(/^send:true$/), 'confirm', 'receipt',
    ]);
    expect(f.tx.message.recentBlockhash.toString()).toBe(BLOCKHASH);
    expect(result.receipt).toMatchObject({ slot: 42, fee_lamports: 5_000, status: 'confirmed' });
    expect(result.meta).toMatchObject({ fee: 5_000, preBalances: [10, 0] });
  });

  it('fails simulation before signing or submitting', async () => {
    const f = versionedFixture({ InstructionError: [0, 'Custom'] });
    await expect(executeVersionedTransaction(f.tx, options(f)))
      .rejects.toMatchObject({ logs: ['program log'] });
    expect(f.calls).toEqual(['blockhash', 'simulate']);
    expect(f.signCalls()).toBe(0);
  });

  it('rejects policy before simulation and never signs', async () => {
    const f = versionedFixture();
    await expect(executeVersionedTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy,
      commitment: 'confirmed', policyInput: { writableAccounts: [], amounts: {} },
    })).rejects.toBeInstanceOf(PolicyRejected);
    expect(f.calls).toEqual(['blockhash']);
    expect(f.signCalls()).toBe(0);
  });

  it('returns the deterministic signature when submission is ambiguous', async () => {
    const f = versionedFixture();
    f.connection.sendRawTransaction = async () => { throw new Error('timeout'); };
    await expect(executeVersionedTransaction(f.tx, options(f))).rejects.toMatchObject({
      signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/),
      blockhash: BLOCKHASH,
    });
  });
});
