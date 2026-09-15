/**
 * The only legacy-transaction execution path for M4.
 *
 * Verb handlers build a transaction from trusted SDK calls, supply the
 * builder's expected accounts/amounts to TransactionPolicy, and hand it here.
 * This module owns the irreversible sequence: blockhash → policy → unsigned
 * simulation → policy reservation → sign → submit → confirm → receipt.
 */

import { Transaction } from '@solana/web3.js';
import {
  PolicyRejected,
  type PolicyDecision,
  type PolicyInput,
  type TransactionPolicy,
} from './policy.js';
import type { Signer } from './signer.js';
import type { TxReceipt } from './protocol.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode the already-produced signature so RPC timeouts remain reconcilable. */
function base58(bytes: Uint8Array): string {
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

export interface ExecutionConnection {
  getLatestBlockhash(commitment: ExecutionCommitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  /** web3 legacy overload: absent signers means `sigVerify:false`. */
  simulateTransaction(tx: Transaction): Promise<{
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
  ): Promise<{ slot: number; blockTime?: number | null; meta: { fee: number } | null } | null>;
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
  const { connection, signer, policy, policyInput, commitment } = options;
  if (!tx.feePayer) tx.feePayer = signer.publicKey;
  const blockhash = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = blockhash.blockhash;

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
  const signatureBytes = await signer.sign(tx.serializeMessage());
  tx.addSignature(signer.publicKey, signatureBytes);
  const expectedSignature = base58(signatureBytes);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
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
    chainTx = await connection.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
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
    policy: decision,
    blockhash: blockhash.blockhash,
    receipt: {
      signature,
      slot: chainTx.slot,
      block_time: chainTx.blockTime ?? null,
      fee_lamports: chainTx.meta.fee,
      compute_unit_price: null,
      status: commitment === 'finalized' ? 'finalized' : 'confirmed',
    },
  };
}
