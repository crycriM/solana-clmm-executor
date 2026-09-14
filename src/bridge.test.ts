import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runBridge, UnrecoverableError } from './bridge.js';
import { loadConfig } from './config.js';
import { createStubHandlers, STUB_QUOTE_MINT } from './handlers.js';
import type { ExecHandlers, ExecRequest, ExecResponse, Verb } from './protocol.js';
import type { VerbLine } from './log.js';
import { baseEnv } from './testing.js';

const requests = JSON.parse(
  fs.readFileSync(new URL('../fixtures/requests.json', import.meta.url), 'utf8'),
) as Record<Verb, ExecRequest>;
const verbs = Object.keys(requests) as Verb[];
const config = loadConfig(baseEnv({ DRY_RUN: 'true' }));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(verb: Verb, result: 'ok' | 'error'): ExecResponse {
  return JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/responses/${verb}.${result}.json`, import.meta.url),
      'utf8',
    ),
  ) as ExecResponse;
}

async function exchange(lines: unknown[], handlers = createStubHandlers(), failLog = false) {
  let stdout = '';
  const records: VerbLine[] = [];
  const errors: string[] = [];
  const code = await runBridge({
    config,
    handlers,
    input: Readable.from([
      lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') +
        '\n',
    ]),
    output: new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    }),
    log: {
      write(line) {
        if (failLog) throw new Error('disk failure');
        records.push(line as VerbLine);
      },
    },
    reportError: (error) => {
      errors.push(error);
    },
  });
  return {
    code,
    records,
    errors,
    responses: stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExecResponse),
  };
}

describe('shared wire fixtures', () => {
  it.each(verbs)('%s success matches the canonical envelope', async (verb) => {
    const { responses, records } = await exchange([requests[verb]]);
    expect(responses).toHaveLength(1);
    const data = responses[0].data as Record<string, unknown>;
    expect(data.stub).toBe(true);
    delete data.stub;
    expect(responses[0]).toEqual(fixture(verb, 'ok'));
    expect(records[0]).toMatchObject({ req_seq: 1, method: verb, policy_decision: 'stub' });
  });

  it.each(verbs)('%s invalid request matches the canonical error', async (verb) => {
    const request = { ...requests[verb] } as Record<string, unknown>;
    const field = {
      get_state: 'pool',
      get_position: 'position_id',
      deposit_single_sided: 'pool',
      withdraw: 'position_id',
      swap: 'in_mint',
      refresh_bundle: 'withdraw_position_id',
    }[verb];
    delete request[field];
    const { responses } = await exchange([request]);
    expect(responses[0]).toEqual(fixture(verb, 'error'));
  });
});

describe('stdio loop', () => {
  it('awaits slow handlers and drains queued input after EOF in request order', async () => {
    const handlers = createStubHandlers();
    const original = handlers.get_position;
    let active = 0;
    handlers.get_position = async (req) => {
      expect(active++).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, req.position_id === 'slow' ? 15 : 1));
      const response = await original(req);
      active--;
      return response;
    };
    const { code, responses, records } = await exchange(
      ['slow', 'fast', 'last'].map((position_id) => ({ method: 'get_position', position_id })),
      handlers,
    );
    expect(code).toBe(0);
    expect(responses.map((r) => (r.data as { position_id: string }).position_id)).toEqual([
      'slow',
      'fast',
      'last',
    ]);
    expect(records.map((r) => r.req_seq)).toEqual([1, 2, 3]);
  });

  it.each([
    '{',
    '',
    'null',
    '[]',
    '42',
    '{"method":"unknown"}',
    '{"method":"get_state","pool":42}',
  ])('recovers after invalid line %s', async (line) => {
    const { code, responses } = await exchange([line, requests.get_state]);
    expect(code).toBe(0);
    expect(responses.map((r) => r.ok)).toEqual([false, true]);
    expect(responses[0].error).toBe('bad_request');
  });

  it.each([
    { ...requests.deposit_single_sided, amounts: [] },
    { ...requests.deposit_single_sided, side: 'both' },
    { ...requests.deposit_single_sided, bin_ids: [98.1, 99] },
    { ...requests.swap, in_mint: 'base' },
    { ...requests.swap, amount: -1 },
    { ...requests.swap, max_slippage_bps: 10001 },
    { ...requests.refresh_bundle, deposit_spec: null },
    { ...requests.refresh_bundle, swap_spec: {} },
    '{"method":"swap","amount":1e999}',
  ])('rejects malformed verb fields', async (request) => {
    const { responses } = await exchange([request]);
    expect(responses[0].error).toBe('bad_request');
  });

  it('contains handler throws in both response and audit record, then continues', async () => {
    const handlers = createStubHandlers();
    handlers.get_state = async () => {
      throw new Error('secret transaction bytes');
    };
    const result = await exchange([requests.get_state, requests.get_position], handlers);
    expect(result.responses.map((r) => r.ok)).toEqual([false, true]);
    expect(result.records[0].response).toEqual(result.responses[0]);
    expect(result.errors).toEqual(['Handler failed']);
    expect(JSON.stringify(result)).not.toContain('secret transaction bytes');
  });

  it('converts a non-JSON handler return into a recoverable error', async () => {
    const handlers = createStubHandlers();
    handlers.get_state = async () => ({ ok: true, data: { raw: 1n } }) as never;
    const { responses } = await exchange([requests.get_state, requests.get_position], handlers);
    expect(responses.map((r) => r.ok)).toEqual([false, true]);
    expect(responses[0].error).toBe('internal_error');
  });

  it('emits one failure and stops accepting queued work after a fatal error', async () => {
    const handlers = createStubHandlers();
    handlers.get_state = async () => {
      throw new UnrecoverableError('invalid state');
    };
    const { code, responses } = await exchange(
      [requests.get_state, requests.get_position],
      handlers,
    );
    expect(code).toBe(1);
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toBe('internal_error');
  });

  it('does not report success if the audit log cannot be written', async () => {
    const { code, responses } = await exchange(
      [requests.swap, requests.get_state],
      createStubHandlers(),
      true,
    );
    expect(code).toBe(1);
    expect(responses).toEqual([
      {
        ok: false,
        error: 'internal_error',
        data: { detail: 'Executor audit log unavailable' },
        tx_signatures: [],
        transactions: [],
      },
    ]);
  });

  it('forwards partial execution receipts and stage without retrying', async () => {
    const handlers = createStubHandlers();
    const withdrawal = await handlers.withdraw({
      method: 'withdraw',
      position_id: 'position',
      bps: 100,
    });
    const response: Awaited<ReturnType<ExecHandlers['refresh_bundle']>> = {
      ...withdrawal,
      ok: false,
      error: 'simulation_failed',
      data: { stage: 'withdrew', position_id: null },
    };
    handlers.refresh_bundle = async () => response;
    const { responses, records } = await exchange([requests.refresh_bundle], handlers);
    expect(responses[0]).toEqual(response);
    expect(records).toHaveLength(1);
  });
});

describe('compiled bridge with the offline fixture entrypoint', () => {
  function cli(input: string, overrides: NodeJS.ProcessEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-cli-'));
    dirs.push(dir);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/stub-runner.mjs', import.meta.url))],
      {
        input,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          ...baseEnv({ DRY_RUN: 'true', EXECUTOR_LOG_DIR: dir, ...overrides }),
        },
      },
    );
    return { ...result, dir };
  }

  it('starts the audit ledger before requests and keeps stdout exclusively JSON responses', () => {
    const result = cli(verbs.map((v) => JSON.stringify(requests[v])).join('\n'));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(6);
    for (const line of result.stdout.trim().split('\n'))
      expect(JSON.parse(line).data.stub).toBe(true);
    const files = fs.readdirSync(result.dir).filter((file) => file.endsWith('.jsonl'));
    const records = fs
      .readFileSync(path.join(result.dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      kind: 'executor_started',
      node_version: process.version,
      dlmm_sdk_version: '1.5.0',
      git_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
      wallet_pubkey: expect.any(String),
      policy_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      dry_run: true,
    });
    expect(records.slice(1).map((row) => row.req_seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([
    { DRY_RUN: 'false' },
    { SOLANA_RPC_URL: '' },
    { EXECUTOR_LOG_DIR: '/dev/null/unwritable' },
  ])('fails startup without a stray stdout envelope', (overrides) => {
    const result = cli(JSON.stringify(requests.get_state), overrides);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });

  it('production entrypoint wires M2 reads instead of silently selecting stubs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-m2-cli-'));
    dirs.push(dir);
    const request = { method: 'get_state', pool: STUB_QUOTE_MINT };
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/bridge.js', import.meta.url))],
      {
        input: JSON.stringify(request) + '\n',
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          ...baseEnv({
            DRY_RUN: 'true',
            EXECUTOR_LOG_DIR: dir,
            // Metadata warm-up must fail promptly without external DNS/RPC.
            SOLANA_RPC_URL: 'http://127.0.0.1:1',
            SOLANA_RPC_WRITE_URL: 'http://127.0.0.1:1',
          }),
        },
      },
    );
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout.trim()) as ExecResponse;
    expect(response).toMatchObject({ ok: false, error: 'bad_request' });
    const records = fs
      .readFileSync(
        path.join(dir, fs.readdirSync(dir).find((file) => file.endsWith('.jsonl'))!),
        'utf8',
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0].run_counter_note).toContain('M3: live reads');
    expect(records[1]).toMatchObject({ policy_decision: 'read_only' });
  });
});
