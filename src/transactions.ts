/**
 * The only legacy-transaction execution path for M4.
 *
 * Verb handlers build a transaction from trusted SDK calls, supply the
 * builder's expected accounts/amounts to TransactionPolicy, and hand it here.
 * This module owns the irreversible sequence: blockhash → policy → unsigned
 * simulation → policy reservation → sign → submit → confirm → receipt.
 */

import { Transaction, type Commitment } from '@solana/web3.js';
import type { PolicyDecision, PolicyInput, TransactionPolicy } from './policy.js';
import type { Signer } from './signer.js';
import type { TxReceipt } from './protocol.js';

export class SimulationFailed extends Error {
  constructor(readonly logs: string[]) {
    super('transaction simulation failed');
  }
}

/** A signature might exist; callers must reconcile, never blindly retry. */
export class SubmissionAmbiguous extends Error {
  constructor(detail: string) {
    super(detail);
  }
}

export interface ExecutionConnection {
  getLatestBlockhash(commitment: Commitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  /** web3 legacy overload: absent signers means `sigVerify:false`. */
  simulateTransaction(tx: Transaction): Promise<{
    value: { err: unknown; logs: string[] | null };
  }>;
  sendRawTransaction(raw: Buffer, options: { skipPreflight: boolean; preflightCommitment: Commitment }): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment: Commitment,
  ): Promise<{ value: { err: unknown } }>;
  getTransaction(
    signature: string,
    config: { commitment: Commitment; maxSupportedTransactionVersion: number },
  ): Promise<{ slot: number; blockTime: number | null; meta: { fee: number } | null } | null>;
}

export interface ExecuteLegacyOptions {
  connection: ExecutionConnection;
  signer: Signer;
  policy: TransactionPolicy;
  policyInput: PolicyInput;
  commitment: Commitment;
}

export interface ExecutedTransaction {
  receipt: TxReceipt;
  policy: PolicyDecision;
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

  const decision = policy.validate(tx, policyInput);
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err !== null) {
    throw new SimulationFailed(simulation.value.logs ?? []);
  }

  // Reserve after the unsigned simulation. A signer/submission failure leaves
  // the reservation consumed, deliberately conservative until process restart.
  policy.commit(decision);
  tx.addSignature(signer.publicKey, await signer.sign(tx.serializeMessage()));
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    preflightCommitment: commitment,
  });
  const confirmation = await connection.confirmTransaction({ ...blockhash, signature }, commitment);
  if (confirmation.value.err !== null) {
    throw new SubmissionAmbiguous('confirmed transaction reported an execution error');
  }
  const chainTx = await connection.getTransaction(signature, {
    commitment,
    maxSupportedTransactionVersion: 0,
  });
  if (!chainTx?.meta) {
    throw new SubmissionAmbiguous('confirmed transaction receipt was unavailable');
  }
  return {
    policy: decision,
    receipt: {
      signature,
      slot: chainTx.slot,
      block_time: chainTx.blockTime,
      fee_lamports: chainTx.meta.fee,
      compute_unit_price: null,
      status: commitment === 'finalized' ? 'finalized' : 'confirmed',
    },
  };
}
