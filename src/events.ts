/**
 * Borsh decoding of Meteora DLMM program events.
 *
 * The DLMM IDL (v0.9.0, `@meteora-ag/dlmm@1.5.0`) declares `events` but ships
 * no matching `types` entries and no `discriminator` bytes, so Anchor 0.30's
 * `BorshEventCoder` refuses to construct from it
 * (`Event not found: <name>` / `Events require idl.types`). Rather than depend
 * on a coder that cannot read this IDL, we decode the two events the swap
 * stream needs with explicit layouts:
 *
 * - `Swap`:     8-byte discriminator + borsh struct, 129 bytes payload total.
 * - `GoToABin`: emitted when the active bin moves without a swap; carries the
 *   authoritative `fromBinId`/`toBinId` pair.
 *
 * Amounts are u64: they are handed back as `BN`, never `toNumber()`, because
 * the value exceeds Number.MAX_SAFE_INTEGER.
 */
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import type { Idl } from '@coral-xyz/anchor';
import { BorshEventCoder, utils } from '@coral-xyz/anchor';
import { createRequire } from 'node:module';

/** Anchor event discriminator: first 8 bytes of sha256("event:<Name>"). */
export function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

/**
 * Field → codec table for the events we decode.
 *
 * Kept hand-written because the shipped IDL cannot be fed to `BorshEventCoder`
 * directly; see the file header. Types mirror `IDL.events` field-for-field.
 */
const EVENT_FIELDS = {
  Swap: [
    ['lbPair', 'publicKey'],
    ['from', 'publicKey'],
    ['startBinId', 'i32'],
    ['endBinId', 'i32'],
    ['amountIn', 'u64'],
    ['amountOut', 'u64'],
    ['swapForY', 'bool'],
    ['fee', 'u64'],
    ['protocolFee', 'u64'],
    ['feeBps', 'u128'],
    ['hostFee', 'u64'],
  ],
  GoToABin: [
    ['lbPair', 'publicKey'],
    ['fromBinId', 'i32'],
    ['toBinId', 'i32'],
  ],
} as const;

export type DecodedEventName = keyof typeof EVENT_FIELDS;

export interface DecodedSwapEvent {
  name: 'Swap';
  lbPair: PublicKey;
  from: PublicKey;
  startBinId: number;
  endBinId: number;
  amountIn: BN;
  amountOut: BN;
  swapForY: boolean;
  fee: BN;
  protocolFee: BN;
  feeBps: BN;
  hostFee: BN;
}

export interface DecodedGoToABinEvent {
  name: 'GoToABin';
  lbPair: PublicKey;
  fromBinId: number;
  toBinId: number;
}

export type DecodedEvent = DecodedSwapEvent | DecodedGoToABinEvent;

type AnyEvent = DecodedSwapEvent | DecodedGoToABinEvent;

/** Load the shipped IDL lazily: importing the SDK pulls in its whole stack. */
function loadIdl(): Idl {
  const require = createRequire(import.meta.url);
  const sdk = require('@meteora-ag/dlmm') as { IDL: Idl };
  return sdk.IDL;
}

/**
 * Event coders for the events we decode, built from the shipped IDL.
 *
 * The IDL's `events` entries are rewritten into `types` structs — Anchor expects
 * an event to have a same-named type definition — and `publicKey` is remapped to
 * Anchor's `pubkey` spelling. One coder per event so a layout problem in one
 * event cannot take down the others.
 */
function buildCoders(): Map<DecodedEventName, BorshEventCoder> {
  const idl = loadIdl();
  const coders = new Map<DecodedEventName, BorshEventCoder>();
  for (const name of Object.keys(EVENT_FIELDS) as DecodedEventName[]) {
    const fields = EVENT_FIELDS[name].map(([field, type]) => ({
      name: field,
      // The IDL spells the type `publicKey`; Anchor's borsh coder wants
      // `pubkey` and throws on the former.
      type: type === 'publicKey' ? 'pubkey' : type,
    }));
    const event = {
      name,
      fields,
      // Anchor's IdlEvent types the discriminator as number[].
      discriminator: [...eventDiscriminator(name)],
    };
    coders.set(
      name,
      new BorshEventCoder({
        ...idl,
        events: [event],
        types: [...(idl.types ?? []), { name, type: { kind: 'struct', fields } }],
      } as unknown as Idl),
    );
  }
  return coders;
}

