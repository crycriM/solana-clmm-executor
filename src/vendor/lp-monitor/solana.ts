// vendored from LP-hedging-strategy/lp-monitor/src/chains/solana.ts @ git aacfe017291681164a1a23b756f4516768699ad0
// co-maintained; strip = RPC endpoint read from lp-monitor config replaced by
// this project's config (read + distinct write endpoint, explicit websocket
// endpoint, commitment arg).
// Do not edit in place without noting the delta here.

import { Commitment, Connection } from '@solana/web3.js';
import { ExecutorConfig } from '../../config.js';
import { rateLimitedFetch, sharedRpcLimiter } from '../../rpcRateLimit.js';

export interface ConnectionOpts {
  commitment?: Commitment;
  /** true → the write endpoint (SOLANA_RPC_WRITE_URL), falls back to read. */
  write?: boolean;
}

export function getSolanaConnection(
  config: ExecutorConfig,
  opts: ConnectionOpts = {},
): Connection {
  const commitment: Commitment = opts.commitment ?? config.commitment;
  const endpoint = opts.write ? config.rpcWriteUrl : config.rpcReadUrl;
  const fetch = rateLimitedFetch(sharedRpcLimiter(endpoint, config.rpcMaxCuPerSecond));
  if (opts.write) {
    return new Connection(config.rpcWriteUrl, {
      commitment,
      fetch,
      // All retries must reacquire the executor's CU budget and remain
      // bounded by withRetry; web3.js's internal 429 loop is opaque/unbounded.
      disableRetryOnRateLimit: true,
    });
  }
  return new Connection(config.rpcReadUrl, {
    commitment,
    fetch,
    disableRetryOnRateLimit: true,
    ...(config.rpcWsUrl === null ? {} : { wsEndpoint: config.rpcWsUrl }),
  });
}
