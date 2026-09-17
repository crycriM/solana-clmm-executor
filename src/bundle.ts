/**
 * Jito bundle orchestration (plan T5.3).
 *
 * Builds the refresh sequence as at most five transactions sharing one
 * blockhash, runs each through the full admission sequence (policy →
 * unsigned simulation → reservation → sign) without ever submitting one
 * individually, then forwards them once via `sendBundle`. Landing is proven
 * by inflight/live status polling plus per-signature receipts; anything
 * short of proof is `ambiguous`, never a blind retry or a solo rebroadcast.
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { PolicyInput, TransactionPolicy } from './policy.js';
import type { Signer } from './signer.js';
import type { TxReceipt } from './protocol.js';
import type { JitoClient } from './jito.js';
import {
  SimulationFailed,
  confirmedReceipt,
  encodeBase58,
  type ExecutionCommitment,
  type ExecutionConnection,
  type TransactionMeta,
} from './transactions.js';

export class BundlePreForwardError extends Error {
  constructor(reason: string, readonly innerCause?: unknown) {
    super(reason);
  }
}

export interface BundleConnection extends ExecutionConnection {
  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: ({ slot: number; err: unknown } | null)[] }>;
  getBlockHeight(): Promise<number>;
}

export interface BundleLeg {
  label: string;
  transaction: Transaction | VersionedTransaction;
  policyInput: PolicyInput;
  commitment: ExecutionCommitment;
  /**
   * Unsigned standalone simulation before signing. Only meaningful for legs
   * whose inputs exist on the current chain state; a leg funded by an earlier
   * bundle component (withdraw → swap → deposit chain) would simulate-fail on
   * balance alone, so those legs rely on their transaction-local bounds and
   * the policy binding instead. Defaults to true.
   */
  simulate?: boolean;
}

