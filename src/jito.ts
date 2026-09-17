/**
 * Jito Block Engine submission client (plan T5.3 decision: raw JSON-RPC HTTP,
 * ~100 lines, no SDK dependency).
 *
 * A successful `sendBundle` means accepted by the Block Engine, never landed.
 * Landing is established separately through inflight/live status polling and
 * per-signature receipt lookups by the bundle orchestrator.
 */

import axios, { type AxiosRequestConfig } from 'axios';
import type { ExecutorConfig } from './config.js';

export class JitoError extends Error {}

export type JitoInflightState = 'pending' | 'landed' | 'rejected' | 'expired' | 'invalid' | string;

export interface JitoInflightStatus {
  bundleId: string;
  status: JitoInflightState;
  slot: number | null;
  error: unknown;
}

export interface JitoBundleStatus {
  bundleId: string;
  slot: number | null;
  /** Per-transaction errors as reported by the Block Engine; null = clean. */
  err: unknown;
}

export interface JitoRpcRequest {
  (body: { method: string; params: unknown[] }): Promise<unknown>;
}

export interface JitoClient {
  /** Ordered base58-encoded signed transactions; returns the bundle id. */
  sendBundle(transactions: string[]): Promise<string>;
  inflightStatuses(bundleIds: string[]): Promise<JitoInflightStatus[]>;
  bundleStatuses(bundleIds: string[]): Promise<JitoBundleStatus[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrap(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new JitoError('Jito RPC response is not an object');
  if (result.error !== undefined && result.error !== null) {
    const message = isRecord(result.error) && typeof result.error.message === 'string'
      ? `: ${result.error.message.slice(0, 200)}` : '';
    throw new JitoError(`Jito RPC returned an error${message}`);
  }
  if (!isRecord(result.result)) {
    // Public API envelope only; keeps ambiguous-send diagnosis possible
    // without a second reproduction.
    const shape = JSON.stringify(result).slice(0, 200);
    throw new JitoError(`Jito RPC result is missing: ${shape}`);
  }
  return result.result;
}

function slotOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function createJitoClient(
  config: ExecutorConfig,
  request: JitoRpcRequest = async (body) => {
    if (!config.jitoBlockEngineUrl) throw new JitoError('Jito block engine URL is not configured');
    const axiosConfig: AxiosRequestConfig = {
      method: 'post',
      url: config.jitoBlockEngineUrl,
      data: { jsonrpc: '2.0', id: 1, ...body },
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    };
    return (await axios(axiosConfig)).data;
  },
): JitoClient {
  return {
    async sendBundle(transactions) {
      if (transactions.length === 0 || transactions.length > 5) {
        // Plan T5.3: at most five transactions; never split across bundles while
        // claiming end-to-end atomicity.
        throw new JitoError('a Jito bundle must contain between one and five transactions');
      }
      let result: unknown;
      try {
        result = await request({ method: 'sendBundle', params: [transactions] });
      } catch (error) {
        if (error instanceof JitoError) throw error;
        const detail = error instanceof Error && error.message
          ? `: ${error.message.slice(0, 200)}` : '';
        throw new JitoError(`Jito sendBundle request failed${detail}`);
      }
      // The Block Engine returns the bundle id both as a bare string result
      // (observed mainnet) and as {bundle_id} (documented); accept either.
      if (!isRecord(result)) throw new JitoError('Jito RPC response is not an object');
      if (result.error !== undefined && result.error !== null) {
        const message = isRecord(result.error) && typeof result.error.message === 'string'
          ? `: ${result.error.message.slice(0, 200)}` : '';
        throw new JitoError(`Jito RPC returned an error${message}`);
      }
      const inner = result.result;
      const bundleId = typeof inner === 'string' ? inner
        : isRecord(inner) && typeof inner.bundle_id === 'string' ? inner.bundle_id : undefined;
      if (typeof bundleId !== 'string' || bundleId.length === 0) {
        throw new JitoError('Jito sendBundle response omitted the bundle id');
      }
      return bundleId;
    },
    async inflightStatuses(bundleIds) {
      let result: unknown;
      try {
        result = await request({ method: 'getInflightBundleStatuses', params: [bundleIds] });
      } catch (error) {
        if (error instanceof JitoError) throw error;
        const detail = error instanceof Error && error.message
          ? `: ${error.message.slice(0, 200)}` : '';
        throw new JitoError(`Jito inflight status request failed${detail}`);
      }
      const payload = unwrap(result);
      // Observed mainnet shape: { context, value: [{bundle_id, status,
      // landed_slot}] } with capitalized statuses; the map shape
      // { <bundle_id>: {...} } is also accepted.
      let byId: Record<string, unknown>;
      if (Array.isArray(payload.value)) {
        byId = {};
        for (const row of payload.value) {
          if (isRecord(row) && typeof row.bundle_id === 'string') byId[row.bundle_id] = row;
        }
      } else {
        byId = isRecord(payload.result) ? payload.result : payload;
      }
      return bundleIds.map((bundleId) => {
        const entry = byId[bundleId];
        if (!isRecord(entry)) {
          return { bundleId, status: 'pending', slot: null, error: null };
        }
        return {
          bundleId,
          status: typeof entry.status === 'string' ? entry.status.toLowerCase() : 'pending',
          slot: slotOf(entry.landed_slot ?? entry.slot),
          error: entry.error ?? null,
        };
      });
    },
    async bundleStatuses(bundleIds) {
      let result: unknown;
      try {
        result = await request({ method: 'getBundleStatuses', params: [bundleIds] });
      } catch (error) {
        if (error instanceof JitoError) throw error;
        const detail = error instanceof Error && error.message
          ? `: ${error.message.slice(0, 200)}` : '';
        throw new JitoError(`Jito bundle status request failed${detail}`);
      }
      const payload = unwrap(result);
      const values = Array.isArray(payload.value) ? payload.value : [];
      return values.filter(isRecord).map((entry) => ({
        bundleId: typeof entry.bundle_id === 'string' ? entry.bundle_id : '',
        slot: slotOf(entry.slot),
        err: entry.err ?? null,
      }));
    },
  };
}
