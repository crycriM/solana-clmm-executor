#!/usr/bin/env node
/**
 * M5 receipt-fidelity audit: for every
 * mutation receipt in the given live artifacts, re-fetch the transaction
 * independently over RPC and assert (a) transactions[i].signature equals
 * tx_signatures[i], (b) fee_lamports matches the on-chain meta.fee, and
 * (c) the reported status does not exceed the observed commitment.
 * Read-only: no signer, no writes.
 */
import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

const rpcUrl = process.env['SOLANA_RPC_URL'];
if (!rpcUrl) throw new Error('SOLANA_RPC_URL required');
const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: m5-receipt-audit.mjs <artifact.json>...');
const connection = new Connection(rpcUrl, 'confirmed');

const receipts = [];
for (const file of files) {
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  const runId = artifact.run_id ?? file;
  const seen = new Set();
  const collect = (response) => {
    if (!response || !Array.isArray(response.transactions)) return;
    for (const [index, tx] of response.transactions.entries()) {
      if (!tx?.signature || seen.has(tx.signature)) continue;
      seen.add(tx.signature);
      receipts.push({
        runId, signature: tx.signature, fee: tx.fee_lamports, status: tx.status,
        aligned: (response.tx_signatures ?? [])[index] === tx.signature,
      });
    }
  };
  for (const exchange of artifact.exchanges ?? []) collect(exchange.response);
  collect(artifact.response);
}

let mismatches = 0; let misaligned = 0; let fetched = 0; let sumReported = 0; let sumChain = 0;
for (const receipt of receipts) {
  if (!receipt.aligned) misaligned += 1;
  sumReported += receipt.fee ?? 0;
  let tx = null;
  for (let attempt = 0; attempt < 3 && tx === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    tx = await connection.getTransaction(receipt.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    }).catch(() => null);
  }
  if (tx === null) {
    mismatches += 1;
    console.log(JSON.stringify({ signature: receipt.signature, result: 'not_found' }));
    continue;
  }
  fetched += 1;
  sumChain += tx.meta.fee;
  const observed = tx.meta.err === null ? 'confirmed' : 'failed';
  const problems = [];
  if (tx.meta.fee !== receipt.fee) problems.push(`fee ${receipt.fee} != chain ${tx.meta.fee}`);
  if (receipt.status === 'finalized') {
    // getSignatureStatuses only covers a recent cache window; a finalized
    // claim is proven by the transaction being fetchable at finalized
    // commitment itself.
    const finalizedTx = await connection.getTransaction(receipt.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'finalized',
    }).catch(() => null);
    if (finalizedTx === null) problems.push('finalized claim, not fetchable at finalized commitment');
  } else if (receipt.status !== observed && !(receipt.status === 'confirmed' && observed === 'confirmed')) {
    problems.push(`status ${receipt.status} vs chain ${observed}`);
  }
  if (problems.length > 0) {
    mismatches += 1;
    console.log(JSON.stringify({ signature: receipt.signature.slice(0, 20), problems }));
  }
}
const report = {
  kind: 'm5_receipt_audit',
  receipts: receipts.length,
  fetched,
  signature_order_misalignments: misaligned,
  mismatches,
  sum_fee_lamports_reported: sumReported,
  sum_fee_lamports_chain: sumChain,
  result: misaligned === 0 && mismatches === 0 && fetched === receipts.length ? 'pass' : 'fail',
};
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'pass') process.exitCode = 1;
