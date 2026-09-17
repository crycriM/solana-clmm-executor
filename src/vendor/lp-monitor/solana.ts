// Read-only Solana connection adapter. Endpoints come from executor
// configuration, with distinct read/write and explicit websocket settings.

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
  return new Connection(endpoint, {
    commitment,
    fetch,
    // All retries must reacquire the executor's CU budget and remain bounded
    // by withRetry; web3.js's internal 429 loop is opaque/unbounded.
    disableRetryOnRateLimit: true,
    // Confirmation uses signatureSubscribe on the write Connection. Providers
    // such as Alchemy expose Solana PubSub on a distinct streaming host, so the
    // explicit endpoint must apply to reads and writes alike.
    ...(config.rpcWsUrl === null ? {} : { wsEndpoint: config.rpcWsUrl }),
  });
}
