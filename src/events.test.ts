import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
  decodeEventData,
  decodeEventInstruction,
  decodeTransactionEvents,
  decodeLogMessages,
  eventDiscriminator,
  hasDiscriminator,
  programDataLines,
  type DecodedSwapEvent,
} from './events.js';

const require = createRequire(import.meta.url);
const { BorshEventCoder, utils } = require('@coral-xyz/anchor');
const { IDL } = require('@meteora-ag/dlmm');

const SWAP_FIELDS = [
  { name: 'lbPair', type: 'pubkey' },
  { name: 'from', type: 'pubkey' },
  { name: 'startBinId', type: 'i32' },
  { name: 'endBinId', type: 'i32' },
  { name: 'amountIn', type: 'u64' },
  { name: 'amountOut', type: 'u64' },
  { name: 'swapForY', type: 'bool' },
  { name: 'fee', type: 'u64' },
  { name: 'protocolFee', type: 'u64' },
  { name: 'feeBps', type: 'u128' },
  { name: 'hostFee', type: 'u64' },
];

function coder(): { layouts: Map<string, { span: number; encode(v: unknown, b: Buffer, o?: number): number }> } {
  return new BorshEventCoder({
    ...IDL,
    events: [{ name: 'Swap', fields: SWAP_FIELDS, discriminator: [...eventDiscriminator('Swap')] }],
    types: [...IDL.types, { name: 'Swap', type: { kind: 'struct', fields: SWAP_FIELDS } }],
  });
}

export function encodeSwap(swap: {
  lbPair: string;
  from: string;
  startBinId: number;
  endBinId: number;
  amountIn: string;
  amountOut: string;
  swapForY: boolean;
  fee: string;
  protocolFee?: string;
  feeBps?: string;
  hostFee?: string;
}): string {
  const layout = coder().layouts.get('Swap')!;
  const buf = Buffer.alloc(400);
  const n = layout.encode(
    {
      lbPair: new PublicKey(swap.lbPair),
      from: new PublicKey(swap.from),
      startBinId: swap.startBinId,
      endBinId: swap.endBinId,
      amountIn: new BN(swap.amountIn),
      amountOut: new BN(swap.amountOut),
      swapForY: swap.swapForY,
      fee: new BN(swap.fee),
      protocolFee: new BN(swap.protocolFee ?? '0'),
      feeBps: new BN(swap.feeBps ?? '0'),
      hostFee: new BN(swap.hostFee ?? '0'),
    },
    buf,
    0,
  );
  return Buffer.concat([eventDiscriminator('Swap'), buf.subarray(0, n)]).toString('base64');
}

const POOL = 'FhUkstmiaPRiUio6uENWpV8kXL1cgsiH6FsGHLepXqYQ';
const OTHER_POOL = '6BdMFYgJ4ZHbbXYDNATjJ3QzBhZJFC1c8hqFLdjdvDp';
const FROM = '6pWqTVhrcDiDRky5Y1YHzB2iEAS6fwZU8iGZyPrfEkqK';

