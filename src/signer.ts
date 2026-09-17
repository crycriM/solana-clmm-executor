/**
 * Wallet signing with two deployment arms:
 *
 * - `createKmsSigner`: cloud custody. The private key stays inside AWS KMS and
 *   is not extractable; each signature costs a network round trip.
 * - `createFileSigner`: a single-tenant server holding the keypair on disk.
 *   Signing is in-process; custody rests entirely on filesystem permissions.
 *
 * Both produce a 64-byte Ed25519 signature over a serialized Solana message,
 * and both are subject to the same transaction policy — the arm changes where
 * the key lives, nothing else.
 *
 * The KMS path never holds private key material: a serialized Solana message
 * goes to KMS, a 64-byte Ed25519 signature comes back. AWS KMS gained Ed25519
 * (EdDSA) on 2025-11-07; the key must be KeySpec=ECC_NIST_EDWARDS25519,
 * KeyUsage=SIGN_VERIFY.
 *
 * ED25519_SHA_512 + MessageType=RAW is pure EdDSA and is the only correct
 * choice here. ED25519_PH_SHA_512 (HashEdDSA, MessageType=DIGEST) is a
 * *different algorithm* whose signatures Solana rejects — KMS prehashes again
 * on top of your digest. Do not "fix" a failure by switching to it.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { ExecutorConfig } from './config.js';

/** DER SubjectPublicKeyInfo prefix for an Ed25519 key (RFC 8410 §4). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_SPKI_LENGTH = ED25519_SPKI_PREFIX.length + 32;

/** PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410 §7). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Solana CLI keypair files are 32 seed bytes followed by 32 public-key bytes. */
const SOLANA_KEYPAIR_BYTES = 64;

/** The canonical mainnet-beta genesis hash, not a hostname heuristic. */
export const MAINNET_BETA_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export class SignerError extends Error {}

export interface Signer {
  /** The Solana address this signer controls. */
  readonly publicKey: PublicKey;
  /** Signer identity for the executor JSONL; never key material. */
  readonly signerId: string;
  /** 64-byte Ed25519 signature over `message`, locally verified before return. */
  sign(message: Uint8Array): Promise<Buffer>;
}

/**
 * Extract the 32-byte Ed25519 point from a DER SubjectPublicKeyInfo blob.
 *
 * Strict on length *and* prefix: the derived address is the wallet, so a
 * wrong-curve or truncated key must fail loudly rather than yield a plausible
 * 32 bytes that silently addresses funds we cannot spend.
 */
export function rawEd25519FromSpki(der: Uint8Array): Buffer {
  const buffer = Buffer.from(der);
  const prefix = buffer.subarray(0, ED25519_SPKI_PREFIX.length);
  if (buffer.length !== ED25519_SPKI_LENGTH || !prefix.equals(ED25519_SPKI_PREFIX)) {
    throw new SignerError('GetPublicKey did not return an Ed25519 SubjectPublicKeyInfo');
  }
  return buffer.subarray(ED25519_SPKI_PREFIX.length);
}

/** The Solana address a KMS DER public key corresponds to. */
export function addressFromSpki(der: Uint8Array): PublicKey {
  return new PublicKey(rawEd25519FromSpki(der));
}

/**
 * Resolve the KMS key's public half once at startup, then sign against it.
 *
 * Fetching the key eagerly means a misconfigured ARN, a wrong key spec, or a
 * missing kms:GetPublicKey grant fails at construction rather than at the
 * first live mutation.
 */
export async function createKmsSigner(
  keyArn: string,
  client: KMSClient = new KMSClient({}),
): Promise<Signer> {
  const key = await client.send(new GetPublicKeyCommand({ KeyId: keyArn }));

  if (key.KeySpec !== 'ECC_NIST_EDWARDS25519' || key.KeyUsage !== 'SIGN_VERIFY') {
    throw new SignerError(
      `KMS key must be ECC_NIST_EDWARDS25519/SIGN_VERIFY, got ${key.KeySpec}/${key.KeyUsage}`,
    );
  }
  if (!key.PublicKey) throw new SignerError('GetPublicKey returned no key material');

  const spki = Buffer.from(key.PublicKey);
  const publicKey = addressFromSpki(spki);
  const verifier = createPublicKey({ key: spki, format: 'der', type: 'spki' });

  return {
    publicKey,
    signerId: keyArn,
    sign: (message) => kmsSign(client, keyArn, verifier, message),
  };
}

async function kmsSign(
  client: KMSClient,
  keyArn: string,
  verifier: KeyObject,
  message: Uint8Array,
): Promise<Buffer> {
  // ponytail: SDK default retries/timeouts. A KMS timeout or AccessDenied
  // throws out of here and the caller never gets a signature — that is the
  // required fail-closed behaviour, so no handling is added.
  const response = await client.send(
    new SignCommand({
      KeyId: keyArn,
      Message: message,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    }),
  );

  if (!response.Signature) throw new SignerError('KMS Sign returned no signature');
  const signature = Buffer.from(response.Signature);

  // An unverified signature must never reach the network: a silently corrupt
  // one burns a blockhash and a fee, and looks like an RPC fault when it does.
  if (signature.length !== 64 || !verifyEd25519(null, message, verifier, signature)) {
    throw new SignerError('KMS signature failed local Ed25519 verification');
  }
  return signature;
}

export interface FileSignerOptions {
  /** `WALLET_PUBKEY`. When set, the loaded key must derive this address. */
  expectedPublicKey?: string;
}

/**
 * Arm B starts local-only.  Check the chain identity before reading the key
 * file: URLs are aliases/proxies, whereas the genesis hash is the network
 * identity Solana clients use.  Mainnet needs a deliberate, audited override.
 */
