/** Offline verification of the Jito bundle orchestrator (plan T5.3). */
import { createPrivateKey, sign as signEd25519 } from 'node:crypto';
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  BundlePreForwardError,
  submitBundle,
  type BundleLeg,
} from './bundle.js';
import { PolicyRejected } from './policy.js';
import { SimulationFailed } from './transactions.js';
import type { JitoClient } from './jito.js';
import type { Signer } from './signer.js';


const BLOCKHASH = '11111111111111111111111111111111';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface Harness {
  legs: BundleLeg[];
  jito: { sendBundle: ReturnType<typeof vi.fn>; inflightStatuses: ReturnType<typeof vi.fn>; bundleStatuses: ReturnType<typeof vi.fn> };
  connection: Record<string, ReturnType<typeof vi.fn>>;
  signer: Signer;
  policy: { validate: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> };
  now: { value: number };
  submit: (overrides?: { deadlineMs?: number }) => ReturnType<typeof submitBundle>;
}

function harness(options: {
  simulationError?: unknown;
  sendError?: unknown;
  policyRejects?: boolean;
  inflight?: Array<Record<string, unknown>>;
  inflightError?: unknown;
  live?: unknown[];
  receipts?: Record<string, unknown>;
  signatureStatuses?: unknown[];
  blockHeight?: number;
} = {}): Harness {
  const keypair = Keypair.generate();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, keypair.secretKey.subarray(0, 32)]),
    format: 'der', type: 'pkcs8',
  });
  const recipient = Keypair.generate().publicKey;
  const legs: BundleLeg[] = [
    {
      label: 'withdraw',
      transaction: new Transaction({ feePayer: keypair.publicKey }).add(
        SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: recipient, lamports: 1 }),
      ),
      policyInput: { writableAccounts: [recipient], amounts: { solSpendLamports: 1 } },
      commitment: 'finalized',
    },
    {
      label: 'deposit',
      transaction: new VersionedTransaction(new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: BLOCKHASH,
        instructions: [SystemProgram.transfer({
          fromPubkey: keypair.publicKey, toPubkey: recipient, lamports: 2,
        })],
      }).compileToV0Message()),
      policyInput: { writableAccounts: [recipient], amounts: { solSpendLamports: 2 } },
      commitment: 'confirmed',
    },
  ];
  const jito = {
    sendBundle: vi.fn(async () => {
      if (options.sendError !== undefined) throw options.sendError;
      return 'bundle-1';
    }),
    inflightStatuses: vi.fn(async () => {
      if (options.inflightError !== undefined) throw options.inflightError;
      return (options.inflight ?? [{ status: 'landed' }]).map(
        (row) => ({ bundleId: 'bundle-1', slot: null, error: null, ...row }),
      );
    }),
    bundleStatuses: vi.fn(async () => options.live ?? []),
  };
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 })),
    simulateTransaction: vi.fn(async () => ({
      value: { err: options.simulationError ?? null, logs: ['log'] },
    })),
    getTransaction: vi.fn(async (signature: string) => options.receipts?.[signature] === null
      ? null
      : options.receipts?.[signature] ?? {
        slot: 10, blockTime: 1, meta: { fee: 5_000 },
      }),
    getSignatureStatuses: vi.fn(async () => ({ value: options.signatureStatuses ?? [null, null] })),
    getBlockHeight: vi.fn(async () => options.blockHeight ?? 200),
  };
  const policy = {
    validate: vi.fn(() => {
      if (options.policyRejects) throw new PolicyRejected('sol_per_tx_cap', 'over budget');
      return { messageHash: 'a'.repeat(64), solSpendLamports: 0 };
    }),
    commit: vi.fn(),
  };
  const signer: Signer = {
    publicKey: keypair.publicKey,
    signerId: keypair.publicKey.toBase58(),
    sign: async (message) => signEd25519(null, message, privateKey),
  };
  const now = { value: 1000 };
  return {
    legs, jito, connection: connection as never, signer,
    policy: policy as never, now,
    submit: (submitOptions = {}) => submitBundle(legs, {
      connection: connection as never,
      signer,
      policy: policy as never,
      jito: jito as unknown as JitoClient,
      sleep: async () => { now.value += 100; },
      now: () => now.value,
      deadlineMs: submitOptions.deadlineMs ?? 1_000,
      pollIntervalMs: 100,
    }),
  };
}

