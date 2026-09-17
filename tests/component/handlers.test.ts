/** Component coverage for handler data surfaces over the compiled CLI. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DepositData, ExecResponse, PositionData, StateData, SwapData, WithdrawData } from '../../src/protocol.js';
import { requestsByVerb } from '../helpers/requests.js';
import { requireBuiltBridge, scratchEnv, StdioClient, type ScratchEnv } from '../helpers/stdioClient.js';

let scratch: ScratchEnv;
let client: StdioClient;

beforeAll(() => {
  requireBuiltBridge();
  scratch = scratchEnv();
  client = new StdioClient(requireBuiltBridge(), scratch.env);
  client.start();
});

afterAll(async () => {
  await client?.close();
  scratch?.dispose();
});

describe('handler read surfaces', () => {
  it('get_state returns decimal + raw balance pairs for the same tokens', async () => {
    const response = await client.request(requestsByVerb.get_state!);
    const data = response.data as StateData;
    expect(response.ok).toBe(true);
    expect(Number.isInteger(data.active_bin)).toBe(true);
    expect(data.balances_raw.base).toMatch(/^\d+$/);
    expect(data.balances_raw.quote).toMatch(/^\d+$/);
    expect(data.token_x.mint).not.toBe(data.token_y.mint);
  });

  it('get_position echoes the requested position and its bins', async () => {
    const response = await client.request({ method: 'get_position', position_id: 'readback-1' });
    const data = response.data as PositionData;
    expect(response.ok).toBe(true);
    expect(data.position_id).toBe('readback-1');
    expect(data.bins.length).toBeGreaterThan(0);
    expect(data.min_bin_id).toBeLessThanOrEqual(data.active_bin);
    expect(data.active_bin).toBeLessThanOrEqual(data.max_bin_id);
    for (const bin of data.bins) {
      expect(bin.amount_base_raw).toMatch(/^\d+$/);
      expect(bin.amount_quote_raw).toMatch(/^\d+$/);
    }
  });
});

describe('handler write surfaces', () => {
  it('deposit_single_sided echoes the requested bin ladder', async () => {
    const response = await client.request(requestsByVerb.deposit_single_sided!);
    const data = response.data as DepositData & { position_id: string };
    expect(response.ok).toBe(true);
    expect(data.position_id).toBeTruthy();
    const req = requestsByVerb.deposit_single_sided! as { bin_ids: number[]; amounts: number[] };
    expect(data.bins.map((b) => b.bin_id)).toEqual(req.bin_ids);
    expect(data.bins.map((b) => b.amount)).toEqual(req.amounts);
    expect(data.allocation_mode).toBe('weighted');
    expect(data.bins.map((b) => b.target_bps)).toEqual([5_000, 5_000]);
    expect(data.max_debit_amount).toBe(150);
  });

  it('withdraw at 100 bps closes the position and reports what came back', async () => {
    const response = await client.request({ method: 'withdraw', position_id: 'p-full', bps: 100 });
    const data = response.data as WithdrawData;
    expect(response.ok).toBe(true);
    expect(data.fraction).toBe(1);
    expect(data.closed).toBe(true);
    expect(data.amounts_returned.base_raw).toMatch(/^\d+$/);
  });

  it('withdraw below 100 bps leaves the position open', async () => {
    const response = await client.request({ method: 'withdraw', position_id: 'p-partial', bps: 50 });
    const data = response.data as WithdrawData;
    expect(data.fraction).toBe(0.5);
    expect(data.closed).toBe(false);
  });

  it('swap reports the direct pool route', async () => {
    const response = await client.request(requestsByVerb.swap!);
    const data = response.data as SwapData;
    expect(data.route).toBe('meteora');
    expect((<ExecResponse>response).transactions).toHaveLength(1);
  });
});

describe('refresh_bundle staging', () => {
  it('full bundle reports stage=deposited and a bundle receipt set', async () => {
    const response = await client.request(requestsByVerb.refresh_bundle!);
    const data = response.data as { stage: string; position_id: string | null };
    expect(response.ok).toBe(true);
    expect(data.stage).toBe('deposited');
    expect(data.position_id).toBeTruthy();
    // fixed withdraw + deposit receipts (no swap in this fixture's bundle)
    expect((<ExecResponse>response).transactions).toHaveLength(2);
  });

  it('a bundle without a swap has no swap stage in the data', async () => {
    const request = { ...requestsByVerb.refresh_bundle!, swap_spec: null };
    const response = await client.request(request);
    const data = response.data as { swap?: unknown; stage: string };
    expect(data.stage).toBe('deposited');
    expect(data.swap).toBeUndefined();
  });
});
