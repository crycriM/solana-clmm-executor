/**
 * The only transaction execution path for M4/M5 writes.
 *
 * Verb handlers build a transaction from trusted SDK calls, supply the
 * builder's expected accounts/amounts to TransactionPolicy, and hand it here. This module owns
 * the irreversible sequence: blockhash → policy → unsigned simulation →
 * policy reservation → sign → submit → confirm → receipt.
 */

import {
  ComputeBudgetProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  VersionedTransaction,
} from '@solana/web3.js';
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
// A single unprioritized send can be dropped (met-usdc, 2026-10-07: blockhash expired, never landed).
const REBROADCAST_INTERVAL_MS = 2_000;
// Pause between the two "signature is nowhere on chain" checks that gate a retry.
const STATUS_RECHECK_MS = 2_000;

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
 * Never landed and never can: the blockhash expired and the signature is absent
 * on chain on two checks. Still a SubmissionAmbiguous to every other caller;
 * `executeLegacyTransaction` alone uses it to retry once.
 */
export class TransactionDropped extends SubmissionAmbiguous {}

/** The chain receipt proves that a submitted transaction failed atomically. */
export class ConfirmedTransactionFailed extends Error {
  constructor(
    readonly receipt: TxReceipt,
    readonly chainError: unknown,
    readonly policy?: PolicyDecision,
    readonly blockhash?: string,
  ) {
    super('confirmed transaction failed on chain');
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
  err?: unknown;
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
  /** Gates the dropped-transaction retry; a connection without it never retries. */
  getSignatureStatuses?(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{ value: Array<unknown | null> }>;
}

export interface ExecuteLegacyOptions {
  connection: ExecutionConnection;
  signer: Signer;
  policy: TransactionPolicy;
  policyInput: PolicyInput;
  commitment: ExecutionCommitment;
  /**
   * Priority-fee ceiling for the single retry of a provably dropped transaction
   * (MAX_PRIORITY_FEE_LAMPORTS). First attempts never carry a priority fee.
   */
  retryPriorityFeeLamports?: number;
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

/** True only if the signature is unknown to the cluster on two checks, history included. */
async function signatureAbsent(connection: ExecutionConnection, signature: string): Promise<boolean> {
  if (!connection.getSignatureStatuses) return false;
  try {
    for (let check = 0; check < 2; check += 1) {
      if (check > 0) await delay(STATUS_RECHECK_MS);
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (value[0] != null) return false;
    }
    return true;
  } catch {
    return false;
  }
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
  let confirmation: Awaited<ReturnType<ExecutionConnection['confirmTransaction']>> | null = null;
  let expired = false;
  // Same signed bytes, same signature: a duplicate send executes at most once, and
  // after the blockhash expires the cluster rejects it. Errors are not informative here.
  const rebroadcast = setInterval(() => {
    connection.sendRawTransaction(serialized, { skipPreflight: true, preflightCommitment: commitment })
      .catch(() => undefined);
  }, REBROADCAST_INTERVAL_MS);
  try {
    confirmation = await connection.confirmTransaction({ ...blockhash, signature }, commitment);
  } catch (error) {
    // A confirmation exception does not tell us whether the transaction landed.
    // The indexed receipt can still prove success or a failed, fee-paying write.
    // Only a blockheight expiry proves the blockhash can no longer be included.
    expired = error instanceof TransactionExpiredBlockheightExceededError;
  } finally {
    clearInterval(rebroadcast);
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
    const Outcome = expired && await signatureAbsent(connection, signature)
      ? TransactionDropped : SubmissionAmbiguous;
    throw new Outcome(
      'confirmed transaction receipt was unavailable',
      signature,
      undefined,
      decision,
      blockhash.blockhash,
    );
  }
  const receipt: TxReceipt = {
    signature,
    slot: chainTx.slot,
    block_time: chainTx.blockTime ?? null,
    fee_lamports: chainTx.meta.fee,
    compute_unit_price: null,
    status: chainTx.meta.err == null
      ? (commitment === 'finalized' ? 'finalized' : 'confirmed')
      : 'failed',
  };
  if (chainTx.meta.err != null) {
    throw new ConfirmedTransactionFailed(receipt, chainTx.meta.err, decision, blockhash.blockhash);
  }
  if (confirmation && confirmation.value.err != null) {
    throw new SubmissionAmbiguous(
      'confirmation disagreed with the transaction receipt',
      signature,
      receipt,
      decision,
      blockhash.blockhash,
    );
  }
  return {
    receipt,
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
  try {
    return await executeOnce(tx, options);
  } catch (error) {
    if (!(error instanceof TransactionDropped)) throw error;
    // The first signature is provably dead, so a second message cannot double-execute.
    // It re-runs policy and simulation and commits the run budget again (conservative).
    return executeOnce(withRetryPriorityFee(tx, options.retryPriorityFeeLamports), options);
  }
}

/** Same instructions plus a compute-unit price that spends at most `capLamports`. */
function withRetryPriorityFee(tx: Transaction, capLamports = 0): Transaction {
  const retry = new Transaction({ feePayer: tx.feePayer }).add(...tx.instructions);
  // The policy requires an explicit limit next to a nonzero price; without one, retry unprioritized.
  const limit = tx.instructions.find((instruction) =>
    instruction.programId.equals(ComputeBudgetProgram.programId)
    && instruction.data.length === 5 && instruction.data[0] === 2)?.data.readUInt32LE(1);
  const price = limit ? Math.floor((capLamports * 1_000_000) / limit) : 0;
  if (price > 0) retry.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return retry;
}

async function executeOnce(
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
