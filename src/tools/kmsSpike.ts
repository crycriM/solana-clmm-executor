/**
 * KMS Ed25519 signer compatibility spike (test plan §5.1, delivery step 2).
 *
 * Runs the seven checks the test plan requires before the KMS signer may be
 * used for Meteora tests, and writes a JSON evidence artifact to stdout.
 * Human progress goes to stderr so `... > evidence.json` stays clean.
 *
 *   KMS_KEY_ARN=arn:... SOLANA_RPC_URL=https://... npx tsx src/tools/kmsSpike.ts
 *
 * On-chain steps (dust self-transfer, legacy + versioned) are skipped unless
 * LIVE_WRITE_CONFIRM=yes, matching the test plan §10 live-write control.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createKmsSigner, type Signer } from '../signer.js';

type Status = 'pass' | 'fail' | 'skipped';

interface Step {
  name: string;
  status: Status;
  detail: Record<string, unknown>;
}

const steps: Step[] = [];

function record(name: string, status: Status, detail: Record<string, unknown> = {}): void {
  steps.push({ name, status, detail });
  process.stderr.write(`[${status.toUpperCase().padEnd(7)}] ${name} ${JSON.stringify(detail)}\n`);
}

/** Run a check, recording a failure rather than aborting the whole spike. */
async function step(name: string, run: () => Promise<Record<string, unknown>>): Promise<boolean> {
  try {
    record(name, 'pass', await run());
    return true;
  } catch (error) {
    record(name, 'fail', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Nearest-rank percentile over an unsorted sample, in ms. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var: ${key}`);
  return value;
}

/**
 * A 1-lamport self-transfer: the smallest transaction that still exercises a
 * real signature, fee payer, and blockhash. Costs only the 5000-lamport fee.
 */
function selfTransfer(wallet: PublicKey) {
  return SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 1 });
}

/** Sign, submit, and wait for `finalized` — the test plan's bar for the spike. */
async function submitAndFinalize(
  connection: Connection,
  raw: Buffer | Uint8Array,
): Promise<Record<string, unknown>> {
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'finalized',
  );
  if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
  const tx = await connection.getTransaction(signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  return { signature, slot: tx?.slot ?? null, fee_lamports: tx?.meta?.fee ?? null };
}

async function legacyTransfer(connection: Connection, signer: Signer) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const tx = new Transaction({
    feePayer: signer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(selfTransfer(signer.publicKey));

  tx.addSignature(signer.publicKey, await signer.sign(tx.serializeMessage()));
  // serialize() re-verifies every signature against the message; a bad
  // encoding fails here rather than at the RPC.
  const raw = tx.serialize();
  return { format: 'legacy', ...(await submitAndFinalize(connection, raw)) };
}

async function versionedTransfer(connection: Connection, signer: Signer) {
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [selfTransfer(signer.publicKey)],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.addSignature(signer.publicKey, await signer.sign(tx.message.serialize()));
  return { format: 'v0', ...(await submitAndFinalize(connection, tx.serialize())) };
}

async function main(): Promise<number> {
  const keyArn = required('KMS_KEY_ARN');
  const rpcUrl = required('SOLANA_RPC_URL');
  const liveWrites = process.env['LIVE_WRITE_CONFIRM'] === 'yes';
  const sampleCount = Number(process.env['SPIKE_LATENCY_SAMPLES'] ?? 20);
  const connection = new Connection(rpcUrl, 'confirmed');

  let signer: Signer | undefined;

  await step('derive_address_from_get_public_key', async () => {
    signer = await createKmsSigner(keyArn);
    return { address: signer.publicKey.toBase58() };
  });

  if (!signer) {
    process.stderr.write('cannot continue without a signer\n');
    return 1;
  }
  const wallet = signer.publicKey;

  await step('sign_and_verify_fixed_message', async () => {
    // Fixed vector: the same bytes every run, so a signature change across
    // runs means the key changed, not the input.
    const message = Buffer.from('solana-clmm-executor kms spike v1', 'utf8');
    const signature = await signer!.sign(message);
    return { message_hex: message.toString('hex'), signature_base64: signature.toString('base64') };
  });

  await step('measure_sign_latency', async () => {
    const message = Buffer.alloc(256, 0x5a);
    const samples: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const started = performance.now();
      await signer!.sign(message);
      samples.push(performance.now() - started);
    }
    const round = (value: number) => Math.round(value * 10) / 10;
    return {
      samples: samples.length,
      p50_ms: round(percentile(samples, 50)),
      p95_ms: round(percentile(samples, 95)),
      p99_ms: round(percentile(samples, 99)),
    };
  });

  await step('denied_key_fails_closed', async () => {
    // A syntactically valid ARN this role has no grant on: the signer must
    // refuse at construction, not fall back to some other credential.
    const bogus = `${keyArn.split('/')[0]}/00000000-0000-0000-0000-000000000000`;
    try {
      await createKmsSigner(bogus);
    } catch (error) {
      return { rejected_with: error instanceof Error ? error.name : 'unknown' };
    }
    throw new Error('a key ARN outside the grant was accepted');
  });

  const balance = await connection.getBalance(wallet, 'finalized');
  const fundedEnough = balance >= 20_000;

  if (!liveWrites || !fundedEnough) {
    const reason = !liveWrites ? 'LIVE_WRITE_CONFIRM is not "yes"' : `balance ${balance} lamports`;
    for (const name of ['legacy_transaction_finalized', 'versioned_transaction_finalized']) {
      record(name, 'skipped', { reason, wallet: wallet.toBase58(), balance_lamports: balance });
    }
  } else {
    process.stderr.write(`signing live dust transfers from ${wallet.toBase58()}\n`);
    await step('legacy_transaction_finalized', () => legacyTransfer(connection, signer!));
    await step('versioned_transaction_finalized', () => versionedTransfer(connection, signer!));
  }

  const failed = steps.filter((s) => s.status === 'fail');
  const artifact = {
    spike: 'kms-ed25519-signer',
    test_plan_section: '5.1',
    run_at: new Date().toISOString(),
    key_arn: keyArn,
    wallet: wallet.toBase58(),
    rpc_genesis_hash: await connection.getGenesisHash(),
    balance_lamports: balance,
    live_writes: liveWrites,
    gate: failed.length === 0 ? 'pass' : 'fail',
    steps,
  };
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`spike aborted: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  },
);