export interface BundleDependencies {
  connection: BundleConnection;
  signer: Signer;
  policy: TransactionPolicy;
  jito: JitoClient;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface BundleReceipt {
  label: string;
  receipt: TxReceipt;
  meta: TransactionMeta;
}

export type BundleOutcome =
  | {
      kind: 'landed';
      bundleId: string;
      receipts: BundleReceipt[];
      blockhash: string;
      lastValidBlockHeight: number;
      signatures: string[];
      statuses: string[];
    }
  | {
      kind: 'dropped';
      bundleId: string | null;
      reason: string;
      blockhash: string | null;
      lastValidBlockHeight: number | null;
      signatures: string[];
      statuses: string[];
    }
  | {
      kind: 'ambiguous';
      bundleId: string | null;
      reason: string;
      blockhash: string | null;
      lastValidBlockHeight: number | null;
      signatures: string[];
      statuses: string[];
    };

const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_POLL_MS = 500;

function applyBlockhash(tx: Transaction | VersionedTransaction, blockhash: string): void {
  if (tx instanceof VersionedTransaction) tx.message.recentBlockhash = blockhash;
  else tx.recentBlockhash = blockhash;
}

function signedMessage(tx: Transaction | VersionedTransaction): Uint8Array {
  return tx instanceof VersionedTransaction ? tx.message.serialize() : tx.serializeMessage();
}

function attachAndSerialize(
  tx: Transaction | VersionedTransaction,
  signer: Signer,
  signatureBytes: Buffer,
): string {
  tx.addSignature(signer.publicKey, signatureBytes);
  return encodeBase58(
    tx instanceof VersionedTransaction
      ? Buffer.from(tx.serialize())
      : tx.serialize(),
  );
}

/**
 * Admit, sign, forward, and resolve one bundle. Pre-forward failures throw
 * `BundlePreForwardError` (nothing was submitted); everything after
 * `sendBundle` resolves to a `landed`/`dropped`/`ambiguous` outcome.
 */
export async function submitBundle(
  legs: BundleLeg[],
  dependencies: BundleDependencies,
): Promise<BundleOutcome> {
  const { connection, signer, policy, jito } = dependencies;
  if (legs.length === 0 || legs.length > 5) {
    throw new BundlePreForwardError('a refresh bundle must contain between one and five transactions');
  }
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = dependencies.now ?? Date.now;
  const deadlineMs = dependencies.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_MS;

  const blockhash = await connection.getLatestBlockhash('confirmed');
  for (const leg of legs) {
    // Mirrors the sequential path (transactions.ts): the policy requires the
    // configured wallet as fee payer, and the withdrawal/deposit builders
    // leave the field unset until execution.
    if (leg.transaction instanceof Transaction && !leg.transaction.feePayer) {
      leg.transaction.feePayer = signer.publicKey;
    }
    applyBlockhash(leg.transaction, blockhash.blockhash);
  }

  const serialized: string[] = [];
  const signatures: string[] = [];
  for (const leg of legs) {
    try {
      const decision = policy.validate(leg.transaction, leg.policyInput);
      if (leg.simulate !== false) {
        const simulation = await connection.simulateTransaction(leg.transaction);
        if (simulation.value.err !== null) {
          throw new SimulationFailed(simulation.value.logs ?? [], decision, blockhash.blockhash);
        }
      }
      policy.commit(decision);
      const signatureBytes = await signer.sign(signedMessage(leg.transaction));
      signatures.push(encodeBase58(signatureBytes));
      serialized.push(attachAndSerialize(leg.transaction, signer, signatureBytes));
    } catch (error) {
      if (error instanceof SimulationFailed) throw error;
      if (error instanceof BundlePreForwardError) throw error;
      throw new BundlePreForwardError('bundle component failed admission or signing', error);
    }
  }

  let bundleId: string;
  try {
    bundleId = await jito.sendBundle(serialized);
  } catch (error) {
    // The Block Engine may still have received the request: never claim a
    // drop, never rebroadcast the components individually.
    const cause = error instanceof Error && error.message
      ? ` (${error.message.slice(0, 200)})` : '';
    return {
      kind: 'ambiguous',
      bundleId: null,
      reason: `sendBundle acknowledgement was lost before the bundle id resolved${cause}`,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      signatures,
      statuses: ['send:error'],
    };
  }

  const statuses: string[] = [`sent:${bundleId}`];
  const deadline = now() + deadlineMs;
  let finalState: 'landed' | 'settled' | 'timeout' = 'timeout';
  while (now() < deadline) {
    let inflight: Awaited<ReturnType<JitoClient['inflightStatuses']>>;
    try {
      inflight = await jito.inflightStatuses([bundleId]);
    } catch (error) {
      // The bundle was already forwarded: a status-query failure is a
      // post-forward unknown, never a provable drop.
      statuses.push('inflight:error');
      return {
        kind: 'ambiguous',
        bundleId,
        reason: `bundle status polling failed after forwarding: ${
          error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        signatures,
        statuses,
      };
    }
    const status = inflight[0];
    const transition = `inflight:${status?.status ?? 'unknown'}`;
    if (statuses.at(-1) !== transition) statuses.push(transition);
    if (status?.status === 'landed') { finalState = 'landed'; break; }
    if (status && status.status !== 'pending') { finalState = 'settled'; break; }
    await sleep(pollIntervalMs);
  }

  if (finalState === 'timeout') {
    return {
      kind: 'ambiguous',
      bundleId,
      reason: 'bundle status did not resolve before the polling deadline',
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      signatures,
      statuses,
    };
  }

  if (finalState === 'landed') {
    let live: Awaited<ReturnType<JitoClient['bundleStatuses']>> = [];
    try {
      live = await jito.bundleStatuses([bundleId]);
      statuses.push(`live:${live[0] && live[0].err !== null ? 'error' : 'clean'}`);
    } catch {
      statuses.push('live:unavailable');
    }
    if (live.some((entry) => entry.err !== null)) {
      return {
        kind: 'ambiguous',
        bundleId,
        reason: 'landed bundle reported a per-transaction error; reconcile from chain state',
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        signatures,
        statuses,
      };
    }
    const receipts: BundleReceipt[] = [];
    for (const [index, leg] of legs.entries()) {
      const signature = signatures[index]!;
      let chainTx: Awaited<ReturnType<ExecutionConnection['getTransaction']>>;
      try {
        chainTx = await confirmedReceipt(connection, signature, leg.commitment);
      } catch {
        chainTx = null;
      }
      if (!chainTx?.meta) {
        return {
          kind: 'ambiguous',
          bundleId,
          reason: 'a landed bundle component had no fetchable receipt',
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
          signatures,
          statuses,
        };
      }
      receipts.push({
        label: leg.label,
        meta: chainTx.meta,
        receipt: {
          signature,
          slot: chainTx.slot,
          block_time: chainTx.blockTime ?? null,
          fee_lamports: chainTx.meta.fee,
          compute_unit_price: null,
          status: leg.commitment === 'finalized' ? 'finalized' : 'confirmed',
        },
      });
    }
    return {
      kind: 'landed',
      bundleId,
      receipts,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      signatures,
      statuses,
    };
  }

  // A negative Block Engine status is not proof that no component landed.
  // Only "every signature absent AND the shared blockhash expired" is.
  let absent = false;
  try {
    const onChain = await connection.getSignatureStatuses(signatures);
    const noneSeen = onChain.value.every((entry) => entry === null);
    const expired = await connection.getBlockHeight() > blockhash.lastValidBlockHeight;
    statuses.push(`absence:${noneSeen ? 'signatures-absent' : 'signatures-present'}/` +
      `expiry:${expired ? 'blockhash-expired' : 'blockhash-valid'}`);
    absent = noneSeen && expired;
  } catch {
    statuses.push('absence:unavailable');
  }
  return absent
    ? {
        kind: 'dropped',
        bundleId,
        reason: 'bundle rejected before inclusion; every component signature is absent and ' +
          'the shared blockhash has expired, proving no state change',
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        signatures,
        statuses,
      }
    : {
        kind: 'ambiguous',
        bundleId,
        reason: 'bundle reported a failed status without proof that no component landed',
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        signatures,
        statuses,
      };
}

/** A wallet-funded system transfer to the pinned Jito tip account. */
export function jitoTipInstruction(
  wallet: PublicKey,
  tipAccount: PublicKey,
  lamports: number,
): ReturnType<typeof SystemProgram.transfer> {
  return SystemProgram.transfer({ fromPubkey: wallet, toPubkey: tipAccount, lamports });
}