describe('DLMM event decoder', () => {
  it('derives the Anchor event discriminator for Swap', () => {
    expect(eventDiscriminator('Swap').toString('hex')).toBe('516ce3becdd00ac4');
    expect(eventDiscriminator('Swap')).toHaveLength(8);
  });

  it('decodes a Swap event with u64 amounts kept exact as strings', () => {
    const payload = encodeSwap({
      lbPair: POOL,
      from: FROM,
      startBinId: 8123,
      endBinId: 8127,
      // Above 2^53 — the BN.toNumber() hazard (spec §5).
      amountIn: '10000000411680503305',
      amountOut: '1760200000',
      swapForY: true,
      fee: '44005000',
      feeBps: '2500000000000000000',
    });
    const event = decodeEventData(payload);
    expect(event).not.toBeNull();
    expect(event!.name).toBe('Swap');
    const swap = event as Extract<NonNullable<typeof event>, { name: 'Swap' }>;
    expect(swap.lbPair.toBase58()).toBe(POOL);
    expect(swap.startBinId).toBe(8123);
    expect(swap.endBinId).toBe(8127);
    expect(swap.amountIn.toString()).toBe('10000000411680503305');
    expect(swap.amountOut.toString()).toBe('1760200000');
    expect(swap.swapForY).toBe(true);
    expect(swap.feeBps.toString()).toBe('2500000000000000000');
  });

  it('decodes the event-CPI inner instruction used by current Meteora swaps', () => {
    const payload = Buffer.from(encodeSwap({
      lbPair: POOL,
      from: FROM,
      startBinId: 8123,
      endBinId: 8127,
      amountIn: '12500000000',
      amountOut: '1760200000',
      swapForY: true,
      fee: '31250000',
    }), 'base64');
    // Current mainnet event-CPI instructions have an 8-byte instruction tag
    // before the ordinary Anchor event discriminator and payload.
    const instruction = utils.bytes.bs58.encode(
      Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), payload]),
    );
    const event = decodeEventInstruction(instruction) as DecodedSwapEvent;
    expect(event.name).toBe('Swap');
    expect(event.lbPair.toBase58()).toBe(POOL);
    expect(event.startBinId).toBe(8123);
    expect(event.endBinId).toBe(8127);
    expect(decodeTransactionEvents([], [instruction])).toHaveLength(1);
  });

  it('identifies the discriminator without decoding', () => {
    const payload = encodeSwap({
      lbPair: POOL, from: FROM, startBinId: 1, endBinId: 2,
      amountIn: '1', amountOut: '2', swapForY: false, fee: '0',
    });
    expect(hasDiscriminator(payload, 'Swap')).toBe(true);
    expect(hasDiscriminator(payload, 'GoToABin')).toBe(false);
  });

  it('returns null for undecodable payloads instead of throwing', () => {
    expect(decodeEventData('not base64 !!')).toBeNull();
    expect(decodeEventData('')).toBeNull();
    expect(decodeEventData(Buffer.from([1, 2, 3]).toString('base64'))).toBeNull();
  });

  it('reads Program data lines out of log messages and skips the rest', () => {
    const payload = encodeSwap({
      lbPair: POOL, from: FROM, startBinId: 5, endBinId: 9,
      amountIn: '10', amountOut: '20', swapForY: true, fee: '1',
    });
    const logs = [
      'Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]',
      'Program log: Instruction: Swap2',
      `Program data: ${payload}`,
      'Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo success',
      'Program data: truncated',
    ];
    const lines = programDataLines(logs);
    expect(lines).toEqual([payload, 'truncated']);
    const events = decodeLogMessages(logs);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('Swap');
  });

  it('ignores swaps on pools that are not configured', () => {
    const payload = encodeSwap({
      lbPair: OTHER_POOL, from: FROM, startBinId: 1, endBinId: 2,
      amountIn: '1', amountOut: '2', swapForY: false, fee: '0',
    });
    const event = decodeEventData(payload)!;
    expect((event as { lbPair: PublicKey }).lbPair.toBase58()).toBe(OTHER_POOL);
  });

  it('decodes the recorded log payload fixture', () => {
    const fixture = JSON.parse(
      fs.readFileSync(new URL('../fixtures/rpc/dlmm-swap-logs.json', import.meta.url), 'utf8'),
    ) as { pool: string; swaps: { payload: string }[] };
    const events = fixture.swaps.map((row) => decodeEventData(row.payload));
    expect(events).toHaveLength(3);
    expect(events.every((event) => event?.name === 'Swap')).toBe(true);
    expect(events.map((event) => (event as DecodedSwapEvent).lbPair.toBase58())).toEqual([
      fixture.pool,
      fixture.pool,
      OTHER_POOL,
    ]);
  });
});
