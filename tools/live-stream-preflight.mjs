#!/usr/bin/env node
/** Read-only stream check before a live LP run can sign. */
import { Connection, PublicKey } from '@solana/web3.js';
import { RpcCuRateLimiter, rateLimitedFetch } from '../dist/rpcRateLimit.js';

async function subscriptionAccepted(url, pool) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Connection may not have opened. */ }
      if (error) reject(new Error(error));
      else resolve();
    };
    const timer = setTimeout(() => finish('stream websocket subscription timed out'), 10_000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [pool] }, { commitment: 'finalized' }],
    })));
    socket.addEventListener('message', (event) => {
      let response;
      try { response = JSON.parse(event.data); } catch { return; }
      if (response.id !== 1) return;
      finish(typeof response.result === 'number' && !response.error
        ? null : 'stream websocket subscription rejected');
    });
    socket.addEventListener('error', () => finish('stream websocket connection failed'));
    socket.addEventListener('close', () => finish('stream websocket closed before subscription'));
  });
}

async function main() {
  const pool = new PublicKey(process.argv[2]);
  const http = process.env.SOLANA_STREAM_RPC_URL || process.env.SOLANA_RPC_URL;
  const ws = process.env.SOLANA_STREAM_WS_URL ||
    (process.env.SOLANA_STREAM_RPC_URL ? null : process.env.SOLANA_WS_URL);
  if (!http || !ws) throw new Error('stream HTTP and websocket endpoints are required');
  const connection = new Connection(http, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: rateLimitedFetch(new RpcCuRateLimiter(40)),
  });
  try {
    const [latest] = await connection.getSignaturesForAddress(pool, { limit: 1 });
    if (!latest || !await connection.getParsedTransaction(latest.signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 1,
    })) throw new Error('missing transaction');
  } catch {
    throw new Error('stream HTTP history read failed');
  }
  await subscriptionAccepted(ws, pool.toBase58());
}

main().catch((error) => {
  const known = new Set([
    'stream HTTP and websocket endpoints are required',
    'stream HTTP history read failed',
    'stream websocket subscription timed out',
    'stream websocket subscription rejected',
    'stream websocket connection failed',
    'stream websocket closed before subscription',
  ]);
  console.error(known.has(error.message) ? error.message : 'swap stream preflight failed');
  process.exitCode = 1;
});
