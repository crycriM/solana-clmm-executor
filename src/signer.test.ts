/**
 * Signer units. A real Node Ed25519 keypair stands in for KMS: it produces
 * genuine SPKI DER and genuine signatures, so the derivation and verification
 * paths are exercised for real without an AWS call.
 */

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KMSClient } from '@aws-sdk/client-kms';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addressFromSpki,
  createFileSigner,
  createKmsSigner,
  rawEd25519FromSpki,
  SignerError,
} from './signer.js';

const ARN = 'arn:aws:kms:eu-west-1:111122223333:key/test-key';

function ed25519Key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    spki: publicKey.export({ format: 'der', type: 'spki' }),
    raw: publicKey.export({ format: 'jwk' }).x as string,
  };
}

interface FakeOptions {
  spki?: Uint8Array;
  keySpec?: string;
  keyUsage?: string;
  /** Replace the signature KMS returns, to exercise the fail-closed path. */
  corrupt?: (signature: Buffer) => Buffer | undefined;
  onSign?: (input: Record<string, unknown>) => void;
}

function fakeKms(key: ReturnType<typeof ed25519Key>, options: FakeOptions = {}): KMSClient {
  const send = async (command: { input: Record<string, unknown> }) => {
    if (command.input.Message === undefined) {
      return {
        PublicKey: options.spki ?? key.spki,
        KeySpec: options.keySpec ?? 'ECC_NIST_EDWARDS25519',
        KeyUsage: options.keyUsage ?? 'SIGN_VERIFY',
      };
    }
    options.onSign?.(command.input);
    const message = Buffer.from(command.input.Message as Uint8Array);
    const signature = nodeSign(null, message, key.privateKey);
    return { Signature: options.corrupt ? options.corrupt(signature) : signature };
  };
  return { send } as unknown as KMSClient;
}

describe('public key derivation', () => {
  it('derives the same address Node derives from the raw point', () => {
    const key = ed25519Key();
    const raw = Buffer.from(key.raw, 'base64url');
    expect(rawEd25519FromSpki(key.spki)).toEqual(raw);
    // The Solana address *is* the raw Ed25519 point, base58-encoded.
    expect(addressFromSpki(key.spki).toBytes()).toEqual(Uint8Array.from(raw));
  });

  it('rejects a non-Ed25519 SPKI blob', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    expect(() => rawEd25519FromSpki(spki)).toThrow(SignerError);
  });

  it('rejects a bare 32-byte key with no SPKI wrapper', () => {
    expect(() => rawEd25519FromSpki(Buffer.alloc(32, 7))).toThrow(SignerError);
  });

  it('rejects a truncated SPKI blob', () => {
    const key = ed25519Key();
    expect(() => rawEd25519FromSpki(Buffer.from(key.spki).subarray(0, 43))).toThrow(SignerError);
  });
});

