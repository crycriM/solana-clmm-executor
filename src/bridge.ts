import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ConfigValidationError, loadConfig, policyHash, type ExecutorConfig } from './config.js';
import { createReadHandlers, STUB_WALLET } from './handlers.js';
import {
  ExecutorLog,
  initLogger,
  logError,
  newRunId,
  redact,
  type Json,
  type VerbLine,
} from './log.js';
import { errorResponse, type ExecHandlers, type ExecResponse } from './protocol.js';
import { BadRequest, dispatch, parseRequest } from './requests.js';
import { MeteoraReads } from './meteora.js';
import { JsonlWriter } from './jsonl.js';
import { SwapStream } from './swapStream.js';
import { getSolanaConnection } from './vendor/lp-monitor/solana.js';
import { PublicKey } from '@solana/web3.js';

/** Handlers can mark state unusable; the caller gets an error before exit. */
export class UnrecoverableError extends Error {}

function writeResponse(output: Writable, response: ExecResponse): Promise<void> {
  const line = JSON.stringify(redact(response as unknown as Json)) + '\n';
  return new Promise((resolve, reject) => {
    output.write(line, (error) => (error ? reject(error) : resolve()));
  });
}

export interface BridgeOptions {
  config: ExecutorConfig;
  handlers: ExecHandlers;
  log: Pick<ExecutorLog, 'write'>;
  input?: Readable;
  output?: Writable;
  reportError?: (detail: string) => void;
  handlerMode?: 'stub' | 'm2';
  readAuditContext?: () => { attempt: number; rpcEndpoint: string | null };
  /**
   * Swap stream lifecycle. `start` is awaited after `executor_started`;
   * `stop` runs in the finally block. Injected so tests never open a socket.
   */
  swapStream?: SwapStreamLifecycle;
}

/** The two lifecycle hooks the bridge needs; `SwapStream` satisfies this. */
export interface SwapStreamLifecycle {
  start(): void;
  close(): void | Promise<void>;
}

