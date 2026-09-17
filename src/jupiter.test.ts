import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { JupiterError, createJupiterClient, type JupiterRequest } from './jupiter.js';
import { baseEnv } from './testing.js';

const IN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OUT_MINT = 'So11111111111111111111111111111111111111112';

function quotePayload(overrides: Record<string, unknown> = {}) {
  return {
    inputMint: IN_MINT, outputMint: OUT_MINT,
    inAmount: '1000000', outAmount: '150000000', otherAmountThreshold: '149250000',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.01',
    routePlan: [{ swapInfo: {} }],
    ...overrides,
  };
}

function clientWith(handler: (url: string, init: unknown) => unknown) {
  const calls: { url: string; config: Record<string, unknown> }[] = [];
  const request: JupiterRequest = async (config) => {
    calls.push({ url: String(config.url), config: config as Record<string, unknown> });
    return handler(String(config.url), config);
  };
  return { client: createJupiterClient(loadConfig(baseEnv()), request), calls };
}

describe('createJupiterClient', () => {
  it('requests an ExactIn quote against the configured base with raw amount', async () => {
    const { client, calls } = clientWith(() => quotePayload());
    const quote = await client.quote({
      inputMint: IN_MINT, outputMint: OUT_MINT, amount: '1000000', slippageBps: 50, taker: 'taker',
    });
    expect(quote.outAmount).toBe('150000000');
    expect(calls[0]!.url).toBe('https://lite-api.jup.ag/swap/v1/quote');
    expect(calls[0]!.config.params).toMatchObject({
      inputMint: IN_MINT, amount: '1000000', slippageBps: 50, swapMode: 'ExactIn', taker: 'taker',
    });
  });

  it('posts the quote response and taker to swap-instructions', async () => {
    const { client, calls } = clientWith((url) => url.endsWith('/quote')
      ? quotePayload()
      : {
        swapInstruction: {
          programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
          accounts: [], data: 'AA==',
        },
      });
    const quote = await client.quote({
      inputMint: IN_MINT, outputMint: OUT_MINT, amount: '1000000', slippageBps: 50, taker: 'taker',
    });
    const instructions = await client.swapInstructions(quote, 'taker');
    expect(calls[1]!.url).toBe('https://lite-api.jup.ag/swap/v1/swap-instructions');
    expect(calls[1]!.config.data).toMatchObject({ userPublicKey: 'taker' });
    expect(instructions.swapInstruction.programId).toBeTypeOf('string');
  });

  it('honors JUPITER_BASE_URL', async () => {
    const config = loadConfig(baseEnv({ JUPITER_BASE_URL: 'https://api.test/swap/v1/' }));
    const client = createJupiterClient(config, async (c) => {
      expect(String(c.url)).toBe('https://api.test/swap/v1/quote');
      return quotePayload();
    });
    await client.quote({
      inputMint: IN_MINT, outputMint: OUT_MINT, amount: '1', slippageBps: 10, taker: 't',
    });
  });

  it('rejects malformed or partial API payloads rather than guessing', async () => {
    for (const payload of [
      quotePayload({ outAmount: 150 }),
      quotePayload({ swapMode: 'ExactOut' }),
      quotePayload({ routePlan: [] }),
      null,
    ]) {
      const { client } = clientWith(() => payload);
      await expect(client.quote({
        inputMint: IN_MINT, outputMint: OUT_MINT, amount: '1', slippageBps: 10, taker: 't',
      })).rejects.toBeInstanceOf(JupiterError);
    }
  });

  it('wraps transport failures in JupiterError', async () => {
    const { client } = clientWith(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(client.quote({
      inputMint: IN_MINT, outputMint: OUT_MINT, amount: '1', slippageBps: 10, taker: 't',
    })).rejects.toThrow('Jupiter quote request failed');
  });

  it('requires swapInstruction and tolerates absent instruction lists', async () => {
    const { client } = clientWith(() => ({
      swapInstruction: {
        programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        accounts: [{ pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false }],
        data: 'AA==',
      },
    }));
    const parsed = await client.swapInstructions(quotePayload() as never, 'taker');
    expect(parsed.preInstructions).toEqual([]);
    expect(parsed.postInstructions).toEqual([]);
    expect(parsed.addressLookupTableAddresses).toEqual([]);
    const missing = clientWith(() => ({}));
    await expect(missing.client.swapInstructions(quotePayload() as never, 'taker'))
      .rejects.toBeInstanceOf(JupiterError);
  });
});
