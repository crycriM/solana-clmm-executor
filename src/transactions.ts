/**
 * The only transaction execution path for M4/M5 writes.
 *
 * Verb handlers build a transaction from trusted SDK calls (or, for Jupiter
 * swaps, from builder-assembled instructions), supply the builder's expected
 * accounts/amounts to TransactionPolicy, and hand it here. This module owns
 * the irreversible sequence: blockhash → policy → unsigned simulation →
 * policy reservation → sign → submit → confirm → receipt.
 */

import { Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  PolicyRejected,
  type PolicyDecision,
  type PolicyInput,
  type TransactionPolicy,
} from './policy.js';
import type { Signer } from './signer.js';
import type { TxReceipt } from './protocol.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const RECEIPT_ATTEMPTS = 8;
const RECEIPT_INITIAL_DELAY_MS = 250;
const RECEIPT_MAX_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Encode the already-produced signature so RPC timeouts remain reconcilable. */
export function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder]! + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }
  return encoded;
}

export class SimulationFailed extends Error {
  constructor(
    readonly logs: string[],
    readonly policy?: PolicyDecision,
    readonly blockhash?: string,
  ) {
    super('transaction simulation failed');
  }
}

/** A signature might exist; callers must reconcile, never blindly retry. */
export class SubmissionAmbiguous extends Error {
  constructor(
    detail: string,
    readonly signature?: string,
    readonly receipt?: TxReceipt,
    readonly policy?: PolicyDecision,
    readonly blockhash?: string,
  ) {
    super(detail);
  }
}

/**
 * Config commitments never include web3's `processed`; the narrower alias is
 * what makes a real `Connection` structurally assignable to this surface.
 */
export type ExecutionCommitment = 'confirmed' | 'finalized';

/** The slice of `meta.tokenBalances` needed to settle realized swap amounts. */
export interface TransactionTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string };
}

export interface TransactionMeta {
  fee: number;
  preBalances?: number[] | null;
  postBalances?: number[] | null;
  preTokenBalances?: TransactionTokenBalance[] | null;
  postTokenBalances?: TransactionTokenBalance[] | null;
}

export interface ExecutionConnection {
  getLatestBlockhash(commitment: ExecutionCommitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  /** web3 legacy overload: absent signers means `sigVerify:false`. */
  simulateTransaction(tx: Transaction | VersionedTransaction): Promise<{
    value: { err: unknown; logs: string[] | null };
  }>;
  sendRawTransaction(raw: Buffer, options: { skipPreflight: boolean; preflightCommitment: ExecutionCommitment }): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment: ExecutionCommitment,
  ): Promise<{ value: { err: unknown } }>;
  getTransaction(
    signature: string,
    config: { commitment: ExecutionCommitment; maxSupportedTransactionVersion: number },
  ): Promise<{ slot: number; blockTime?: number | null; meta: TransactionMeta | null } | null>;
}

export interface ExecuteLegacyOptions {
  connection: ExecutionConnection;
  signer: Signer;
  policy: TransactionPolicy;
  policyInput: PolicyInput;
  commitment: ExecutionCommitment;
}

export interface ExecutedTransaction {
  receipt: TxReceipt;
  policy: PolicyDecision;
  /** Blockhash the signed message committed to; recorded in the verb audit. */
  blockhash: string;
  /** Confirmed-receipt fee and token balances; swap verbs settle realized amounts from these. */
  meta: TransactionMeta;
}