describe('createKmsSigner', () => {
  it('rejects a key with the wrong spec before any signing is possible', async () => {
    const key = ed25519Key();
    await expect(createKmsSigner(ARN, fakeKms(key, { keySpec: 'ECC_NIST_P256' }))).rejects.toThrow(
      SignerError,
    );
  });

  it('rejects a key that is not SIGN_VERIFY', async () => {
    const key = ed25519Key();
    await expect(
      createKmsSigner(ARN, fakeKms(key, { keyUsage: 'ENCRYPT_DECRYPT' })),
    ).rejects.toThrow(SignerError);
  });

  it('signs with pure EdDSA over the raw message', async () => {
    const key = ed25519Key();
    const calls: Record<string, unknown>[] = [];
    const signer = await createKmsSigner(ARN, fakeKms(key, { onSign: (i) => calls.push(i) }));
    const message = Buffer.from('solana transaction message bytes');

    const signature = await signer.sign(message);

    expect(signature).toHaveLength(64);
    expect(signer.signerId).toBe(ARN);
    // The prehashed variant would be a silent wrong-algorithm bug on-chain.
    expect(calls[0]).toMatchObject({
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
  });

  it('fails closed when KMS returns a signature that does not verify', async () => {
    const key = ed25519Key();
    const flip = (signature: Buffer) => {
      const bad = Buffer.from(signature);
      bad[0] ^= 0xff;
      return bad;
    };
    const signer = await createKmsSigner(ARN, fakeKms(key, { corrupt: flip }));
    await expect(signer.sign(Buffer.from('m'))).rejects.toThrow(/local Ed25519 verification/);
  });

  it('fails closed on a wrong-length signature', async () => {
    const key = ed25519Key();
    const signer = await createKmsSigner(ARN, fakeKms(key, { corrupt: (s) => s.subarray(0, 63) }));
    await expect(signer.sign(Buffer.from('m'))).rejects.toThrow(SignerError);
  });

  it('fails closed when KMS returns no signature at all', async () => {
    const key = ed25519Key();
    const signer = await createKmsSigner(ARN, fakeKms(key, { corrupt: () => undefined }));
    await expect(signer.sign(Buffer.from('m'))).rejects.toThrow(/no signature/);
  });

  it('propagates a KMS denial rather than returning an unsigned result', async () => {
    const denied = {
      send: async () => {
        throw new Error('AccessDeniedException');
      },
    } as unknown as KMSClient;
    await expect(createKmsSigner(ARN, denied)).rejects.toThrow('AccessDeniedException');
  });
});

describe('createFileSigner (arm B)', () => {
  // mkdtemp creates 0700, matching the directory mode arm B requires.
  const dirs: string[] = [];

  function keyfile(contents: unknown, mode = 0o400): string {
    const dir = mkdtempSync(join(tmpdir(), 'clmm-signer-'));
    dirs.push(dir);
    const path = join(dir, 'wallet.json');
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
    chmodSync(path, mode);
    return path;
  }

  function solanaKeyfile(keypair = Keypair.generate(), mode = 0o400) {
    return { keypair, path: keyfile([...keypair.secretKey], mode) };
  }

  afterEach(() => {
    // 0400 files would otherwise survive; make them removable by the runner.
    for (const dir of dirs.splice(0)) chmodSync(dir, 0o700);
  });

  it('derives the same address the Solana SDK does', () => {
    const { keypair, path } = solanaKeyfile();
    expect(createFileSigner(path).publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  it('produces a signature the Solana SDK accepts on a real transaction', async () => {
    const { keypair, path } = solanaKeyfile();
    const signer = createFileSigner(path);
    const tx = new Transaction({
      feePayer: keypair.publicKey,
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    }).add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: keypair.publicKey,
        lamports: 1,
      }),
    );

    tx.addSignature(keypair.publicKey, await signer.sign(tx.serializeMessage()));

    // serialize() re-verifies every signature against the message.
    expect(() => tx.serialize()).not.toThrow();
    expect(signer.signerId).toBe(keypair.publicKey.toBase58());
  });

  it('rejects a group- or world-readable keyfile', () => {
    const { path } = solanaKeyfile(Keypair.generate(), 0o644);
    expect(() => createFileSigner(path)).toThrow(/group- or world-accessible/);
  });

  it('rejects a keyfile whose directory is group- or world-accessible', () => {
    const { path } = solanaKeyfile();
    chmodSync(dirs[dirs.length - 1], 0o755);
    expect(() => createFileSigner(path)).toThrow(/must be 0700 or stricter/);
  });

  it('rejects a pin mismatch without disclosing the key', () => {
    const { keypair, path } = solanaKeyfile();
    const other = Keypair.generate().publicKey.toBase58();
    try {
      createFileSigner(path, { expectedPublicKey: other });
      expect.unreachable('pin mismatch must throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(other);
      expect(message).toContain(keypair.publicKey.toBase58());
      expect(message).not.toContain(String(keypair.secretKey[0]));
    }
  });

  it('accepts a matching pin', () => {
    const { keypair, path } = solanaKeyfile();
    const signer = createFileSigner(path, { expectedPublicKey: keypair.publicKey.toBase58() });
    expect(signer.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it('rejects a file whose public half does not match its secret half', () => {
    const secret = [...Keypair.generate().secretKey];
    secret.splice(32, 32, ...Keypair.generate().publicKey.toBytes());
    expect(() => createFileSigner(keyfile(secret))).toThrow(/public half does not match/);
  });

  it('rejects a wrong-length array', () => {
    expect(() => createFileSigner(keyfile(new Array(32).fill(1)))).toThrow(/64 bytes/);
  });

  it('rejects values outside the byte range', () => {
    const secret = [...Keypair.generate().secretKey];
    secret[0] = 256;
    expect(() => createFileSigner(keyfile(secret))).toThrow(/outside the byte range/);
  });

  it('rejects a non-JSON keyfile', () => {
    expect(() => createFileSigner(keyfile('-----BEGIN PRIVATE KEY-----'))).toThrow(/valid JSON/);
  });

  it('fails closed when the keyfile is missing', () => {
    expect(() => createFileSigner(join(tmpdir(), 'clmm-does-not-exist', 'wallet.json'))).toThrow();
  });
});