let coders: Map<DecodedEventName, BorshEventCoder> | null = null;

function coderFor(name: DecodedEventName): BorshEventCoder {
  if (coders === null) coders = buildCoders();
  const coder = coders.get(name);
  if (!coder) throw new Error(`no event coder for ${name}`);
  return coder;
}

/**
 * Decode one Anchor `Program data:` payload (base64, discriminator-prefixed).
 *
 * Returns null for undecodable input rather than throwing: the swap stream is
 * fed by untrusted log text and must not die on a single bad line. Each known
 * event is tried in turn because Anchor's coder is built per-event here.
 */
export function decodeEventData(base64Payload: string): DecodedEvent | null {
  for (const name of ['Swap', 'GoToABin'] as const) {
    let decoded: { name: string; data: Record<string, unknown> } | null = null;
    try {
      decoded = coderFor(name).decode(base64Payload) as {
        name: string;
        data: Record<string, unknown>;
      } | null;
    } catch {
      continue;
    }
    if (decoded === null || decoded.name !== name) continue;
    return { name, ...decoded.data } as unknown as AnyEvent;
  }
  return null;
}

/**
 * Decode Anchor's event-CPI instruction data.
 *
 * Current Meteora swaps do not print `Program data:`. They self-invoke the
 * DLMM program with an 8-byte event-CPI instruction tag followed by the normal
 * Anchor event discriminator + borsh payload. RPC exposes this as base58 in
 * `meta.innerInstructions[*].instructions[*].data`.
 */
export function decodeEventInstruction(base58Data: string): DecodedEvent | null {
  let bytes: Uint8Array;
  try {
    bytes = utils.bytes.bs58.decode(base58Data);
  } catch {
    return null;
  }
  if (bytes.length <= 8) return null;
  return decodeEventData(Buffer.from(bytes.subarray(8)).toString('base64'));
}

/** Decode all recognized Anchor event-CPI instructions in one transaction. */
export function decodeEventInstructions(instructions: readonly string[]): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  for (const data of instructions) {
    const event = decodeEventInstruction(data);
    if (event !== null) events.push(event);
  }
  return events;
}

/** Support both historical log events and current event-CPI transactions. */
export function decodeTransactionEvents(
  logMessages: readonly string[],
  eventInstructions: readonly string[] = [],
): DecodedEvent[] {
  const logged = decodeLogMessages(logMessages);
  return logged.length > 0 ? logged : decodeEventInstructions(eventInstructions);
}

/** True when a payload's discriminator matches `name`. */
export function hasDiscriminator(base64Payload: string, name: DecodedEventName): boolean {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Payload, 'base64');
  } catch {
    return false;
  }
  return bytes.subarray(0, 8).equals(eventDiscriminator(name));
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

/**
 * Pull every Anchor self-CPI event out of a transaction's `logMessages`.
 *
 * A single swap transaction can carry several events (a `Swap` plus
 * `CompositionFee` per bin); callers filter by `name`. Malformed lines are
 * skipped: the log tail is untrusted input.
 */
export function decodeLogMessages(logMessages: readonly string[]): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  for (const line of logMessages) {
    const index = line.indexOf(PROGRAM_DATA_PREFIX);
    if (index < 0) continue;
    const payload = line.slice(index + PROGRAM_DATA_PREFIX.length).trim();
    if (payload.length === 0) continue;
    const event = decodeEventData(payload);
    if (event !== null) events.push(event);
  }
  return events;
}

/**
 * The `Program data:` log lines of a transaction, base64 payloads only.
 *
 * Recorded fixtures store these rather than whole transactions: it keeps the
 * fixture small and exercises exactly the decode path the live stream uses.
 */
export function programDataLines(logMessages: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of logMessages) {
    const index = line.indexOf(PROGRAM_DATA_PREFIX);
    if (index < 0) continue;
    out.push(line.slice(index + PROGRAM_DATA_PREFIX.length).trim());
  }
  return out;
}

