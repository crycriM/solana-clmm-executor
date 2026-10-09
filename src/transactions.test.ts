import { createPrivateKey, sign as signEd25519 } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
} from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { PolicyRejected, TransactionPolicy } from './policy.js';
import type { Signer } from './signer.js';
import {
  ConfirmedTransactionFailed,
  executeLegacyTransaction,
  SubmissionAmbiguous,
  TransactionDropped,
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

  it('classifies a landed program failure after confirmation throws using its receipt', async () => {
    const f = fixture();
    const chainError = { InstructionError: [2, { Custom: 6004 }] };
    f.connection.confirmTransaction = async () => {
      f.calls.push('confirm:throw');
      throw new Error('subscription result unavailable');
    };
    f.connection.getTransaction = async () => {
      f.calls.push('receipt');
      return { slot: 42, blockTime: 1_700_000_000, meta: { fee: 5_000, err: chainError } };
    };
    await expect(executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'finalized',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    })).rejects.toMatchObject({
      receipt: { signature: expect.any(String), slot: 42, block_time: 1_700_000_000,
        fee_lamports: 5_000, compute_unit_price: null, status: 'failed' },
      chainError,
    } satisfies Partial<ConfirmedTransactionFailed>);
    expect(f.calls).toEqual(['blockhash', 'simulate', expect.stringMatching(/^send:true$/),
      'confirm:throw', 'receipt']);
  });

  it('rebroadcasts the same signed bytes until the first dropped send is replaced', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const sent: Buffer[] = [];
    let landed!: () => void;
    const onChain = new Promise<void>((resolve) => { landed = resolve; });
    // The cluster ignores the first send (dropped) and includes the second.
    f.connection.sendRawTransaction = async (raw) => {
      sent.push(Buffer.from(raw));
      if (sent.length === 2) landed();
      return base58(raw.subarray(1, 65));
    };
    f.connection.confirmTransaction = async () => { await onChain; return { value: { err: null } }; };
    const run = executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'finalized',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).resolves.toMatchObject({ receipt: { slot: 42, status: 'finalized' } });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.equals(sent[0]!)).toBe(true);
    expect(f.signCalls()).toBe(1);
    // Settled: the timer is cleared, nothing is sent after the receipt.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(2);
  });

  it('keeps rebroadcasting when a send errors, and stops when confirmation throws', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let sends = 0;
    f.connection.sendRawTransaction = async (raw) => {
      sends += 1;
      if (sends > 1) throw new Error('rpc busy');
      return base58(raw.subarray(1, 65));
    };
    f.connection.confirmTransaction = () => new Promise((_, reject) => { setTimeout(() => reject(new Error('expired')), 5_000); });
    const run = executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'finalized',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(run).resolves.toMatchObject({ receipt: { status: 'finalized' } });
    expect(sends).toBe(3);  // original + rebroadcasts at 2 s and 4 s, none after the throw
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toBe(3);
  });

  describe('dropped transaction retry', () => {
    const CAP = 50_000;  // retryPriorityFeeLamports; the test policy allows 100,000
    const LIMIT = 600_000;

    /** Blockhash expiry on every attempt unless `landsOnAttempt` is reached; statuses say "unknown". */
    function dropFixture(opts: { landsOnAttempt?: number; confirmError?: Error; statusFound?: boolean; withLimit?: boolean } = {}) {
      const f = fixture();
      if (opts.withLimit !== false) f.tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: LIMIT }));
      const sent: Buffer[] = [];
      let statusCalls = 0;
      f.connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 7 });
      f.connection.sendRawTransaction = async (raw) => { sent.push(Buffer.from(raw)); return base58(raw.subarray(1, 65)); };
      f.connection.confirmTransaction = async ({ signature }) => {
        if (sent.length >= (opts.landsOnAttempt ?? Infinity)) return { value: { err: null } };
        throw opts.confirmError ?? new TransactionExpiredBlockheightExceededError(signature);
      };
      f.connection.getTransaction = async () =>
        (sent.length >= (opts.landsOnAttempt ?? Infinity) ? { slot: 42, blockTime: 1_700_000_000, meta: { fee: 5_000 } } : null);
      f.connection.getSignatureStatuses = async () => {
        statusCalls += 1;
        return { value: [opts.statusFound ? { confirmationStatus: 'confirmed' } : null] };
      };
      const run = () => executeLegacyTransaction(f.tx, {
        connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'finalized',
        policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
        retryPriorityFeeLamports: CAP,
      });
      return { f, sent, run, statusCalls: () => statusCalls };
    }
    const computeBudget = (raw: Buffer, tag: number) => Transaction.from(raw).instructions.filter(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === tag);

    it('re-sends a provably dropped transaction once, with a fresh blockhash and a capped priority fee', async () => {
      vi.useFakeTimers();
      const { f, sent, run } = dropFixture({ landsOnAttempt: 2 });
      const result = run();
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ receipt: { slot: 42, status: 'finalized' } });
      expect(sent).toHaveLength(2);
      expect(f.signCalls()).toBe(2);
      expect(computeBudget(sent[0]!, 3)).toHaveLength(0);  // first attempt: no priority fee
      const [price] = computeBudget(sent[1]!, 3);
      const micro = price!.data.readBigUInt64LE(1);
      expect(micro).toBe(BigInt(Math.floor((CAP * 1_000_000) / LIMIT)));
      expect((micro * BigInt(LIMIT) + 999_999n) / 1_000_000n <= BigInt(CAP)).toBe(true);
      expect(Transaction.from(sent[1]!).recentBlockhash).not.toBe(Transaction.from(sent[0]!).recentBlockhash);
    });

    it('does not retry when the signature is found on chain after expiry', async () => {
      vi.useFakeTimers();
      const { f, sent, run } = dropFixture({ statusFound: true });
      const result = expect(run()).rejects.toSatisfy(
        (e) => e instanceof SubmissionAmbiguous && !(e instanceof TransactionDropped));
      await vi.runAllTimersAsync();
      await result;
      expect(sent).toHaveLength(1);
      expect(f.signCalls()).toBe(1);
    });

    it('does not retry when expiry is not proven (confirmation timed out)', async () => {
      vi.useFakeTimers();
      const { f, sent, run, statusCalls } = dropFixture({ confirmError: new Error('timeout') });
      const result = expect(run()).rejects.toSatisfy(
        (e) => e instanceof SubmissionAmbiguous && !(e instanceof TransactionDropped));
      await vi.runAllTimersAsync();
      await result;
      expect(sent).toHaveLength(1);
      expect(f.signCalls()).toBe(1);
      expect(statusCalls()).toBe(0);
    });

    it('retries at most once, then reports the second drop as ambiguous', async () => {
      vi.useFakeTimers();
      const { f, sent, run } = dropFixture();
      const result = expect(run()).rejects.toBeInstanceOf(TransactionDropped);
      await vi.runAllTimersAsync();
      await result;
      expect(sent).toHaveLength(2);
      expect(f.signCalls()).toBe(2);
    });

    it('retries without a price when the transaction has no explicit compute-unit limit', async () => {
      vi.useFakeTimers();
      const { sent, run } = dropFixture({ landsOnAttempt: 2, withLimit: false });
      const result = run();
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ receipt: { slot: 42 } });
      expect(sent).toHaveLength(2);
      expect(computeBudget(sent[1]!, 3)).toHaveLength(0);
    });
  });

  it('accepts a successful receipt when confirmation throws', async () => {
    const f = fixture();
    f.connection.confirmTransaction = async () => {
      f.calls.push('confirm:throw');
      throw new Error('subscription result unavailable');
    };
    const result = await executeLegacyTransaction(f.tx, {
      connection: f.connection, signer: f.signer, policy: f.policy, commitment: 'finalized',
      policyInput: { writableAccounts: [f.recipient], amounts: { solSpendLamports: 1 } },
    });
    expect(result.receipt).toMatchObject({ slot: 42, status: 'finalized' });
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
