import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import type { JupiterQuote, JupiterSwapInstructions } from './jupiter.js';
import type { MintState } from './meteora.js';
import type { SwapRequest } from './protocol.js';
import { SwapValidationError } from './swap.js';
import { WSOL_MINT } from './swap.js';
import { buildJupiterSwapTransaction, type LookupTableConnection } from './swapTransaction.js';
import { baseEnv, TEST_QUOTE_MINT } from './testing.js';

const ROUTER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const IN_MINT = TEST_QUOTE_MINT;
const OUT_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const wallet = Keypair.generate().publicKey;
const poolTokenAccount = Keypair.generate().publicKey;

function mintState(decimals: number, balanceRaw: string): MintState {
  return { decimals, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), walletBalanceRaw: balanceRaw };
}

function request(): SwapRequest {
  return {
    method: 'swap', in_mint: IN_MINT, out_mint: OUT_MINT,
    amount: 1.5, max_slippage_bps: 50, pool: null,
  };
}

function quote(overrides: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: IN_MINT, outputMint: OUT_MINT,
    inAmount: '1500000', outAmount: '1000000000', otherAmountThreshold: '995000000',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.1', routePlan: [{}],
    ...overrides,
  };
}

function routeData(amountIn: bigint, minOut: bigint): string {
  const data = Buffer.alloc(17);
  data[0] = 2;
  data.writeBigUInt64LE(amountIn, 1);
  data.writeBigUInt64LE(minOut, 9);
  return data.toString('base64');
}

