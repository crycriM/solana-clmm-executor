#!/usr/bin/env node
/**
 * Diagnostic: does the mainnet Jito Block Engine accept a v0 bundle from this
 * wallet? One transaction: 1-lamport self system transfer plus the tip.
 * Sends, polls getInflightBundleStatuses, prints the public outcome. Never
 * logs key material. Used to isolate the Invalid-bundle cause (legacy vs v0).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';

const keyPath = process.env['WALLET_KEYPAIR_PATH'];
const pinned = process.env['WALLET_PUBKEY'];
const tipAccount = new PublicKey(process.env['JITO_TIP_ACCOUNT'] ?? '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
const tipLamports = Number(process.env['JITO_TIP_LAMPORTS'] ?? '200000');
if (!keyPath || !pinned) throw new Error('WALLET_KEYPAIR_PATH and WALLET_PUBKEY required');
if ((fs.statSync(keyPath).mode & 0o077) !== 0 || (fs.statSync(path.dirname(keyPath)).mode & 0o077) !== 0) {
  throw new Error('refusing over-permissive keyfile');
}
const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
if (keypair.publicKey.toBase58() !== pinned) throw new Error('pin mismatch');
const version = process.argv[2] ?? 'v0';

const connection = new Connection(process.env['SOLANA_RPC_URL'], 'confirmed');
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
const instructions = [
  SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: keypair.publicKey, lamports: 1 }),
  SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: tipAccount, lamports: tipLamports }),
];
let serialized;
if (version === 'v0') {
  const message = new TransactionMessage({
    payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  serialized = bs58.encode(Buffer.from(tx.serialize()));
} else {
  const { default: Transaction } = await import('@solana/web3.js').then((m) => ({ default: m.Transaction }));
  const tx = new Transaction({ feePayer: keypair.publicKey, lastValidBlockHeight });
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);
  tx.sign(keypair);
  serialized = bs58.encode(tx.serialize({ requireAllSignatures: false }));
}
const url = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const send = await axios.post(url, { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[serialized]] },
  { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
  .then((r) => r.data)
  .catch((e) => ({ httpError: e.response?.status ?? e.code, body: e.response?.data ?? String(e.message) }));
console.log(JSON.stringify({ version, send }));
const bundleId = typeof send?.result === 'string' ? send.result : send?.result?.bundle_id;
if (bundleId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await axios.post(url, {
      jsonrpc: '2.0', id: 1, method: 'getInflightBundleStatuses', params: [[bundleId]],
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
      .then((r) => r.data.result?.value?.[0] ?? r.data)
      .catch((e) => ({ error: String(e.message) }));
    console.log(JSON.stringify({ version, bundleId, status }));
    if (status?.status && status.status.toLowerCase() !== 'pending') break;
  }
}
