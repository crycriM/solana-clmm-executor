/**
 * Transaction admission policy (spec §8, test plan §6).
 *
 * This is intentionally below the verb builders: it sees the compiled
 * transaction that will be signed, rather than trusting a builder's intent.
 * It does not submit or sign.  Callers must simulate after `validate()` and
 * call `commit()` only when simulation succeeded, immediately before signing.
 */

import BN from 'bn.js';
import {
  LBCLMM_PROGRAM_IDS,
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveBinArrayBitmapExtension,
  deriveEventAuthority,
  derivePosition,
  getBinArraysRequiredByPositionRange,
  isOverflowDefaultBinArrayBitmap,
  MEMO_PROGRAM_ID,
} from '@meteora-ag/dlmm';
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
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR,
  decodeAddLiquidityOneSidePayload,
  type NativeBinWeight,
} from './dlmmWeighted.js';
import {
  INITIALIZE_BIN_ARRAY_DISCRIMINATOR,
  INITIALIZE_BITMAP_EXTENSION_DISCRIMINATOR,
  INITIALIZE_POSITION_PDA_DISCRIMINATOR,
} from './dlmmAccounts.js';
import {
  CLAIM_FEE_2_DISCRIMINATOR,
  CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR,
  REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR,
  decodeRemoveLiquidityByRangePayload,
} from './dlmmWithdraw.js';

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
  | 'active_bin_slippage_cap'
  | 'native_deposit_binding'
  | 'native_withdrawal_binding'
  | 'priority_fee_cap';

export class PolicyRejected extends Error {
  /** Execution-path context attached after blockhash acquisition; not policy input. */
  blockhash?: string;
  simulationOk?: boolean;

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
  maxActiveBinSlippage?: number;
}

export interface PolicyInput {
  /** Accounts expected by this verb's builder, as base58 strings. */
  writableAccounts: Iterable<string | PublicKey>;
  /** Pool/mint references the verb builder compiled into this transaction. */
  pools?: Iterable<string | PublicKey>;
  mints?: Iterable<string | PublicKey>;
  amounts: PolicyAmounts;
  /** Expected native Meteora deposit fields; policy decodes the final message. */
  nativeDeposit?: {
    position: string | PublicKey;
    pool: string | PublicKey;
    userToken: string | PublicKey;
    reserve: string | PublicKey;
    tokenMint: string | PublicKey;
    tokenProgram: string | PublicKey;
    binArrayLower: string | PublicKey;
    binArrayUpper: string | PublicKey;
    bitmapExtension?: string | PublicKey | null;
    positionLowerBinId: number;
    positionWidth: number;
    lowerBinArrayIndex: bigint;
    upperBinArrayIndex: bigint;
    amountRaw: bigint;
    activeId: number;
    maxActiveBinSlippage: number;
    weights: NativeBinWeight[];
  };
  nativeWithdrawal?: {
    position: string | PublicKey;
    pool: string | PublicKey;
    wallet: string | PublicKey;
    userTokenX: string | PublicKey;
    userTokenY: string | PublicKey;
    reserveX: string | PublicKey;
    reserveY: string | PublicKey;
    tokenXMint: string | PublicKey;
    tokenYMint: string | PublicKey;
    tokenXProgram: string | PublicKey;
    tokenYProgram: string | PublicKey;
    bitmapExtension: string | PublicKey | null;
    binArrays: (string | PublicKey)[];
    fromBinId: number;
    toBinId: number;
    bpsToRemove: number;
    claimAndClose: boolean;
  };
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

interface ComputeBudgetInstructionData {
  program: PublicKey;
  data: Buffer;
}

interface DecodedInstruction {
  program: PublicKey;
  accounts: PublicKey[];
  data: Buffer;
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
    // Anchor encodes an absent optional account as the instruction program ID;
    // preserve the IDL's writable flag while allowing only known programs.
    for (const program of this.programs) allowedWritable.add(program);
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
    const activeBinSlippage = finiteNonNegative(
      input.amounts.maxActiveBinSlippage,
      'active_bin_slippage_cap',
    );
    if (activeBinSlippage > this.config.maxActiveBinSlippageBins) {
      reject('active_bin_slippage_cap', 'active-bin slippage exceeds cap');
    }

