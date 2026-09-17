/**
 * Direct Meteora DLMM swap (plan T5.1, `pool` set path).
 *
 * The quote is taken from the pool's own bin arrays with the caller's
 * slippage cap; the SDK-built `swap2` transaction carries the resulting
 * minimum output inside the mutation instruction, so the bound travels with
 * the transaction even if a bundle is unbundled. Everything the policy must
 * re-verify is handed to it as an explicit `meteoraSwap` binding.
 */

import BN from 'bn.js';
import { createHash } from 'node:crypto';
import { LBCLMM_PROGRAM_IDS } from '@meteora-ag/dlmm';
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { PolicyInput } from './policy.js';
import type { SwapRequest } from './protocol.js';
import type { SwapPoolReader } from './meteora.js';
import type { WritablePoolMetadata } from './depositTransaction.js';
import { WSOL_MINT, SwapValidationError, assertQuotedSlippage, swapAmountToRaw } from './swap.js';

export const SWAP2_DISCRIMINATOR = createHash('sha256')
  .update('global:swap2')
  .digest()
  .subarray(0, 8);

const DEFAULT_SIGNATURE_FEE_LAMPORTS = 5_000;
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_100_000;
const SWAP_BIN_ARRAY_COUNT = 4;

export class DlmmSwapInstructionError extends Error {}
export class DlmmSwapBuildError extends Error {}

export interface Swap2Payload {
  amountIn: bigint;
  minAmountOut: bigint;
  slices: { type: number; length: number }[];
}

/** Borsh layout: disc, u64 amount_in, u64 min_amount_out, RemainingAccountsInfo
 * (u32 slice count, then per slice: u8 accounts_type + u8 length per the IDL). */
export function decodeSwap2Payload(data: Buffer): Swap2Payload {  if (data.length < 28 || !data.subarray(0, 8).equals(SWAP2_DISCRIMINATOR)) {
    throw new DlmmSwapInstructionError('invalid swap2 payload');
  }
  const amountIn = data.readBigUInt64LE(8);
  const minAmountOut = data.readBigUInt64LE(16);
  const sliceCount = data.readUInt32LE(24);
  let offset = 28;
  const slices: { type: number; length: number }[] = [];
  for (let index = 0; index < sliceCount; index += 1) {
    if (data.length < offset + 2) throw new DlmmSwapInstructionError('truncated swap2 slices');
    slices.push({ type: data[offset]!, length: data[offset + 1]! });
    offset += 2;
  }
  if (offset !== data.length) throw new DlmmSwapInstructionError('swap2 payload trailing bytes');
  return { amountIn, minAmountOut, slices };
}

/** Encode the no-hook `swap2` payload: two empty transfer-hook slices. */
export function encodeSwap2Payload(
  amountIn: bigint,
  minAmountOut: bigint,
  slices: { type: number; length: number }[] = [{ type: 0, length: 0 }, { type: 1, length: 0 }],
): Buffer {
  const data = Buffer.alloc(28 + slices.length * 2);
  SWAP2_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(minAmountOut, 16);
  data.writeUInt32LE(slices.length, 24);
  slices.forEach((slice, index) => {
    data.writeUInt8(slice.type, 28 + index * 2);
    data.writeUInt8(slice.length, 29 + index * 2);
  });
  return data;
}

export interface DlmmSwapPlan {
  transaction: Transaction;
  policyInput: PolicyInput;
  amountInRaw: bigint;
  minOutRaw: bigint;
  quoteOutRaw: bigint;
}

/**
 * Exact-in quote against one pool's live bin arrays. No wallet and no
 * transaction: shared by the swap builder and the read-only `quote_swap` verb.
 */
export async function quoteDlmmSwap(args: {
  reader: SwapPoolReader;
  swapForY: boolean;
  amountInRaw: bigint;
  maxSlippageBps: number;
}): Promise<{ outAmountRaw: bigint; minOutRaw: bigint; binArraysPubkey: PublicKey[] }> {
  const binArrays = await args.reader.getBinArrayForSwap(args.swapForY, SWAP_BIN_ARRAY_COUNT);
  let quote;
  try {
    quote = args.reader.swapQuote(
      new BN(args.amountInRaw.toString()), args.swapForY,
      new BN(args.maxSlippageBps), binArrays,
    );
  } catch (error) {
    if (error instanceof SwapValidationError) throw error;
    throw new SwapValidationError(
      'slippage_exceeded', 'pool cannot fill the exact-in swap within bounds',
    );
  }
  if (BigInt(quote.consumedInAmount.toString()) !== args.amountInRaw) {
    throw new SwapValidationError('slippage_exceeded', 'pool quote only partially fills the swap');
  }
  const outAmountRaw = BigInt(quote.outAmount.toString());
  const minOutRaw = BigInt(quote.minOutAmount.toString());
  assertQuotedSlippage(outAmountRaw, minOutRaw, args.maxSlippageBps);
  return { outAmountRaw, minOutRaw, binArraysPubkey: quote.binArraysPubkey };
}

/**
 * Quote and build one pool-scoped swap. `inMint`/`outMint` carry fresh on-chain
 * decimals, token programs, and the wallet balance used for the preflight.
 */