/** readline's async iterator queues lines while each request completes. */
export async function runBridge({
  config,
  handlers,
  log,
  input = process.stdin,
  output = process.stdout,
  reportError = logError,
  handlerMode = 'stub',
  readAuditContext,
  swapStream,
}: BridgeOptions): Promise<number> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let seq = 0;
  try {
    for await (const line of lines) {
      const received = Date.now();
      let request: Json = '[invalid JSON]';
      let method = 'invalid';
      let response: ExecResponse;
      let fatal = false;
      let handlerRan = false;
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new BadRequest('Invalid JSON request');
        }
        request = parsed as Json;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'method' in parsed &&
          typeof parsed.method === 'string' &&
          Object.hasOwn(handlers, parsed.method)
        ) {
          method = parsed.method;
        }
        const req = parseRequest(parsed, config.mintAllowlist);
        method = req.method;
        handlerRan = true;
        // Serialize inside the handler boundary so a malformed return value
        // (e.g. BigInt) still yields a failure response and leaves the loop usable.
        response = JSON.parse(
          JSON.stringify(redact((await dispatch(handlers, req)) as unknown as Json)),
        ) as ExecResponse;
      } catch (error) {
        if (error instanceof BadRequest) response = errorResponse('bad_request', error.message);
        else {
          fatal = error instanceof UnrecoverableError;
          response = errorResponse(
            'internal_error',
            fatal ? 'Executor state is unusable' : 'Handler failed',
          );
          // Exception text can contain keys, serialized transactions, or envs.
          reportError(fatal ? 'Executor state is unusable' : 'Handler failed');
        }
      }
      const responded = Date.now();
      const readAudit =
        handlerRan &&
        handlerMode === 'm2' &&
        (method === 'get_state' || method === 'get_position')
          ? readAuditContext?.()
          : undefined;
      const entry: VerbLine = {
        kind: 'verb',
        req_seq: ++seq,
        method,
        received_at: received / 1000,
        responded_at: responded / 1000,
        duration_ms: responded - received,
        request,
        response: response as unknown as Json,
        attempt: readAudit?.attempt ?? 1,
        rpc_endpoint:
          handlerRan &&
          handlerMode === 'm2' &&
          (method === 'get_state' || method === 'get_position')
            ? (readAudit?.rpcEndpoint ?? config.rpcReadUrl)
            : null,
        blockhash: null,
        simulation_ok: null,
        policy_decision:
          handlerMode === 'm2'
            ? handlerRan && (method === 'get_state' || method === 'get_position')
              ? 'read_only'
              : handlerRan
                ? 'stub'
                : null
            : 'stub',
        signer_id: null,
        bundle_id: null,
      };
      try {
        log.write(entry);
      } catch {
        response = errorResponse('internal_error', 'Executor audit log unavailable');
        fatal = true;
        reportError('Executor audit log unavailable');
      }
      await writeResponse(output, response);
      if (fatal) return 1;
    }
    return 0;
  } finally {
    await swapStream?.close();
    lines.close();
    input.destroy();
  }
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Exported for offline fixture injection; the production CLI wires M2 reads. */
export async function main(injectedHandlers?: ExecHandlers): Promise<number> {
  let log: ExecutorLog | undefined;
  try {
    const config = loadConfig();
    if (!config.dryRun) throw new ConfigValidationError('M2 executor requires DRY_RUN=true');
    if (!injectedHandlers && !config.walletPubkey) {
      throw new ConfigValidationError('M2 live reads require WALLET_PUBKEY');
    }
    log = new ExecutorLog(config, newRunId());
    initLogger(config.executorLogDir);
    const require = createRequire(import.meta.url);
    const sdk = require('@meteora-ag/dlmm/package.json') as { version: string };
    const wallet = injectedHandlers ? new PublicKey(STUB_WALLET) : new PublicKey(config.walletPubkey!);
    const reads = injectedHandlers
      ? undefined
      : new MeteoraReads(config, wallet, {
          audit: (line) => log!.write(line),
        });
    const handlers = injectedHandlers ?? createReadHandlers(reads!);
    log.write({
      kind: 'executor_started',
      ts: Date.now() / 1000,
      node_version: process.version,
      dlmm_sdk_version: sdk.version,
      git_sha: gitSha(),
      rpc_read_url: config.rpcReadUrl,
      rpc_write_url: config.rpcWriteUrl,
      rpc_ws_url: config.rpcWsUrl,
      rpc_max_cu_per_second: config.rpcMaxCuPerSecond,
      pool_allowlist: config.poolAllowlist,
      mint_allowlist: config.mintAllowlist,
      wallet_pubkey: wallet.toBase58(),
      policy_hash: policyHash(config),
      dry_run: true,
      run_counter_note: injectedHandlers
        ? 'test fixture: injected handlers; no RPC, simulation, or signing'
        : 'M3: live reads + decoded swap stream; write verbs remain gated; no signer loaded',
    });
    const stream = injectedHandlers
      ? undefined
      : await startSwapStream(config, reads!, log);
    return await runBridge({
      config,
      handlers,
      log,
      handlerMode: injectedHandlers ? 'stub' : 'm2',
      readAuditContext: reads ? () => reads.auditContext() : undefined,
      ...(stream === undefined ? {} : { swapStream: stream }),
    });
  } catch (error) {
    logError(error instanceof ConfigValidationError ? error.message : 'Executor failed');
    return 1;
  } finally {
    log?.close();
  }
}

/**
 * Start the §6 swap stream for every allow-listed pool.
 *
 * Read-only and independent of signing, so it runs in M3 before any custody
 * exists. Startup failure is contained: a stream that cannot be built must not
 * take the verb loop down with it, but the failure is loud on stderr because a
 * run without this feed has no verified fills (spec §6 — "not an optional
 * phase"). The keeper's `verify_log.py` fails closed on the missing rows.
 */
async function startSwapStream(
  config: ExecutorConfig,
  reads: MeteoraReads,
  log: ExecutorLog,
): Promise<SwapStreamLifecycle | undefined> {
  let writer: JsonlWriter | undefined;
  try {
    // Exact decimal scaling is part of the emitted contract. Warm immutable
    // metadata before subscribing so an early swap is never treated as if
    // both tokens had zero decimals.
    await Promise.all(config.poolAllowlist.map((pool) => reads.ensurePoolDecimals(pool)));
    writer = new JsonlWriter(config.swapStreamPath);
    const stream = new SwapStream({
      connection: getSolanaConnection(config),
      writer,
      log: { write: (line) => log.write(line) },
      pools: config.poolAllowlist,
      commitment: config.commitment,
      decimals: (pool) => reads.poolDecimals(pool),
      reportError: (detail) => logError(`swap stream unavailable: ${detail}`),
    });
    stream.start();
    return stream;
  } catch (error) {
    writer?.close();
    logError(
      `swap stream unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return undefined;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await main();
  // Explicit exit, not just `exitCode`: the swap stream's RPC websocket holds
  // timers and socket handles that `close()` can only ask the client to drop.
  // A subprocess whose lifetime is the keeper's must terminate when stdin
  // closes, or `ExecBridge.start()` never sees the restart it relies on
  // (spec §2). Everything is already flushed — the audit ledger is closed and
  // every response written — so exiting here loses nothing.
  process.exit(code);
}