    const message = tx instanceof Transaction
      ? this.validateLegacy(tx, allowedWritable, input.nativeDeposit, input.nativeWithdrawal)
      : this.validateVersioned(
          tx,
          allowedWritable,
          input.addressLookupTableAccounts,
          input.nativeDeposit,
          input.nativeWithdrawal,
        );
    return { messageHash: createHash('sha256').update(message).digest('hex'), solSpendLamports };
  }

  /** Reserve only after successful simulation and just before `Signer.sign`. */
  commit(decision: PolicyDecision): void {
    if (this.spentLamports + decision.solSpendLamports > this.config.maxSolPerRun * 1_000_000_000) {
      reject('sol_per_run_cap', 'cumulative SOL spend exceeds MAX_SOL_PER_RUN');
    }
    this.spentLamports += decision.solSpendLamports;
  }

  private validateLegacy(
    tx: Transaction,
    allowedWritable: Set<string>,
    nativeDeposit: PolicyInput['nativeDeposit'],
    nativeWithdrawal: PolicyInput['nativeWithdrawal'],
  ): string {
    if (!tx.feePayer?.toBase58 || tx.feePayer.toBase58() !== this.wallet) {
      reject('fee_payer', 'wallet must be fee payer');
    }
    const computeBudget = tx.instructions.map((instruction) => ({
      program: instruction.programId, data: instruction.data,
    }));
    for (const instruction of tx.instructions) {
      this.validateInstruction(
        instruction.programId,
        instruction.keys.map((key) => ({ key: key.pubkey, isWritable: key.isWritable, isSigner: key.isSigner })),
        instruction.data,
        allowedWritable,
      );
    }
    this.validateNativeDepositBinding(
      tx.instructions.map((instruction) => ({
        program: instruction.programId,
        accounts: instruction.keys.map((key) => key.pubkey),
        data: instruction.data,
      })),
      nativeDeposit,
    );
    this.validateNativeWithdrawalBinding(
      tx.instructions.map((instruction) => ({
        program: instruction.programId,
        accounts: instruction.keys.map((key) => key.pubkey),
        data: instruction.data,
      })),
      nativeWithdrawal,
    );
    const message = tx.compileMessage();
    const signerKeys = message.accountKeys.slice(0, message.header.numRequiredSignatures);
    this.validateSigners(signerKeys);
    this.validatePriorityFee(computeBudget);
    return Buffer.from(tx.serializeMessage()).toString('hex');
  }

