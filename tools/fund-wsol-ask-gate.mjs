#!/usr/bin/env node
/**
 * M4 ask-side campaign funding: signed legacy self-transfer of native SOL to
 * the wallet's own wSOL ATA (auto-wrap + syncNative), doubling as the arm B
 * self-transfer validation. Reads the keypair path from
 * WALLET_KEYPAIR_PATH; never logs key material. Public output only.
 *
 * Runs through the executor's shared Alchemy CU limiter (dist build), so a
 * campaign tool cannot exceed the account budget the bridge subprocesses
 * already enforce. Rebuild after rate-limiter changes: `npm run build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  DEFAULT_RPC_MAX_CU_PER_SECOND, rateLimitedFetch, sharedRpcLimiter,
} from '../dist/rpcRateLimit.js';

const AMOUNT_SOL = Number(process.env['FUND_WRAP_SOL'] ?? '0.05');
if (!Number.isFinite(AMOUNT_SOL) || AMOUNT_SOL <= 0 || AMOUNT_SOL > 0.1) {
  throw new Error(`FUND_WRAP_SOL out of campaign range: ${process.env['FUND_WRAP_SOL']}`);
}
const keyPath = process.env['WALLET_KEYPAIR_PATH'];
const rpcUrl = process.env['SOLANA_RPC_URL'];
const pinned = process.env['WALLET_PUBKEY'];
if (!keyPath || !rpcUrl || !pinned) throw new Error('WALLET_KEYPAIR_PATH, SOLANA_RPC_URL, WALLET_PUBKEY required');

const keyStat = fs.statSync(keyPath);
if ((keyStat.mode & 0o077) !== 0) throw new Error('refusing over-permissive keyfile');
if (fs.statSync(path.dirname(keyPath)).mode & 0o077) throw new Error('refusing over-permissive keyfile directory');

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
if (keypair.publicKey.toBase58() !== pinned) {
  throw new Error('WALLET_PUBKEY pin does not match loaded keyfile; refusing to sign');
}
const maxCuPerSecond = Number(
  process.env['SOLANA_RPC_MAX_CU_PER_SECOND'] ?? DEFAULT_RPC_MAX_CU_PER_SECOND,
);
const connection = new Connection(rpcUrl, {
  commitment: 'confirmed',
  fetch: rateLimitedFetch(sharedRpcLimiter(rpcUrl, maxCuPerSecond)),
  // Alchemy 429s re-enter the shared bucket instead of web3.js's opaque loop.
  disableRetryOnRateLimit: true,
});
const genesisHash = await connection.getGenesisHash({ commitment: 'finalized' });
if (genesisHash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
  throw new Error(`unexpected genesis hash ${genesisHash}; this tool is mainnet-campaign only`);
}

const ata = getAssociatedTokenAddressSync(NATIVE_MINT, keypair.publicKey, false, TOKEN_PROGRAM_ID);
const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
tx.add(createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, ata, keypair.publicKey, NATIVE_MINT));
tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: ata, lamports }));
tx.add(createSyncNativeInstruction(ata));
const signature = await connection.sendTransaction(tx, [keypair], { skipPreflight: false });
for (;;) {
  const status = (await connection.getSignatureStatuses([signature])).value[0];
  if (status?.err) throw new Error(`funding transaction failed on chain: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === 'finalized') break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const account = await getAccount(connection, ata, 'finalized', TOKEN_PROGRAM_ID);
console.log(JSON.stringify({
  kind: 'm4_ask_funding_self_transfer',
  wallet: keypair.publicKey.toBase58(),
  signature,
  wrapped_sol: Number(account.amount) / LAMPORTS_PER_SOL,
  native_sol_remaining: (await connection.getBalance(keypair.publicKey, 'finalized')) / LAMPORTS_PER_SOL,
  transaction_format: 'legacy',
  commitment: 'finalized',
}));
