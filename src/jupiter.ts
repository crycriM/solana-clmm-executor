/**
 * Jupiter Swap API client for the M5 `pool:null` route (plan T5.1).
 *
 * Raw HTTP against the JSON API — the same decision the plan records for the
 * Jito path: avoid a heavy SDK when ~100 lines of typed fetch suffice. The
 * client never signs or submits; it only returns the quote and the
 * instructions the swap builder binds and re-verifies.
 */

import axios, { type AxiosRequestConfig } from 'axios';
import type { ExecutorConfig } from './config.js';

export class JupiterError extends Error {}

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw u64 in input-mint units. */
  amount: string;
  slippageBps: number;
  taker: string;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface JupiterInstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface JupiterInstruction {
  programId: string;
  accounts: JupiterInstructionAccount[];
  /** base64 */
  data: string;
}

export interface JupiterSwapInstructions {
  swapInstruction: JupiterInstruction;
  preInstructions: JupiterInstruction[];
  postInstructions: JupiterInstruction[];
  addressLookupTableAddresses?: string[];
}

export interface JupiterClient {
  quote(params: JupiterQuoteParams): Promise<JupiterQuote>;
  swapInstructions(quote: JupiterQuote, userPublicKey: string): Promise<JupiterSwapInstructions>;
}

function u64Text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new JupiterError(`Jupiter ${field} is not a raw u64 string`);
  }
  return value;
}

function parseQuote(payload: unknown): JupiterQuote {
  if (payload === null || typeof payload !== 'object') {
    throw new JupiterError('Jupiter quote response is not an object');
  }
  const value = payload as Record<string, unknown>;
  const quote: JupiterQuote = {
    inputMint: typeof value.inputMint === 'string' ? value.inputMint : '',
    outputMint: typeof value.outputMint === 'string' ? value.outputMint : '',
    inAmount: u64Text(value.inAmount, 'inAmount'),
    outAmount: u64Text(value.outAmount, 'outAmount'),
    otherAmountThreshold: u64Text(value.otherAmountThreshold, 'otherAmountThreshold'),
    swapMode: typeof value.swapMode === 'string' ? value.swapMode : '',
    slippageBps: typeof value.slippageBps === 'number' ? value.slippageBps : -1,
    priceImpactPct:
      typeof value.priceImpactPct === 'number' || typeof value.priceImpactPct === 'string'
        ? String(value.priceImpactPct)
        : '',
    routePlan: Array.isArray(value.routePlan) ? value.routePlan : [],
  };
  if (!quote.inputMint || !quote.outputMint || quote.swapMode !== 'ExactIn' ||
      quote.slippageBps < 0 || quote.routePlan.length === 0) {
    throw new JupiterError('Jupiter quote omitted required routing fields');
  }
  return quote;
}

function parseInstruction(payload: unknown, field: string): JupiterInstruction {
  if (payload === null || typeof payload !== 'object') {
    throw new JupiterError(`Jupiter ${field} is not an object`);
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.programId !== 'string' || typeof value.data !== 'string' ||
      !Array.isArray(value.accounts)) {
    throw new JupiterError(`Jupiter ${field} is malformed`);
  }
  return {
    programId: value.programId,
    data: value.data,
    accounts: value.accounts.map((account) => {
      if (account === null || typeof account !== 'object') {
        throw new JupiterError(`Jupiter ${field} account is malformed`);
      }
      const row = account as Record<string, unknown>;
      if (typeof row.pubkey !== 'string') {
        throw new JupiterError(`Jupiter ${field} account is malformed`);
      }
      return {
        pubkey: row.pubkey,
        isSigner: row.isSigner === true,
        isWritable: row.isWritable === true,
      };
    }),
  };
}

function parseSwapInstructions(payload: unknown): JupiterSwapInstructions {
  if (payload === null || typeof payload !== 'object') {
    throw new JupiterError('Jupiter swap-instructions response is not an object');
  }
  const value = payload as Record<string, unknown>;
  const list = (rows: unknown, field: string): JupiterInstruction[] => {
    if (rows === undefined) return [];
    if (!Array.isArray(rows)) throw new JupiterError(`Jupiter ${field} is not an array`);
    return rows.map((row) => parseInstruction(row, field));
  };
  return {
    swapInstruction: parseInstruction(value.swapInstruction, 'swapInstruction'),
    preInstructions: list(value.preInstructions, 'preInstructions'),
    postInstructions: list(value.postInstructions, 'postInstructions'),
    addressLookupTableAddresses: Array.isArray(value.addressLookupTableAddresses)
      ? value.addressLookupTableAddresses.filter((row): row is string => typeof row === 'string')
      : [],
  };
}

export type JupiterRequest = (config: AxiosRequestConfig) => Promise<unknown>;

export function createJupiterClient(
  config: ExecutorConfig,
  request: JupiterRequest = async (axiosConfig) =>
    (await axios({ ...axiosConfig, timeout: axiosConfig.timeout ?? 10_000 })).data,
): JupiterClient {
  const base = config.jupiterBaseUrl.replace(/\/+$/, '');
  return {
    async quote(params) {
      let payload: unknown;
      try {
        payload = await request({
          method: 'get',
          url: `${base}/quote`,
          params: {
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            amount: params.amount,
            slippageBps: params.slippageBps,
            swapMode: 'ExactIn',
            taker: params.taker,
          },
        });
      } catch {
        throw new JupiterError('Jupiter quote request failed');
      }
      return parseQuote(payload);
    },
    async swapInstructions(quote, userPublicKey) {
      let payload: unknown;
      try {
        payload = await request({
          method: 'post',
          url: `${base}/swap-instructions`,
          data: { quoteResponse: quote, userPublicKey },
        });
      } catch {
        throw new JupiterError('Jupiter swap-instructions request failed');
      }
      return parseSwapInstructions(payload);
    },
  };
}