export async function assertFileSignerNetwork(
  config: Pick<ExecutorConfig, 'walletSigner' | 'fileSignerAllowMainnet'>,
  connection: Pick<Connection, 'getGenesisHash'>,
): Promise<void> {
  if (config.walletSigner !== 'file' || config.fileSignerAllowMainnet) return;
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash === MAINNET_BETA_GENESIS_HASH) {
    throw new SignerError(
      'file signer is local/devnet-only; set FILE_SIGNER_ALLOW_MAINNET=true only after the Arm B mainnet gate',
    );
  }
}

/** Resolve the selected signer after Arm B's network guard has passed. */
export async function createConfiguredSigner(
  config: ExecutorConfig,
  connection?: Pick<Connection, 'getGenesisHash'>,
  kmsClient?: KMSClient,
): Promise<Signer> {
  if (config.walletSigner === 'file') {
    if (!config.walletKeypairPath) throw new SignerError('WALLET_KEYPAIR_PATH is required');
    if (!connection) throw new SignerError('file signer requires a chain identity check');
    await assertFileSignerNetwork(config, connection);
    return createFileSigner(config.walletKeypairPath, { expectedPublicKey: config.walletPubkey ?? undefined });
  }
  if (config.walletSigner === 'kms') {
    if (!config.kmsKeyArn) throw new SignerError('KMS_KEY_ARN is required');
    return createKmsSigner(config.kmsKeyArn, kmsClient);
  }
  // The legacy Secrets Manager fallback is intentionally not implemented.
  throw new SignerError('keypair signer is not implemented; use kms or file');
}

/**
 * File-based signing: the keypair lives in a file on a
 * single-tenant server and signing happens in-process.
 *
 * Weaker custody than KMS by construction — root and anyone who can read the
 * file has the key — so the filesystem checks below are the whole boundary and
 * every one of them fails closed at startup rather than at first signature.
 */
export function createFileSigner(keypairPath: string, options: FileSignerOptions = {}): Signer {
  assertPrivateFile(keypairPath);
  const secret = readKeypairFile(keypairPath);

  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, secret.subarray(0, 32)]),
      format: 'der',
      type: 'pkcs8',
    });

    // The secret half is authoritative; the file's trailing public half is a
    // claim. A mismatch means a corrupt or tampered file, so refuse it rather
    // than quietly preferring one over the other.
    const publicKey = addressFromSpki(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }),
    );
    if (!publicKey.toBuffer().equals(secret.subarray(32))) {
      throw new SignerError(`${keypairPath}: public half does not match the secret half`);
    }

    // Without this pin, deploying the wrong keyfile trades from the wrong
    // wallet silently: the §6 fee-payer check validates against whatever key
    // was loaded, so it cannot catch this.
    if (options.expectedPublicKey && options.expectedPublicKey !== publicKey.toBase58()) {
      throw new SignerError(
        `${keypairPath} derives ${publicKey.toBase58()}, expected ${options.expectedPublicKey}`,
      );
    }

    return {
      publicKey,
      // The address, not the path: it identifies the signer exactly and leaks
      // neither a filesystem layout nor a username into the executor log.
      signerId: publicKey.toBase58(),
      // No local verify here, unlike the KMS path: there is no remote party
      // that could return garbage, so checking Node's own output proves nothing.
      sign: async (message) => {
        const signature = signEd25519(null, message, privateKey);
        if (signature.length !== 64) throw new SignerError('signature was not 64 bytes');
        return signature;
      },
    };
  } finally {
    secret.fill(0);
  }
}

/**
 * Refuse a keyfile that anyone but the running user can read.
 *
 * ponytail: mode and ownership only. It does not detect an attacker who is
 * already root or who shares the service account — arm B does not defend
 * against those, and §5.5 says so rather than implying otherwise.
 */
function assertPrivateFile(keypairPath: string): void {
  const file = statSync(keypairPath);
  if (!file.isFile()) throw new SignerError(`${keypairPath} is not a regular file`);

  const mode = (file.mode & 0o777).toString(8).padStart(4, '0');
  if (file.mode & 0o077) {
    throw new SignerError(`${keypairPath} is group- or world-accessible (mode ${mode})`);
  }

  const uid = process.getuid?.();
  if (uid !== undefined && file.uid !== uid) {
    throw new SignerError(`${keypairPath} is owned by uid ${file.uid}, not the running uid ${uid}`);
  }

  const parent = dirname(keypairPath);
  if (statSync(parent).mode & 0o077) {
    throw new SignerError(`${parent} is group- or world-accessible; it must be 0700 or stricter`);
  }
}

/**
 * Parse a Solana CLI keypair file: a JSON array of 64 byte values.
 *
 * ponytail: the intermediate string cannot be zeroed — V8 holds it until GC.
 * The buffer and array are cleared, which is the reachable part. Real defence
 * against heap inspection is arm A, not a tighter read here.
 */
function readKeypairFile(keypairPath: string): Buffer {
  const contents = readFileSync(keypairPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new SignerError(`${keypairPath} is not valid JSON`);
  }

  if (!Array.isArray(parsed) || parsed.length !== SOLANA_KEYPAIR_BYTES) {
    throw new SignerError(
      `${keypairPath} must be a JSON array of ${SOLANA_KEYPAIR_BYTES} bytes (Solana keypair format)`,
    );
  }
  if (!parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new SignerError(`${keypairPath} contains values outside the byte range`);
  }

  const secret = Buffer.from(parsed as number[]);
  parsed.fill(0);
  return secret;
}
