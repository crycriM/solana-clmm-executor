/**
 * Transaction admission policy (spec §8, test plan §6).
 *
 * This is intentionally below the verb builders: it sees the compiled
 * transaction that will be signed, rather than trusting a builder's intent.
 * It does not submit or sign.  Callers must simulate after `validate()` and
 * call `commit()` only when simulation succeeded, immediately before signing.
 */

import { LBCLMM_PROGRAM_IDS } from '@meteora-ag/dlmm';
import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import type { ExecutorConfig } from './config.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export type PolicyRule =
  | 'program_id_allowlist'
  | 'writable_account_allowlist'
  | 'pool_allowlist'
  | 'mint_allowlist'
  | 'fee_payer'
  | 'only_wallet_signer'
  | 'address_lookup_tables'
  | 'base_amount_cap'
  | 'quote_amount_cap'
  | 'sol_per_tx_cap'
  | 'sol_per_run_cap'
  | 'slippage_cap'
  | 'priority_fee_cap';

export class PolicyRejected extends Error {
  constructor(readonly rule: PolicyRule, detail: string) {
    super(detail);
  }
}

/** Known quantities from the verb builder; no client-provided tx is accepted. */
export interface PolicyAmounts {
  baseAmount?: number;
  quoteAmount?: number;
  solSpendLamports?: number;
  maxSlippageBps?: number;
}

export interface PolicyInput {
  /** Accounts expected by this verb's builder, as base58 strings. */
  writableAccounts: Iterable<string | PublicKey>;
  /** Pool/mint references the verb builder compiled into this transaction. */
  pools?: Iterable<string | PublicKey>;
  mints?: Iterable<string | PublicKey>;
  amounts: PolicyAmounts;
  /** Required to expand all writable keys of a v0 message. */
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}

export interface PolicyDecision {
  messageHash: string;
  solSpendLamports: number;
}

function reject(rule: PolicyRule, detail: string): never {
  throw new PolicyRejected(rule, detail);
}

function finiteNonNegative(value: number | undefined, rule: PolicyRule): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    reject(rule, 'amount must be a non-negative safe integer');
  }
  return value;
}

function keySet(values: Iterable<string | PublicKey>): Set<string> {
  return new Set(Array.from(values, (key) => typeof key === 'string' ? key : key.toBase58()));
}

function exceedsPriorityFeeCap(data: Buffer, maxLamports: number): boolean {
  // ComputeBudget::SetComputeUnitPrice = tag 3 followed by u64 LE micro-lamports.
  if (data.length !== 9 || data[0] !== 3) return false;
  const microLamports = data.readBigUInt64LE(1);
  return microLamports > BigInt(maxLamports) * 1_000_000n;
}

/**
 * One run-scoped, in-process counter.  It intentionally resets on restart;
 * `executor_started.run_counter_note` makes that limitation visible to audit.
 */
export class TransactionPolicy {
  private spentLamports = 0;
  private readonly programs: Set<string>;
  private readonly wallet: string;

  constructor(private readonly config: ExecutorConfig, wallet: PublicKey) {
    this.wallet = wallet.toBase58();
    this.programs = new Set([
      LBCLMM_PROGRAM_IDS['mainnet-beta'],
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
    ]);
  }

  /** Validate every signer/writable/program account of the final message. */
  validate(tx: Transaction | VersionedTransaction, input: PolicyInput): PolicyDecision {
    const allowedWritable = keySet(input.writableAccounts);
    allowedWritable.add(this.wallet);
    for (const pool of this.config.poolAllowlist) allowedWritable.add(pool);
    for (const mint of this.config.mintAllowlist) allowedWritable.add(mint);
    this.validateConfiguredKeys(input.pools, this.config.poolAllowlist, 'pool_allowlist');
    this.validateConfiguredKeys(input.mints, this.config.mintAllowlist, 'mint_allowlist');

    const solSpendLamports = finiteNonNegative(input.amounts.solSpendLamports, 'sol_per_tx_cap');
    if (solSpendLamports > this.config.maxSolPerTx * 1_000_000_000) {
      reject('sol_per_tx_cap', 'SOL spend exceeds MAX_SOL_PER_TX');
    }
    if (this.spentLamports + solSpendLamports > this.config.maxSolPerRun * 1_000_000_000) {
      reject('sol_per_run_cap', 'cumulative SOL spend exceeds MAX_SOL_PER_RUN');
    }
    if (finiteNonNegative(input.amounts.baseAmount, 'base_amount_cap') > Number.MAX_SAFE_INTEGER) {
      reject('base_amount_cap', 'base amount is not representable');
    }
    if (finiteNonNegative(input.amounts.quoteAmount, 'quote_amount_cap') > Number.MAX_SAFE_INTEGER) {
      reject('quote_amount_cap', 'quote amount is not representable');
    }
    const slippage = finiteNonNegative(input.amounts.maxSlippageBps, 'slippage_cap');
    if (slippage > this.config.maxSlippageBps) reject('slippage_cap', 'slippage exceeds cap');

    const message = tx instanceof Transaction
      ? this.validateLegacy(tx, allowedWritable)
      : this.validateVersioned(tx, allowedWritable, input.addressLookupTableAccounts);
    return { messageHash: createHash('sha256').update(message).digest('hex'), solSpendLamports };
  }