interface BlockhashInfo {
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Shared irreversible tail for both transaction shapes: reserve policy budget,
 * sign exactly once, submit, confirm, and fetch the authoritative receipt.
 * `finalize` receives the produced signature so the caller can attach it to
 * the message it just signed.
 */
async function admitAndSettle(
  options: ExecuteLegacyOptions,
  decision: PolicyDecision,
  blockhash: BlockhashInfo,
  message: Uint8Array,
  finalize: (signatureBytes: Buffer) => Buffer,
): Promise<{ receipt: TxReceipt; meta: TransactionMeta }> {
  const { connection, signer, policy, commitment } = options;
  // Reserve after the unsigned simulation. A signer/submission failure leaves
  // the reservation consumed, deliberately conservative until process restart.
  try {
    policy.commit(decision);
  } catch (error) {
    if (error instanceof PolicyRejected) {
      error.blockhash = blockhash.blockhash;
      error.simulationOk = true;
    }
    throw error;
  }
  const signatureBytes = await signer.sign(message);
  const serialized = finalize(signatureBytes);
  const expectedSignature = encodeBase58(signatureBytes);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(serialized, {
      skipPreflight: true,
      preflightCommitment: commitment,
    });
  } catch {
    throw new SubmissionAmbiguous(
      'transaction submission result was unavailable',
      expectedSignature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  if (signature !== expectedSignature) {
    throw new SubmissionAmbiguous(
      'RPC returned a transaction signature that did not match the signed message',
      expectedSignature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  let confirmation: Awaited<ReturnType<ExecutionConnection['confirmTransaction']>>;
  try {
    confirmation = await connection.confirmTransaction({ ...blockhash, signature }, commitment);
  } catch {
    throw new SubmissionAmbiguous(
      'transaction confirmation result was unavailable',
      signature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  if (confirmation.value.err !== null) {
    throw new SubmissionAmbiguous(
      'confirmed transaction reported an execution error',
      signature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  let chainTx: Awaited<ReturnType<ExecutionConnection['getTransaction']>>;
  try {
    chainTx = await confirmedReceipt(connection, signature, commitment);
  } catch {
    throw new SubmissionAmbiguous(
      'confirmed transaction receipt lookup failed',
      signature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  if (!chainTx?.meta) {
    throw new SubmissionAmbiguous(
      'confirmed transaction receipt was unavailable',
      signature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  return {
    receipt: {
      signature,
      slot: chainTx.slot,
      block_time: chainTx.blockTime ?? null,
      fee_lamports: chainTx.meta.fee,
      compute_unit_price: null,
      status: commitment === 'finalized' ? 'finalized' : 'confirmed',
    },
    meta: chainTx.meta,
  };
}

/**
 * PubSub confirmation can arrive before an RPC provider's transaction index
 * serves getTransaction. Retry that bounded, post-confirmation visibility lag
 * instead of reporting a submission ambiguity immediately.
 */
export async function confirmedReceipt(
  connection: ExecutionConnection,
  signature: string,
  commitment: ExecutionCommitment,
): Promise<Awaited<ReturnType<ExecutionConnection['getTransaction']>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
    try {
      const receipt = await connection.getTransaction(signature, {
        commitment,
        maxSupportedTransactionVersion: 0,
      });
      if (receipt?.meta) return receipt;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < RECEIPT_ATTEMPTS) {
      const backoff = Math.min(RECEIPT_INITIAL_DELAY_MS * (2 ** attempt), RECEIPT_MAX_DELAY_MS);
      await delay(backoff);
    }
  }
  if (lastError !== undefined) throw lastError;
  return null;
}

/**
 * Execute one SDK-built legacy transaction.  There is deliberately no public
 * "serialized transaction" input: accepting one would bypass the verb
 * builder and make the policy boundary meaningless.
 */
export async function executeLegacyTransaction(
  tx: Transaction,
  options: ExecuteLegacyOptions,
): Promise<ExecutedTransaction> {
  const { connection, signer, commitment } = options;
  if (!tx.feePayer) tx.feePayer = signer.publicKey;
  const blockhash = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = blockhash.blockhash;

  let decision: PolicyDecision;
  try {
    decision = options.policy.validate(tx, options.policyInput);
  } catch (error) {
    if (error instanceof PolicyRejected) {
      error.blockhash = blockhash.blockhash;
    }
    throw error;
  }
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err !== null) {
    throw new SimulationFailed(simulation.value.logs ?? [], decision, blockhash.blockhash);
  }
  const settled = await admitAndSettle(
    options,
    decision,
    blockhash,
    tx.serializeMessage(),
    (signatureBytes) => {
      tx.addSignature(signer.publicKey, signatureBytes);
      return tx.serialize();
    },
  );
  return { ...settled, policy: decision, blockhash: blockhash.blockhash };
}

/**
 * Execute one builder-assembled v0 transaction (the Jupiter swap path).
 * The fresh blockhash is written into the message before policy sees it, so
 * the validated message hash is the exact bytes that get signed.
 */
export async function executeVersionedTransaction(
  tx: VersionedTransaction,
  options: ExecuteLegacyOptions,
): Promise<ExecutedTransaction> {
  const { connection, signer, policy, policyInput, commitment } = options;
  const blockhash = await connection.getLatestBlockhash(commitment);
  tx.message.recentBlockhash = blockhash.blockhash;
  let decision: PolicyDecision;
  try {
    decision = policy.validate(tx, policyInput);
  } catch (error) {
    if (error instanceof PolicyRejected) {
      error.blockhash = blockhash.blockhash;
    }
    throw error;
  }
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err !== null) {
    throw new SimulationFailed(simulation.value.logs ?? [], decision, blockhash.blockhash);
  }
  const settled = await admitAndSettle(
    options,
    decision,
    blockhash,
    tx.message.serialize(),
    (signatureBytes) => {
      tx.addSignature(signer.publicKey, signatureBytes);
      return Buffer.from(tx.serialize());
    },
  );
  return { ...settled, policy: decision, blockhash: blockhash.blockhash };
}
