import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ConfigValidationError, loadConfig, policyHash, type ExecutorConfig } from './config.js';
import { createStubHandlers, STUB_WALLET } from './handlers.js';
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
}

/** readline's async iterator queues lines while each request completes. */
export async function runBridge({
  config,
  handlers,
  log,
  input = process.stdin,
  output = process.stdout,
  reportError = logError,
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
      const entry: VerbLine = {
        kind: 'verb',
        req_seq: ++seq,
        method,
        received_at: received / 1000,
        responded_at: responded / 1000,
        duration_ms: responded - received,
        request,
        response: response as unknown as Json,
        attempt: 1,
        rpc_endpoint: null,
        blockhash: null,
        simulation_ok: null,
        policy_decision: 'stub',
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

/** Exported for offline keeper test injection; the CLI always uses M1 stubs. */
export async function main(handlers: ExecHandlers = createStubHandlers()): Promise<number> {
  let log: ExecutorLog | undefined;
  try {
    const config = loadConfig();
    if (!config.dryRun) throw new ConfigValidationError('M1 stub executor requires DRY_RUN=true');
    log = new ExecutorLog(config, newRunId());
    initLogger(config.executorLogDir);
    const require = createRequire(import.meta.url);
    const sdk = require('@meteora-ag/dlmm/package.json') as { version: string };
    log.write({
      kind: 'executor_started',
      ts: Date.now() / 1000,
      node_version: process.version,
      dlmm_sdk_version: sdk.version,
      git_sha: gitSha(),
      rpc_read_url: config.rpcReadUrl,
      rpc_write_url: config.rpcWriteUrl,
      wallet_pubkey: STUB_WALLET,
      policy_hash: policyHash(config),
      dry_run: true,
      run_counter_note: 'M1 stub: synthetic wallet and receipts; no RPC, simulation, or signing',
    });
    return await runBridge({ config, handlers, log });
  } catch (error) {
    logError(error instanceof ConfigValidationError ? error.message : 'Executor failed');
    return 1;
  } finally {
    log?.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