  /** Reserve only after successful simulation and just before `Signer.sign`. */
  commit(decision: PolicyDecision): void {
    if (this.spentLamports + decision.solSpendLamports > this.config.maxSolPerRun * 1_000_000_000) {
      reject('sol_per_run_cap', 'cumulative SOL spend exceeds MAX_SOL_PER_RUN');
    }
    this.spentLamports += decision.solSpendLamports;
  }

  private validateLegacy(tx: Transaction, allowedWritable: Set<string>): string {
    if (!tx.feePayer?.toBase58 || tx.feePayer.toBase58() !== this.wallet) {
      reject('fee_payer', 'wallet must be fee payer');
    }
    for (const instruction of tx.instructions) {
      this.validateInstruction(
        instruction.programId,
        instruction.keys.map((key) => ({ key: key.pubkey, isWritable: key.isWritable, isSigner: key.isSigner })),
        instruction.data,
        allowedWritable,
      );
    }
    const message = tx.compileMessage();
    const signerKeys = message.accountKeys.slice(0, message.header.numRequiredSignatures);
    this.validateSigners(signerKeys);
    return Buffer.from(tx.serializeMessage()).toString('hex');
  }

  private validateVersioned(
    tx: VersionedTransaction,
    allowedWritable: Set<string>,
    lookupTables: AddressLookupTableAccount[] | undefined,
  ): string {
    const message = tx.message;
    if (message.addressTableLookups.length > 0 && !lookupTables) {
      reject('address_lookup_tables', 'versioned transaction has unresolved lookup tables');
    }
    let keys: ReturnType<typeof message.getAccountKeys>;
    try {
      keys = message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
    } catch {
      reject('address_lookup_tables', 'could not expand versioned lookup tables');
    }
    const signerKeys = keys.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
    this.validateSigners(signerKeys);
    for (const instruction of message.compiledInstructions) {
      const program = keys.get(instruction.programIdIndex);
      if (!program) reject('program_id_allowlist', 'instruction program is unresolved');
      const accountKeys = instruction.accountKeyIndexes.map((index) => {
        const key = keys.get(index);
        if (!key) reject('address_lookup_tables', 'instruction account is unresolved');
        return {
          key,
          isSigner: index < message.header.numRequiredSignatures,
          isWritable: message.isAccountWritable(index),
        };
      });
      this.validateInstruction(program, accountKeys, Buffer.from(instruction.data), allowedWritable);
    }
    return Buffer.from(message.serialize()).toString('hex');
  }

  private validateSigners(keys: PublicKey[]): void {
    if (keys.length !== 1 || keys[0]?.toBase58() !== this.wallet) {
      reject('only_wallet_signer', 'wallet must be the only required signer');
    }
  }

  private validateConfiguredKeys(
    actual: Iterable<string | PublicKey> | undefined,
    configured: string[],
    rule: 'pool_allowlist' | 'mint_allowlist',
  ): void {
    if (!actual) return;
    const allowed = new Set(configured);
    for (const key of actual) {
      const value = typeof key === 'string' ? key : key.toBase58();
      if (!allowed.has(value)) reject(rule, `${value} is not allow-listed`);
    }
  }

  private validateInstruction(
    program: PublicKey,
    accounts: { key: PublicKey; isWritable: boolean; isSigner: boolean }[],
    data: Buffer,
    allowedWritable: Set<string>,
  ): void {
    if (!this.programs.has(program.toBase58())) {
      reject('program_id_allowlist', `program ${program.toBase58()} is not allowed`);
    }
    if (program.equals(ComputeBudgetProgram.programId)) {
      if (exceedsPriorityFeeCap(data, this.config.maxPriorityFeeLamports)) {
        reject('priority_fee_cap', 'priority fee exceeds MAX_PRIORITY_FEE_LAMPORTS');
      }
    }
    for (const account of accounts) {
      if (account.isSigner && account.key.toBase58() !== this.wallet) {
        reject('only_wallet_signer', 'a non-wallet account was marked signer');
      }
      if (account.isWritable && !allowedWritable.has(account.key.toBase58())) {
        reject('writable_account_allowlist', `unknown writable account ${account.key.toBase58()}`);
      }
    }
  }
}