  private validateVersioned(
    tx: VersionedTransaction,
    allowedWritable: Set<string>,
    lookupTables: AddressLookupTableAccount[] | undefined,
    nativeDeposit: PolicyInput['nativeDeposit'],
    nativeWithdrawal: PolicyInput['nativeWithdrawal'],
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
    const computeBudget: ComputeBudgetInstructionData[] = [];
    const decodedInstructions: DecodedInstruction[] = [];
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
      decodedInstructions.push({
        program,
        accounts: accountKeys.map((account) => account.key),
        data: Buffer.from(instruction.data),
      });
      computeBudget.push({ program, data: Buffer.from(instruction.data) });
    }
    this.validateNativeDepositBinding(decodedInstructions, nativeDeposit);
    this.validateNativeWithdrawalBinding(decodedInstructions, nativeWithdrawal);
    this.validatePriorityFee(computeBudget);
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
    for (const account of accounts) {
      if (account.isSigner && account.key.toBase58() !== this.wallet) {
        reject('only_wallet_signer', 'a non-wallet account was marked signer');
      }
      if (account.isWritable && !allowedWritable.has(account.key.toBase58())) {
        reject('writable_account_allowlist', `unknown writable account ${account.key.toBase58()}`);
      }
    }
  }

  private validateNativeDepositBinding(
    instructions: DecodedInstruction[],
    expected: PolicyInput['nativeDeposit'],
  ): void {
    const meteoraProgram = LBCLMM_PROGRAM_IDS['mainnet-beta'];
    const deposits = instructions.filter((instruction) =>
      instruction.program.toBase58() === meteoraProgram &&
      instruction.data.subarray(0, 8).equals(ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR));
    if (!expected) {
      if (deposits.length > 0) {
        reject('native_deposit_binding', 'native deposit lacks policy binding');
      }
      return;
    }
    for (const candidate of instructions) {
      if (candidate.program.equals(ComputeBudgetProgram.programId)) continue;
      if (candidate.program.toBase58() === meteoraProgram) {
        const tag = candidate.data.subarray(0, 8);
        if (!tag.equals(ADD_LIQUIDITY_ONE_SIDE_DISCRIMINATOR) &&
            !tag.equals(INITIALIZE_POSITION_PDA_DISCRIMINATOR) &&
            !tag.equals(INITIALIZE_BIN_ARRAY_DISCRIMINATOR) &&
            !tag.equals(INITIALIZE_BITMAP_EXTENSION_DISCRIMINATOR)) {
          reject('native_deposit_binding', 'unexpected Meteora instruction in deposit transaction');
        }
        continue;
      }
      if (candidate.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
      reject('native_deposit_binding', 'unexpected program in deposit transaction');
    }
    if (deposits.length !== 1) {
      reject('native_deposit_binding', 'expected exactly one native one-sided deposit');
    }
    const instruction = deposits[0]!;
    if (instruction.accounts.length !== 12) {
      reject('native_deposit_binding', 'native deposit account count is invalid');
    }
    const asKey = (value: string | PublicKey): string =>
      typeof value === 'string' ? value : value.toBase58();
    const firstBin = expected.weights[0]?.binId;
    const lastBin = expected.weights.at(-1)?.binId;
    if (firstBin === undefined || lastBin === undefined ||
        expected.weights.some((bin, index) => index > 0 &&
          bin.binId !== expected.weights[index - 1]!.binId + 1)) {
      reject('native_deposit_binding', 'native deposit bins are not contiguous');
    }
    const derivedWidth = lastBin - firstBin + 1;
    const pool = new PublicKey(asKey(expected.pool));
    const wallet = new PublicKey(this.wallet);
    const program = instruction.program;
    const lowerIndex = binIdToBinArrayIndex(new BN(firstBin));
    const upperIndex = BN.max(
      lowerIndex.add(new BN(1)),
      binIdToBinArrayIndex(new BN(lastBin)),
    );
    const [position] = derivePosition(pool, wallet, new BN(firstBin), new BN(derivedWidth), program);
    const [lowerArray] = deriveBinArray(pool, lowerIndex, program);
    const [upperArray] = deriveBinArray(pool, upperIndex, program);
    const overflow = isOverflowDefaultBinArrayBitmap(lowerIndex) ||
      isOverflowDefaultBinArrayBitmap(upperIndex);
    const bitmap = overflow ? deriveBinArrayBitmapExtension(pool, program)[0] : null;
    if (expected.positionLowerBinId !== firstBin || expected.positionWidth !== derivedWidth ||
        expected.lowerBinArrayIndex !== BigInt(lowerIndex.toString()) ||
        expected.upperBinArrayIndex !== BigInt(upperIndex.toString()) ||
        asKey(expected.position) !== position.toBase58() ||
        asKey(expected.binArrayLower) !== lowerArray.toBase58() ||
        asKey(expected.binArrayUpper) !== upperArray.toBase58() ||
        (expected.bitmapExtension ? asKey(expected.bitmapExtension) : null) !==
          (bitmap ? bitmap.toBase58() : null)) {
      reject('native_deposit_binding', 'native deposit PDAs do not match pool, wallet, and bins');
    }
    const expectedAccounts = [
      asKey(expected.position),
      asKey(expected.pool),
      expected.bitmapExtension ? asKey(expected.bitmapExtension) : instruction.program.toBase58(),
      asKey(expected.userToken),
      asKey(expected.reserve),
      asKey(expected.tokenMint),
      asKey(expected.binArrayLower),
      asKey(expected.binArrayUpper),
      this.wallet,
    ];
    if (expectedAccounts.some((key, index) => instruction.accounts[index]?.toBase58() !== key)) {
      reject('native_deposit_binding', 'native deposit accounts do not match the validated request');
    }
    let payload;
    try {
      payload = decodeAddLiquidityOneSidePayload(instruction.data);
    } catch {
      reject('native_deposit_binding', 'native deposit payload is malformed');
    }
    if (payload.amount !== expected.amountRaw ||
        payload.activeId !== expected.activeId ||
        payload.maxActiveBinSlippage !== expected.maxActiveBinSlippage ||
        payload.binLiquidityDist.length !== expected.weights.length ||
        payload.binLiquidityDist.some((bin, index) =>
          bin.binId !== expected.weights[index]?.binId || bin.weight !== expected.weights[index]?.weight)) {
      reject('native_deposit_binding', 'native deposit payload does not match the validated request');
    }
    if (payload.maxActiveBinSlippage < 0 ||
        payload.maxActiveBinSlippage > this.config.maxActiveBinSlippageBins) {
      reject('active_bin_slippage_cap', 'decoded active-bin slippage exceeds cap');
    }
    const [eventAuthority] = deriveEventAuthority(instruction.program);
    const tokenProgram = instruction.accounts[9]!;
    const expectedAta = getAssociatedTokenAddressSync(
      new PublicKey(asKey(expected.tokenMint)),
      new PublicKey(this.wallet),
      false,
      new PublicKey(asKey(expected.tokenProgram)),
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    if (tokenProgram.toBase58() !== asKey(expected.tokenProgram) ||
        (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) ||
        asKey(expected.userToken) !== expectedAta.toBase58() ||
        !instruction.accounts[10]!.equals(eventAuthority) ||
        !instruction.accounts[11]!.equals(instruction.program)) {
      reject('native_deposit_binding', 'native deposit fixed program accounts are invalid');
    }

    const positionInitializers = instructions.filter((candidate) =>
      candidate.program.toBase58() === meteoraProgram &&
      candidate.data.subarray(0, 8).equals(INITIALIZE_POSITION_PDA_DISCRIMINATOR));
    if (positionInitializers.length > 1) {
      reject('native_deposit_binding', 'duplicate position initializer');
    }
    if (positionInitializers[0]) {
      const init = positionInitializers[0];
      const expectedInitAccounts = [
        this.wallet, this.wallet, asKey(expected.position), asKey(expected.pool), this.wallet,
        SystemProgram.programId.toBase58(), 'SysvarRent111111111111111111111111111111111',
        eventAuthority.toBase58(), meteoraProgram,
      ];
      if (init.data.length !== 16 ||
          init.data.readInt32LE(8) !== expected.positionLowerBinId ||
          init.data.readInt32LE(12) !== expected.positionWidth ||
          init.accounts.length !== expectedInitAccounts.length ||
          expectedInitAccounts.some((key, index) => init.accounts[index]?.toBase58() !== key)) {
        reject('native_deposit_binding', 'position initializer does not match the deposit');
      }
    }

    const binInitializers = instructions.filter((candidate) =>
      candidate.program.toBase58() === meteoraProgram &&
      candidate.data.subarray(0, 8).equals(INITIALIZE_BIN_ARRAY_DISCRIMINATOR));
    if (binInitializers.length > 2) reject('native_deposit_binding', 'too many bin-array initializers');
    const expectedBins = new Map([
      [expected.lowerBinArrayIndex.toString(), asKey(expected.binArrayLower)],
      [expected.upperBinArrayIndex.toString(), asKey(expected.binArrayUpper)],
    ]);
    const initializedIndexes = new Set<string>();
    for (const init of binInitializers) {
      if (init.data.length !== 16 || init.accounts.length !== 4) {
        reject('native_deposit_binding', 'bin-array initializer is malformed');
      }
      const index = init.data.readBigInt64LE(8).toString();
      const binArray = expectedBins.get(index);
      if (!binArray || initializedIndexes.has(index) ||
          init.accounts[0]?.toBase58() !== asKey(expected.pool) ||
          init.accounts[1]?.toBase58() !== binArray ||
          init.accounts[2]?.toBase58() !== this.wallet ||
          !init.accounts[3]?.equals(SystemProgram.programId)) {
        reject('native_deposit_binding', 'bin-array initializer does not match the deposit');
      }
      initializedIndexes.add(index);
    }

    const bitmapInitializers = instructions.filter((candidate) =>
      candidate.program.toBase58() === meteoraProgram &&
      candidate.data.subarray(0, 8).equals(INITIALIZE_BITMAP_EXTENSION_DISCRIMINATOR));
    if (bitmapInitializers.length > 1 || (bitmapInitializers.length === 1 && !expected.bitmapExtension)) {
      reject('native_deposit_binding', 'unexpected bitmap-extension initializer');
    }
    if (bitmapInitializers[0]) {
      const bitmap = bitmapInitializers[0];
      if (bitmap.data.length !== 8 || bitmap.accounts.length !== 5 ||
          bitmap.accounts[0]?.toBase58() !== asKey(expected.pool) ||
          bitmap.accounts[1]?.toBase58() !== asKey(expected.bitmapExtension!) ||
          bitmap.accounts[2]?.toBase58() !== this.wallet ||
          !bitmap.accounts[3]?.equals(SystemProgram.programId) ||
          bitmap.accounts[4]?.toBase58() !== 'SysvarRent111111111111111111111111111111111') {
        reject('native_deposit_binding', 'bitmap initializer does not match the deposit');
      }
    }

    const ataInstructions = instructions.filter((candidate) =>
      candidate.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    if (ataInstructions.length !== 1) {
      reject('native_deposit_binding', 'expected one idempotent ATA instruction');
    }
    const ata = ataInstructions[0]!;
    const expectedAtaAccounts = [
      this.wallet,
      asKey(expected.userToken),
      this.wallet,
      asKey(expected.tokenMint),
      SystemProgram.programId.toBase58(),
      asKey(expected.tokenProgram),
    ];
    if (ata.data.length !== 1 || ata.data[0] !== 1 ||
        ata.accounts.length !== expectedAtaAccounts.length ||
        expectedAtaAccounts.some((key, index) => ata.accounts[index]?.toBase58() !== key)) {
      reject('native_deposit_binding', 'ATA instruction does not match the deposit');
    }
  }

  private validateNativeWithdrawalBinding(
    instructions: DecodedInstruction[],
    expected: PolicyInput['nativeWithdrawal'],
  ): void {
    const meteoraProgram = LBCLMM_PROGRAM_IDS['mainnet-beta'];
    const rejectWithdrawal = (detail: string): never =>
      reject('native_withdrawal_binding', detail);
    const isMeteoraTag = (instruction: DecodedInstruction, tag: Buffer): boolean =>
      instruction.program.toBase58() === meteoraProgram &&
      instruction.data.subarray(0, 8).equals(tag);
    const removes = instructions.filter((ix) =>
      isMeteoraTag(ix, REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR));
    const claims = instructions.filter((ix) => isMeteoraTag(ix, CLAIM_FEE_2_DISCRIMINATOR));
    const closes = instructions.filter((ix) =>
      isMeteoraTag(ix, CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR));
    if (!expected) {
      if (removes.length > 0 || claims.length > 0 || closes.length > 0) {
        rejectWithdrawal('native withdrawal lacks policy binding');
      }
      return;
    }
    const asKey = (value: string | PublicKey): string =>
      typeof value === 'string' ? value : value.toBase58();
    if (asKey(expected.wallet) !== this.wallet) {
      rejectWithdrawal('withdrawal wallet does not match policy wallet');
    }
    for (const candidate of instructions) {
      if (candidate.program.equals(ComputeBudgetProgram.programId) ||
          candidate.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
      if (candidate.program.toBase58() !== meteoraProgram ||
          (!candidate.data.subarray(0, 8).equals(REMOVE_LIQUIDITY_BY_RANGE_2_DISCRIMINATOR) &&
           !candidate.data.subarray(0, 8).equals(CLAIM_FEE_2_DISCRIMINATOR) &&
           !candidate.data.subarray(0, 8).equals(CLOSE_POSITION_IF_EMPTY_DISCRIMINATOR))) {
        rejectWithdrawal('unexpected instruction in withdrawal transaction');
      }
    }
    if (removes.length !== 1 || claims.length !== 1 ||
        closes.length !== (expected.claimAndClose ? 1 : 0)) {
      rejectWithdrawal('withdrawal instruction sequence is incomplete');
    }
    const program = removes[0]!.program;
    const pool = new PublicKey(asKey(expected.pool));
    const [eventAuthority] = deriveEventAuthority(program);
    const requiredBins = getBinArraysRequiredByPositionRange(
      pool,
      new BN(expected.fromBinId),
      new BN(expected.toBinId),
      program,
    );
    if (requiredBins.length === 0 || requiredBins.length > 2 ||
        requiredBins.length !== expected.binArrays.length ||
        requiredBins.some(({ key }, index) => key.toBase58() !== asKey(expected.binArrays[index]!))) {
      rejectWithdrawal('withdrawal bin arrays do not match its range');
    }
    const overflow = requiredBins.some(({ index }) => isOverflowDefaultBinArrayBitmap(index));
    const derivedBitmap = overflow ? deriveBinArrayBitmapExtension(pool, program)[0] : null;
    if ((expected.bitmapExtension ? asKey(expected.bitmapExtension) : null) !==
        (derivedBitmap ? derivedBitmap.toBase58() : null)) {
      rejectWithdrawal('withdrawal bitmap extension is invalid');
    }
    const expectedTokenPrograms = [expected.tokenXProgram, expected.tokenYProgram]
      .map((key) => new PublicKey(asKey(key)));
    if (expectedTokenPrograms.some((tokenProgram) =>
      !tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID))) {
      rejectWithdrawal('withdrawal token program is invalid');
    }
    const expectedX = getAssociatedTokenAddressSync(
      new PublicKey(asKey(expected.tokenXMint)),
      new PublicKey(this.wallet),
      false,
      expectedTokenPrograms[0]!,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const expectedY = getAssociatedTokenAddressSync(
      new PublicKey(asKey(expected.tokenYMint)),
      new PublicKey(this.wallet),
      false,
      expectedTokenPrograms[1]!,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    if (asKey(expected.userTokenX) !== expectedX.toBase58() ||
        asKey(expected.userTokenY) !== expectedY.toBase58()) {
      rejectWithdrawal('withdrawal token accounts are not wallet ATAs');
    }
    const remove = removes[0]!;
    let payload: ReturnType<typeof decodeRemoveLiquidityByRangePayload>;
    try {
      payload = decodeRemoveLiquidityByRangePayload(remove.data);
    } catch {
      reject('native_withdrawal_binding', 'withdrawal payload is malformed');
    }
    if (payload.fromBinId !== expected.fromBinId || payload.toBinId !== expected.toBinId ||
        payload.bpsToRemove !== expected.bpsToRemove) {
      rejectWithdrawal('withdrawal payload does not match the request');
    }
    const bitmapKey = derivedBitmap?.toBase58() ?? meteoraProgram;
    const removeAccounts = [
      expected.position, expected.pool, bitmapKey, expected.userTokenX, expected.userTokenY,
      expected.reserveX, expected.reserveY, expected.tokenXMint, expected.tokenYMint,
      this.wallet, expected.tokenXProgram, expected.tokenYProgram, MEMO_PROGRAM_ID,
      eventAuthority, program, ...expected.binArrays,
    ].map((key) => typeof key === 'string' ? key : key.toBase58());
    if (remove.accounts.length !== removeAccounts.length ||
        removeAccounts.some((key, index) => remove.accounts[index]?.toBase58() !== key)) {
      rejectWithdrawal('withdrawal accounts do not match the request');
    }
    const claim = claims[0]!;
    const claimAccounts = [
      expected.pool, expected.position, this.wallet, expected.reserveX, expected.reserveY,
      expected.userTokenX, expected.userTokenY, expected.tokenXMint, expected.tokenYMint,
      expected.tokenXProgram, expected.tokenYProgram, MEMO_PROGRAM_ID,
      eventAuthority, program, ...expected.binArrays,
    ].map((key) => typeof key === 'string' ? key : key.toBase58());
    if (claim.data.length !== 20 || claim.data.readInt32LE(8) !== expected.fromBinId ||
        claim.data.readInt32LE(12) !== expected.toBinId || claim.data.readUInt32LE(16) !== 0 ||
        claim.accounts.length !== claimAccounts.length ||
        claimAccounts.some((key, index) => claim.accounts[index]?.toBase58() !== key)) {
      rejectWithdrawal('fee-claim instruction does not match the withdrawal');
    }
    if (closes[0]) {
      const close = closes[0];
      const closeAccounts = [
        asKey(expected.position), this.wallet, this.wallet,
        eventAuthority.toBase58(), meteoraProgram,
      ];
      if (close.data.length !== 8 || close.accounts.length !== closeAccounts.length ||
          closeAccounts.some((key, index) => close.accounts[index]?.toBase58() !== key)) {
        rejectWithdrawal('close instruction does not match the withdrawal');
      }
    }
    const atas = instructions.filter((ix) => ix.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    if (atas.length !== 2) rejectWithdrawal('withdrawal requires two ATA checks');
    const expectedAtaKeys = new Set([expectedX.toBase58(), expectedY.toBase58()]);
    for (const ata of atas) {
      if (ata.data.length !== 1 || ata.data[0] !== 1 || ata.accounts.length !== 6 ||
          ata.accounts[0]?.toBase58() !== this.wallet ||
          ata.accounts[2]?.toBase58() !== this.wallet ||
          !expectedAtaKeys.delete(ata.accounts[1]!.toBase58()) ||
          !ata.accounts[4]?.equals(SystemProgram.programId)) {
        rejectWithdrawal('withdrawal ATA instruction is invalid');
      }
    }
  }

  /**
   * Solana charges ceil(CU_price_micro_lamports × CU_limit / 1,000,000),
   * not the price alone. Require a single explicit limit whenever a price is
   * requested: without it an SDK/default-limit change could silently expand
   * the fee. See Solana core fee structure documentation.
   */
  private validatePriorityFee(instructions: ComputeBudgetInstructionData[]): void {
    let unitLimit: bigint | undefined;
    let unitPrice: bigint | undefined;
    for (const instruction of instructions) {
      if (!instruction.program.equals(ComputeBudgetProgram.programId)) continue;
      const { data } = instruction;
      if (data.length === 5 && data[0] === 2) {
        if (unitLimit !== undefined) reject('priority_fee_cap', 'duplicate compute unit limit');
        unitLimit = BigInt(data.readUInt32LE(1));
      } else if (data.length === 9 && data[0] === 3) {
        if (unitPrice !== undefined) reject('priority_fee_cap', 'duplicate compute unit price');
        unitPrice = data.readBigUInt64LE(1);
      } else {
        reject('priority_fee_cap', 'unsupported compute budget instruction');
      }
    }
    if (unitPrice === undefined || unitPrice === 0n) return;
    if (unitLimit === undefined || unitLimit === 0n) {
      reject('priority_fee_cap', 'nonzero CU price requires an explicit nonzero CU limit');
    }
    const feeLamports = (unitPrice * unitLimit + 999_999n) / 1_000_000n;
    if (feeLamports > BigInt(this.config.maxPriorityFeeLamports)) {
      reject('priority_fee_cap', 'priority fee exceeds MAX_PRIORITY_FEE_LAMPORTS');
    }
  }
}