function instructions(overrides: Partial<JupiterSwapInstructions> = {}): JupiterSwapInstructions {
  const source = getAssociatedTokenAddressSync(new PublicKey(IN_MINT), wallet);
  const destination = getAssociatedTokenAddressSync(new PublicKey(OUT_MINT), wallet);
  return {
    swapInstruction: {
      programId: ROUTER,
      accounts: [
        { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
        { pubkey: wallet.toBase58(), isSigner: true, isWritable: true },
        { pubkey: source.toBase58(), isSigner: false, isWritable: true },
        { pubkey: destination.toBase58(), isSigner: false, isWritable: true },
        { pubkey: poolTokenAccount.toBase58(), isSigner: false, isWritable: true },
      ],
      data: routeData(1_500_000n, 995_000_000n),
    },
    preInstructions: [],
    postInstructions: [],
    addressLookupTableAddresses: [],
    ...overrides,
  };
}

const connection: LookupTableConnection = {
  async getAddressLookupTable(address: PublicKey) {
    return {
      value: new AddressLookupTableAccount({
        key: address,
        state: {
          deactivationSlot: 18_446_744_073_709_551_615n,
          lastExtendedSlot: 1,
          lastExtendedSlotStartIndex: 0,
          addresses: [poolTokenAccount],
        },
      }),
    };
  },
};

function build(args: Partial<Parameters<typeof buildJupiterSwapTransaction>[0]> = {}) {
  const config = loadConfig(baseEnv({ JUPITER_PROGRAM_ALLOWLIST: ROUTER }));
  return buildJupiterSwapTransaction({
    connection,
    wallet,
    request: request(),
    inMint: mintState(6, '2000000'),
    outMint: mintState(9, '0'),
    quote: quote(),
    instructions: instructions(),
    jupiterProgramIds: config.jupiterProgramIds,
    ...args,
  });
}

describe('buildJupiterSwapTransaction', () => {
  it('compiles a v0 transaction with the bound amount, minimum output, and ATAs', async () => {
    const plan = await build();
    expect(plan.transaction).toBeInstanceOf(VersionedTransaction);
    expect(plan.amountInRaw).toBe(1_500_000n);
    expect(plan.minOutRaw).toBe(995_000_000n);
    expect(plan.quoteOutRaw).toBe(1_000_000_000n);
    expect(plan.policyInput.jupiterSwap).toMatchObject({
      routerProgram: ROUTER,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    });
    expect(plan.policyInput.writableAccounts).toHaveLength(2);
    expect(plan.policyInput.amounts).toMatchObject({ maxSlippageBps: 50 });
    const source = getAssociatedTokenAddressSync(new PublicKey(IN_MINT), wallet);
    expect(plan.policyInput.jupiterSwap?.sourceTokenAccount).toEqual(source);
  });

  it('rejects a quote that does not match the requested pair or amount', async () => {
    await expect(build({ quote: quote({ inAmount: '1499999' }) })).rejects
      .toThrow('does not match the requested swap');
    await expect(build({ quote: quote({ inputMint: OUT_MINT }) })).rejects
      .toThrow(SwapValidationError);
  });

  it('rejects when the wallet cannot fund the exact-in amount', async () => {
    await expect(build({ inMint: mintState(6, '1499999') })).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
  });

  it('never accepts a route whose baked bound exceeds the slippage cap', async () => {
    await expect(build({ quote: quote({ otherAmountThreshold: '900000000' }) })).rejects
      .toMatchObject({ code: 'slippage_exceeded' });
    await expect(build({ quote: quote({ otherAmountThreshold: '0' }) })).rejects
      .toMatchObject({ code: 'slippage_exceeded' });
  });

  it('rejects an unallow-listed router program', async () => {
    const foreign = Keypair.generate().publicKey.toBase58();
    await expect(build({
      instructions: instructions({
        swapInstruction: { ...instructions().swapInstruction, programId: foreign },
      }),
    })).rejects.toThrow('not allow-listed');
  });

  it('rejects setup steps from unknown programs and a duplicated router', async () => {
    const foreign = Keypair.generate().publicKey.toBase58();
    await expect(build({
      instructions: instructions({
        preInstructions: [{ programId: foreign, accounts: [], data: 'AA==' }],
      }),
    })).rejects.toThrow('unknown program');
    await expect(build({
      instructions: instructions({
        postInstructions: [instructions().swapInstruction],
      }),
    })).rejects.toThrow('repeated in setup steps');
  });

  it('rejects a route that spends from or pays to an account other than the wallet ATAs', async () => {
    const foreign = Keypair.generate().publicKey.toBase58();
    const route = instructions().swapInstruction;
    await expect(build({
      instructions: instructions({
        swapInstruction: {
          ...route,
          accounts: route.accounts.map((account, index) =>
            index === 2 ? { ...account, pubkey: foreign } : account),
        },
      }),
    })).rejects.toThrow('source account is not the wallet ATA');
    await expect(build({
      instructions: instructions({
        swapInstruction: {
          ...route,
          accounts: route.accounts.map((account, index) =>
            index === 1 ? { ...account, pubkey: foreign } : account),
        },
      }),
    })).rejects.toThrow('transfer authority is not the wallet');
  });

  it('resolves lookup tables and fails closed when one is missing', async () => {
    const tableAddress = Keypair.generate().publicKey;
    const plan = await build({
      instructions: instructions({ addressLookupTableAddresses: [tableAddress.toBase58()] }),
    });
    expect(plan.addressLookupTableAccounts).toHaveLength(1);
    await expect(build({
      connection: { async getAddressLookupTable() { return { value: null }; } },
      instructions: instructions({ addressLookupTableAddresses: [tableAddress.toBase58()] }),
    })).rejects.toMatchObject({ code: 'rpc_timeout' });
  });

  it('leaves wrapped-SOL legs unbound to an ATA but still amount-bound', async () => {
    const source = Keypair.generate().publicKey;
    const destination = getAssociatedTokenAddressSync(
      new PublicKey(IN_MINT), wallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const plan = await build({
      request: { ...request(), in_mint: WSOL_MINT, out_mint: IN_MINT, amount: 0.01 },
      inMint: mintState(9, '0'),
      outMint: mintState(6, '2000000'),
      quote: quote({ inputMint: WSOL_MINT, outputMint: IN_MINT, inAmount: '10000000' }),
      instructions: instructions({
        swapInstruction: {
          programId: ROUTER,
          accounts: [
            { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
            { pubkey: wallet.toBase58(), isSigner: true, isWritable: true },
            { pubkey: source.toBase58(), isSigner: false, isWritable: true },
            { pubkey: destination.toBase58(), isSigner: false, isWritable: true },
          ],
          data: routeData(10_000_000n, 995_000_000n),
        },
      }),
    });
    expect(plan.policyInput.jupiterSwap?.sourceTokenAccount).toBeNull();
    expect(plan.policyInput.jupiterSwap?.minOutRaw).toBe(995_000_000n);
  });
});