export async function buildDlmmSwapTransaction(args: {
  reader: SwapPoolReader;
  wallet: PublicKey;
  request: SwapRequest;
  pool: WritablePoolMetadata;
  inMint: { decimals: number; tokenProgram: string };
  outMint: { decimals: number; tokenProgram: string };
  walletInBalanceRaw: string;
}): Promise<DlmmSwapPlan> {
  const { reader, wallet, request, pool } = args;
  if (request.pool === null || !pool.pool.equals(new PublicKey(request.pool))) {
    throw new DlmmSwapBuildError('request pool does not match loaded pool metadata');
  }
  if ((pool.activeRewardCount ?? 0) !== 0) {
    throw new DlmmSwapBuildError('swaps on reward-enabled pools are unsupported');
  }
  if ((pool.tokenX.transferHookAccountCount ?? 0) !== 0 ||
      (pool.tokenY.transferHookAccountCount ?? 0) !== 0) {
    throw new DlmmSwapBuildError('swaps with Token-2022 transfer hooks are unsupported');
  }
  if (!pool.oracle) {
    throw new DlmmSwapBuildError('pool price oracle is unavailable for the swap instruction');
  }
  const swapForY = request.in_mint === pool.tokenX.mint.toBase58();
  const expectedIn = swapForY ? pool.tokenX.mint : pool.tokenY.mint;
  const expectedOut = swapForY ? pool.tokenY.mint : pool.tokenX.mint;
  if (request.out_mint !== expectedOut.toBase58() ||
      !new PublicKey(request.in_mint).equals(expectedIn)) {
    throw new SwapValidationError('bad_request', 'swap mints do not belong to the requested pool');
  }
  const amountInRaw = swapAmountToRaw(request.amount, args.inMint.decimals);
  if (request.in_mint !== WSOL_MINT && BigInt(args.walletInBalanceRaw) < amountInRaw) {
    throw new SwapValidationError('insufficient_balance', 'insufficient swap input balance');
  }
  const inTokenProgram = new PublicKey(args.inMint.tokenProgram);
  const outTokenProgram = new PublicKey(args.outMint.tokenProgram);
  if (!inTokenProgram.equals(pool.tokenX.tokenProgram) &&
      !inTokenProgram.equals(pool.tokenY.tokenProgram)) {
    throw new SwapValidationError('bad_request', 'input token program does not match the pool');
  }
  if (!outTokenProgram.equals(pool.tokenX.tokenProgram) &&
      !outTokenProgram.equals(pool.tokenY.tokenProgram)) {
    throw new SwapValidationError('bad_request', 'output token program does not match the pool');
  }
  const userTokenIn = getAssociatedTokenAddressSync(
    new PublicKey(request.in_mint), wallet, false, inTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userTokenOut = getAssociatedTokenAddressSync(
    new PublicKey(request.out_mint), wallet, false, outTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const { outAmountRaw, minOutRaw, binArraysPubkey } = await quoteDlmmSwap({
    reader, swapForY, amountInRaw, maxSlippageBps: request.max_slippage_bps,
  });

  const transaction = await reader.swap({
    inToken: new PublicKey(request.in_mint),
    outToken: new PublicKey(request.out_mint),
    inAmount: new BN(amountInRaw.toString()),
    minOutAmount: new BN(minOutRaw.toString()),
    lbPair: pool.pool,
    user: wallet,
    binArraysPubkey,
  });

  const bitmapExtension = reader.binArrayBitmapExtension?.publicKey ?? null;
  // The pinned SDK's IDL declares swap2's binArrayBitmapExtension as
  // non-mutable, but the on-chain program enforces mut when the account is
  // present (ConstraintMut / error 2000). Correct the meta to the program's
  // actual account model; the policy binding below already allows it writable.
  if (bitmapExtension) {
    const programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);
    for (const instruction of transaction.instructions) {
      if (instruction.programId.equals(programId) &&
          instruction.data.subarray(0, 8).equals(SWAP2_DISCRIMINATOR) &&
          instruction.keys[1]?.pubkey.equals(bitmapExtension)) {
        instruction.keys[1]!.isWritable = true;
      }
    }
  }
  let solSpendLamports = DEFAULT_SIGNATURE_FEE_LAMPORTS + 2 * TOKEN_ACCOUNT_RENT_LAMPORTS;
  if (request.in_mint === WSOL_MINT) solSpendLamports += Number(amountInRaw);
  const policyInput: PolicyInput = {
    writableAccounts: [
      userTokenIn, userTokenOut,
      pool.tokenX.reserve, pool.tokenY.reserve, pool.oracle,
      ...binArraysPubkey,
      ...(bitmapExtension ? [bitmapExtension] : []),
    ],
    pools: [pool.pool],
    mints: [request.in_mint, request.out_mint],
    amounts: {
      maxSlippageBps: request.max_slippage_bps,
      solSpendLamports,
    },
    meteoraSwap: {
      pool: pool.pool,
      userTokenIn,
      userTokenOut,
      reserveX: pool.tokenX.reserve,
      reserveY: pool.tokenY.reserve,
      tokenXMint: pool.tokenX.mint,
      tokenYMint: pool.tokenY.mint,
      tokenXProgram: pool.tokenX.tokenProgram,
      tokenYProgram: pool.tokenY.tokenProgram,
      oracle: pool.oracle,
      bitmapExtension,
      binArrays: binArraysPubkey,
      amountInRaw,
      minOutRaw,
    },
  };
  return { transaction, policyInput, amountInRaw, minOutRaw, quoteOutRaw: outAmountRaw };
}