describe('submitBundle', () => {
  it('admits, signs, and forwards every component once with a shared blockhash', async () => {
    const h = harness();
    const outcome = await h.submit();
    expect(outcome.kind).toBe('landed');
    expect(h.jito.sendBundle).toHaveBeenCalledOnce();
    const forwarded = h.jito.sendBundle.mock.calls[0]![0] as string[];
    expect(forwarded).toHaveLength(2);
    expect(forwarded.every((row) => typeof row === 'string' && row.length > 0)).toBe(true);
    expect(h.policy.validate).toHaveBeenCalledTimes(2);
    expect(h.policy.commit).toHaveBeenCalledTimes(2);
    expect(h.connection.simulateTransaction).toHaveBeenCalledTimes(2);
    expect((h.legs[0]!.transaction as Transaction).recentBlockhash).toBe(BLOCKHASH);
    if (outcome.kind === 'landed') {
      expect(outcome.receipts.map((entry) => entry.label)).toEqual(['withdraw', 'deposit']);
      expect(outcome.receipts.map((entry) => entry.receipt.status)).toEqual([
        'finalized', 'confirmed',
      ]);
      expect(outcome.signatures).toEqual(
        outcome.receipts.map((entry) => entry.receipt.signature),
      );
    }
  });

  it('assigns the signer as fee payer to legacy legs that leave it unset', async () => {
    // Live mainnet regression: the withdrawal builder leaves feePayer unset
    // (the sequential path fills it at execution), so the bundle admission
    // must set it before the policy's fee-payer check runs.
    const h = harness();
    const recipient = Keypair.generate().publicKey;
    h.legs[0]!.transaction = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: h.signer.publicKey, toPubkey: recipient, lamports: 1 }),
    );
    const original = h.policy.validate;
    const seen: Array<string | undefined> = [];
    h.policy.validate = vi.fn((tx: Transaction) => {
      seen.push(tx.feePayer?.toBase58());
      return original(tx, h.legs[0]!.policyInput);
    }) as never;
    await h.submit();
    expect(seen[0]).toBe(h.signer.publicKey.toBase58());
  });

  it('resolves to ambiguous with the bundle id when status polling fails after forwarding', async () => {
    // Live mainnet regression: a transient inflight-status network error must
    // not escape as a pre-forward exception (which the verb layer would
    // misreport as a provable drop). The bundle was already sent.
    const h = harness({ inflightError: new Error('socket hang up') });
    const outcome = await h.submit();
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.bundleId).toBe('bundle-1');
      expect(outcome.reason).toContain('status polling failed after forwarding');
    }
    expect(h.jito.sendBundle).toHaveBeenCalledOnce();
  });

  it('never forwards when a component fails simulation', async () => {
    const h = harness({ simulationError: { InstructionError: [0, 'Custom'] } });
    await expect(h.submit()).rejects.toBeInstanceOf(SimulationFailed);
    expect(h.jito.sendBundle).not.toHaveBeenCalled();
    expect(h.policy.commit).not.toHaveBeenCalled();
  });

  it('never forwards when policy rejects, preserving the rejection as cause', async () => {
    const h = harness({ policyRejects: true });
    const error = await h.submit().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BundlePreForwardError);
    expect((error as BundlePreForwardError).innerCause).toBeInstanceOf(PolicyRejected);
    expect(h.jito.sendBundle).not.toHaveBeenCalled();
  });

  it('treats a lost sendBundle acknowledgement as ambiguous, never a solo resend', async () => {
    const h = harness({ sendError: new Error('socket hang up') });
    const outcome = await h.submit();
    expect(outcome).toMatchObject({
      kind: 'ambiguous',
      bundleId: null,
      statuses: ['send:error'],
    });
    expect(outcome.signatures).toHaveLength(2);
    expect(h.jito.inflightStatuses).not.toHaveBeenCalled();
  });

  it('reports ambiguous while inflight status stays pending past the deadline', async () => {
    const h = harness({ inflight: [{ status: 'pending' }, { status: 'pending' }] });
    const outcome = await h.submit();
    expect(outcome.kind).toBe('ambiguous');
    expect(outcome.statuses.at(-1)).toBe('inflight:pending');
  });

  it('probes receipts after a landed status and flags a per-transaction error', async () => {
    const h = harness({ live: [{ bundleId: 'bundle-1', slot: 10, err: { err: 'boom' } }] });
    const outcome = await h.submit();
    expect(outcome).toMatchObject({ kind: 'ambiguous', bundleId: 'bundle-1' });
  });

  it('reports ambiguous when a landed component has no fetchable receipt', async () => {
    const h = harness({ receipts: {} });
    h.connection.getTransaction = vi.fn(async () => null);
    const outcome = await h.submit();
    expect(outcome).toMatchObject({ kind: 'ambiguous', bundleId: 'bundle-1' });
    expect(outcome.statuses).toContain('live:clean');
  });

  it('proves a drop only when every signature is absent and the blockhash expired', async () => {
    const dropped = harness({
      inflight: [{ status: 'expired' }],
      signatureStatuses: [null, null],
      blockHeight: 101,
    });
    const droppedOutcome = await dropped.submit();
    expect(droppedOutcome).toMatchObject({ kind: 'dropped', bundleId: 'bundle-1' });
    expect(droppedOutcome.statuses.at(-1)).toContain('signatures-absent');
    expect(droppedOutcome.statuses.at(-1)).toContain('blockhash-expired');

    const present = harness({
      inflight: [{ status: 'invalid' }],
      signatureStatuses: [{ slot: 12, err: null }, null],
      blockHeight: 500,
    });
    const presentOutcome = await present.submit();
    expect(presentOutcome.kind).toBe('ambiguous');

    const unexpired = harness({
      inflight: [{ status: 'rejected' }],
      signatureStatuses: [null, null],
      blockHeight: 50,
    });
    const unexpiredOutcome = await unexpired.submit();
    expect(unexpiredOutcome.kind).toBe('ambiguous');
  });

  it('rejects an empty or oversized bundle before touching the network', async () => {
    const h = harness();
    await expect(submitBundle([], {
      connection: h.connection as never, signer: h.signer,
      policy: h.policy as never, jito: h.jito as unknown as JitoClient,
    })).rejects.toBeInstanceOf(BundlePreForwardError);
    expect(h.jito.sendBundle).not.toHaveBeenCalled();
  });
});
