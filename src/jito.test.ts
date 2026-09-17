import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { JitoError, createJitoClient, type JitoRpcRequest } from './jito.js';
import { baseEnv } from './testing.js';

const config = loadConfig(baseEnv({
  JITO_ENABLED: 'true',
  JITO_BLOCK_ENGINE_URL: 'https://bundles.jito.test',
  JITO_TIP_ACCOUNT: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  JITO_TIP_LAMPORTS: '100',
}));

function client(handler: (body: { method: string; params: unknown[] }) => unknown) {
  const bodies: { method: string; params: unknown[] }[] = [];
  const request: JitoRpcRequest = async (body) => {
    bodies.push(body);
    return handler(body);
  };
  return { jito: createJitoClient(config, request), bodies };
}

describe('createJitoClient', () => {
  it('sends base58 transactions and returns the bundle id', async () => {
    const { jito, bodies } = client(() => ({
      jsonrpc: '2.0', id: 1, result: { bundle_id: 'bundle-abc' },
    }));
    const id = await jito.sendBundle(['tx1', 'tx2']);
    expect(id).toBe('bundle-abc');
    expect(bodies[0]).toEqual({ method: 'sendBundle', params: [['tx1', 'tx2']] });
  });

  it('accepts the bare-string bundle id observed from the mainnet Block Engine', async () => {
    const { jito } = client(() => ({
      jsonrpc: '2.0', id: 1, result: '803bc1a99ae180e0bf670c1914dcf0444c22897bee7cc9d7a68bb35965c14f81',
    }));
    expect(await jito.sendBundle(['tx1'])).toBe(
      '803bc1a99ae180e0bf670c1914dcf0444c22897bee7cc9d7a68bb35965c14f81',
    );
  });

  it('enforces the one-to-five transaction cap without calling the network', async () => {
    const { jito, bodies } = client(() => ({}));
    await expect(jito.sendBundle([])).rejects.toBeInstanceOf(JitoError);
    await expect(jito.sendBundle(['a', 'b', 'c', 'd', 'e', 'f'])).rejects.toBeInstanceOf(JitoError);
    expect(bodies).toHaveLength(0);
  });

  it('parses nested inflight statuses and defaults unseen bundles to pending', async () => {
    const { jito } = client((body) => body.method === 'getInflightBundleStatuses'
      ? {
        result: {
          result: {
            'bundle-abc': { status: 'landed', slot: 42, error: null },
          },
        },
      }
      : { result: {} });
    const statuses = await jito.inflightStatuses(['bundle-abc', 'bundle-xyz']);
    expect(statuses).toEqual([
      { bundleId: 'bundle-abc', status: 'landed', slot: 42, error: null },
      { bundleId: 'bundle-xyz', status: 'pending', slot: null, error: null },
    ]);
  });

  it('parses the array inflight rows with capitalized statuses seen on mainnet', async () => {
    const { jito } = client(() => ({
      result: {
        context: { slot: 447560078 },
        value: [
          { bundle_id: 'bundle-abc', status: 'Landed', landed_slot: 447560070 },
          { bundle_id: 'bundle-def', status: 'Invalid', landed_slot: null },
        ],
      },
    }));
    const statuses = await jito.inflightStatuses(['bundle-abc', 'bundle-def', 'bundle-miss']);
    expect(statuses).toEqual([
      { bundleId: 'bundle-abc', status: 'landed', slot: 447560070, error: null },
      { bundleId: 'bundle-def', status: 'invalid', slot: null, error: null },
      { bundleId: 'bundle-miss', status: 'pending', slot: null, error: null },
    ]);
  });

  it('parses bundle statuses', async () => {
    const { jito } = client(() => ({
      result: { value: [{ bundle_id: 'b', slot: 7, err: { InstructionError: [0, 'Custom'] } }] },
    }));
    const statuses = await jito.bundleStatuses(['b']);
    expect(statuses).toEqual([{
      bundleId: 'b', slot: 7, err: { InstructionError: [0, 'Custom'] },
    }]);
  });

  it('maps RPC errors and transport failures to JitoError', async () => {
    const errored = client(() => ({ error: { code: -32000, message: 'rate limited' } }));
    await expect(errored.jito.sendBundle(['a'])).rejects.toBeInstanceOf(JitoError);
    const down = client(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(down.jito.sendBundle(['a'])).rejects.toThrow('sendBundle request failed');
    const malformed = client(() => ({ result: {} }));
    await expect(malformed.jito.sendBundle(['a'])).rejects.toThrow('omitted the bundle id');
  });
});
