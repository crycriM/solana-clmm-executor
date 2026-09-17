/**
 * Jupiter swap transaction assembly (plan T5.1).
 *
 * The API's raw instructions are re-validated against the request before a
 * single byte is signed: mint identity, exact-in amount, the wallet's own
 * source/destination accounts, and a closed program set for pre/post steps.
 * Anything unexpected fails the verb before simulation.
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { JupiterQuote, JupiterInstruction, JupiterSwapInstructions } from './jupiter.js';
import type { MintState } from './meteora.js';
import type { PolicyInput } from './policy.js';
import type { SwapRequest } from './protocol.js';
import {
  SwapValidationError,
  WSOL_MINT,
  assertQuotedSlippage,
  swapAmountToRaw,
} from './swap.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const STANDARD_SWAP_PROGRAMS = new Set([
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
]);
const DEFAULT_SIGNATURE_FEE_LAMPORTS = 5_000;
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_100_000;
/** Replaced with a fresh blockhash by the executor before policy sees it. */
const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

export interface LookupTableConnection {
  getAddressLookupTable(
    address: PublicKey,
  ): Promise<{ value: AddressLookupTableAccount | null }>;
}

export interface JupiterSwapPlan {
  transaction: VersionedTransaction;
  addressLookupTableAccounts: AddressLookupTableAccount[];
  policyInput: PolicyInput;
  amountInRaw: bigint;
  minOutRaw: bigint;
  quoteOutRaw: bigint;
}

function toInstruction(instruction: JupiterInstruction): TransactionInstruction {
  let data: Buffer;
  try {
    data = Buffer.from(instruction.data, 'base64');
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data,
    });
  } catch {
    throw new SwapValidationError('bad_request', 'Jupiter returned a malformed instruction');
  }
}

function programIdOf(account: PublicKey): string {
  return account.toBase58();
}

/**
 * Build the final v0 transaction and its policy binding from a validated
 * quote + swap-instructions pair. The caller supplies fresh mint state so the
 * balance preflight and decimal conversion use one consistent snapshot.
 */
export async function buildJupiterSwapTransaction(args: {
  connection: LookupTableConnection;
  wallet: PublicKey;
  request: SwapRequest;
  inMint: MintState;
  outMint: MintState;
  quote: JupiterQuote;
  instructions: JupiterSwapInstructions;
  jupiterProgramIds: readonly string[];
}): Promise<JupiterSwapPlan> {
  const { connection, wallet, request, inMint, outMint, quote, instructions } = args;
  const amountInRaw = swapAmountToRaw(request.amount, inMint.decimals);
  if (quote.inputMint !== request.in_mint || quote.outputMint !== request.out_mint ||
      quote.inAmount !== amountInRaw.toString()) {
    throw new SwapValidationError('bad_request', 'Jupiter quote does not match the requested swap');
  }
  const isWrap = (mint: string): boolean => mint === WSOL_MINT;
  if (!isWrap(request.in_mint) && BigInt(inMint.walletBalanceRaw) < amountInRaw) {
    throw new SwapValidationError('insufficient_balance', `insufficient ${request.in_mint} balance`);
  }
  const outAmountRaw = BigInt(quote.outAmount);
  const minOutRaw = BigInt(quote.otherAmountThreshold);
  assertQuotedSlippage(outAmountRaw, minOutRaw, request.max_slippage_bps);

  const route = instructions.swapInstruction;
  if (!args.jupiterProgramIds.includes(route.programId)) {
    throw new SwapValidationError('bad_request', 'Jupiter route program is not allow-listed');
  }
  const router = toInstruction(route);
  for (const instruction of [...instructions.preInstructions, ...instructions.postInstructions]) {
    if (args.jupiterProgramIds.includes(instruction.programId)) {
      throw new SwapValidationError('bad_request', 'Jupiter route program repeated in setup steps');
    }
    if (!STANDARD_SWAP_PROGRAMS.has(instruction.programId)) {
      throw new SwapValidationError('bad_request', 'Jupiter setup step uses an unknown program');
    }
  }
  if (router.keys.length < 4) {
    throw new SwapValidationError('bad_request', 'Jupiter route instruction accounts are truncated');
  }
  const tokenProgram = programIdOf(router.keys[0]!.pubkey);
  if (tokenProgram !== TOKEN_PROGRAM_ID.toBase58() &&
      tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()) {
    throw new SwapValidationError('bad_request', 'Jupiter route token program is invalid');
  }
  if (programIdOf(router.keys[1]!.pubkey) !== wallet.toBase58()) {
    throw new SwapValidationError('bad_request', 'Jupiter route transfer authority is not the wallet');
  }
  const walletAta = (mint: string, state: MintState): PublicKey | null =>
    isWrap(mint)
      ? null
      : getAssociatedTokenAddressSync(
          new PublicKey(mint), wallet, false, new PublicKey(state.tokenProgram),
        );
  const source = walletAta(request.in_mint, inMint);
  const destination = walletAta(request.out_mint, outMint);
  if (source && programIdOf(router.keys[2]!.pubkey) !== source.toBase58()) {
    throw new SwapValidationError('bad_request', 'Jupiter route source account is not the wallet ATA');
  }
  if (destination && programIdOf(router.keys[3]!.pubkey) !== destination.toBase58()) {
    throw new SwapValidationError('bad_request', 'Jupiter route destination account is not the wallet ATA');
  }

  const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  for (const address of [...new Set(instructions.addressLookupTableAddresses ?? [])]) {
    let table: AddressLookupTableAccount | null;
    try {
      table = (await connection.getAddressLookupTable(new PublicKey(address))).value;
    } catch {
      throw new SwapValidationError('rpc_timeout', 'Jupiter lookup table could not be resolved');
    }
    if (!table) {
      throw new SwapValidationError('rpc_timeout', 'Jupiter lookup table could not be resolved');
    }
    addressLookupTableAccounts.push(table);
  }

  const compiled = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    instructions: [
      ...instructions.preInstructions.map(toInstruction),
      router,
      ...instructions.postInstructions.map(toInstruction),
    ],
  }).compileToV0Message(addressLookupTableAccounts);
  const transaction = new VersionedTransaction(compiled);

  let solSpendLamports = DEFAULT_SIGNATURE_FEE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS;
  if (isWrap(request.in_mint)) {
    solSpendLamports += Number(amountInRaw);
  }
  const policyInput: PolicyInput = {
    writableAccounts: [source, destination].filter((key): key is PublicKey => key !== null),
    mints: [request.in_mint, request.out_mint],
    amounts: {
      maxSlippageBps: request.max_slippage_bps,
      solSpendLamports,
    },
    jupiterSwap: {
      routerProgram: route.programId,
      sourceTokenAccount: source,
      destinationTokenAccount: destination,
      tokenProgram,
      amountInRaw,
      minOutRaw,
    },
    addressLookupTableAccounts,
  };
  return { transaction, addressLookupTableAccounts, policyInput, amountInRaw, minOutRaw, quoteOutRaw: outAmountRaw };
}
