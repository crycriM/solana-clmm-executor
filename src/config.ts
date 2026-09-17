/**
 * Environment parsing and startup validation.
 *
 * Fail closed: refuse to start when signer, RPC, or either allow-list is
 * missing. M1–M3 run with DRY_RUN=true; a dummy signer shape is permitted
 * only in dry-run.
 */

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { DEFAULT_RPC_MAX_CU_PER_SECOND } from './rpcRateLimit.js';

export type SignerKind = 'kms' | 'keypair' | 'file';

/** Jupiter v6 aggregator router (mainnet-beta); the swap-instructions API signs against it. */
export const DEFAULT_JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const DEFAULT_JUPITER_BASE_URL = 'https://lite-api.jup.ag/swap/v1';

/**
 * Canonical Jito mainnet-beta tip accounts (docs.jito.wtf). A configured tip
 * account must appear in this list unless the operator replaces the list for
 * another cluster — the executor never tips an address it was not told to.
 */
export const DEFAULT_JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export interface ExecutorConfig {
  rpcReadUrl: string;
  rpcWriteUrl: string;
  /** Optional explicit websocket endpoint; web3.js otherwise derives it. */
  rpcWsUrl: string | null;
  rpcMaxCuPerSecond: number;
  commitment: 'confirmed' | 'finalized';
  walletSigner: SignerKind;
  kmsKeyArn: string | null;
  walletSecretArn: string | null;
  /** WALLET_KEYPAIR_PATH (signer=file): path to a Solana CLI keypair JSON. */
  walletKeypairPath: string | null;
  /** WALLET_PUBKEY: optional expected address; mandatory pin target for file. */
  walletPubkey: string | null;
  /**
   * Arm B is deliberately local/devnet by default.  A mainnet file signer is
   * an explicit operational decision, never an accidental RPC URL change.
   */
  fileSignerAllowMainnet: boolean;
  poolAllowlist: string[];
  mintAllowlist: string[];
  maxSolPerTx: number;
  maxSolPerRun: number;
  maxSlippageBps: number;
  /** Deposit active-bin drift cap, in bins rather than basis points. */
  maxActiveBinSlippageBins: number;
  maxPriorityFeeLamports: number;
  jitoEnabled: boolean;
  jitoBlockEngineUrl: string | null;
  jitoTipLamports: number;
  /** Tip recipient pinned inside JITO_TIP_ACCOUNTS when Jito is enabled. */
  jitoTipAccount: string | null;
  /** Allow-listed Jito tip accounts for the connected cluster. */
  jitoTipAccounts: string[];
  /** Jupiter Swap API base used by the M5 `pool:null` route (T5.1 decision: raw HTTP). */
  jupiterBaseUrl: string;
  /** Top-level program IDs a Jupiter-built swap transaction may call. */
  jupiterProgramIds: string[];
  swapStreamPath: string;
  executorLogDir: string;
  dryRun: boolean;
}

export class ConfigValidationError extends Error {}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || value.trim() === '') {
    throw new ConfigValidationError(`missing required env var: ${key}`);
  }
  return value.trim();
}

function optional(env: Record<string, string | undefined>, key: string, fallback = ''): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function number(env: Record<string, string | undefined>, key: string): number {
  const raw = required(env, key);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigValidationError(`${key} must be a finite number`);
  }
  return parsed;
}

function int(env: Record<string, string | undefined>, key: string): number {
  const parsed = number(env, key);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigValidationError(`${key} must be a safe integer`);
  }
  return parsed;
}

function boolean(env: Record<string, string | undefined>, key: string): boolean {
  const value = optional(env, key, 'false');
  if (value !== 'true' && value !== 'false') {
    throw new ConfigValidationError(`${key} must be true|false`);
  }
  return value === 'true';
}

function httpUrl(value: string, key: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return;
  } catch {
    /* Report only the key: RPC URLs can contain credentials. */
  }
  throw new ConfigValidationError(`${key} must be an HTTP(S) URL`);
}

function wsUrl(value: string, key: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return;
  } catch {
    /* Report only the key: websocket URLs can contain credentials. */
  }
  throw new ConfigValidationError(`${key} must be a WS(S) URL`);
}

function allowlist(env: Record<string, string | undefined>, key: string): string[] {
  const values = [...new Set(splitList(required(env, key)))].sort();
  if (values.length === 0) throw new ConfigValidationError(`${key} must not be empty`);
  for (const value of values) {
    try {
      new PublicKey(value);
    } catch {
      throw new ConfigValidationError(`${key} must contain Solana public keys`);
    }
  }
  return values;
}

function poolDefaults(env: Record<string, string | undefined>): ExecutorConfig {
  return {
    rpcReadUrl: required(env, 'SOLANA_RPC_URL'),
    rpcWriteUrl: optional(env, 'SOLANA_RPC_WRITE_URL', required(env, 'SOLANA_RPC_URL')),
    rpcWsUrl: optional(env, 'SOLANA_WS_URL') || null,
    rpcMaxCuPerSecond: env['SOLANA_RPC_MAX_CU_PER_SECOND']
      ? number(env, 'SOLANA_RPC_MAX_CU_PER_SECOND')
      : DEFAULT_RPC_MAX_CU_PER_SECOND,
    commitment: optional(env, 'SOLANA_COMMITMENT', 'confirmed') as ExecutorConfig['commitment'],
    walletSigner: required(env, 'WALLET_SIGNER') as SignerKind,
    kmsKeyArn: optional(env, 'KMS_KEY_ARN') || null,
    walletSecretArn: optional(env, 'WALLET_SECRET_ARN') || null,
    walletKeypairPath: optional(env, 'WALLET_KEYPAIR_PATH') || null,
    walletPubkey: optional(env, 'WALLET_PUBKEY') || null,
    fileSignerAllowMainnet: boolean(env, 'FILE_SIGNER_ALLOW_MAINNET'),
    poolAllowlist: allowlist(env, 'POOL_ALLOWLIST'),
    mintAllowlist: allowlist(env, 'MINT_ALLOWLIST'),
    maxSolPerTx: number(env, 'MAX_SOL_PER_TX'),
    maxSolPerRun: number(env, 'MAX_SOL_PER_RUN'),
    maxSlippageBps: int(env, 'MAX_SLIPPAGE_BPS'),
    maxActiveBinSlippageBins: int(env, 'MAX_ACTIVE_BIN_SLIPPAGE_BINS'),
    maxPriorityFeeLamports: int(env, 'MAX_PRIORITY_FEE_LAMPORTS'),
    jitoEnabled: boolean(env, 'JITO_ENABLED'),
    jitoBlockEngineUrl: optional(env, 'JITO_BLOCK_ENGINE_URL') || null,
    jitoTipLamports: env['JITO_TIP_LAMPORTS'] ? int(env, 'JITO_TIP_LAMPORTS') : 0,
    jitoTipAccount: optional(env, 'JITO_TIP_ACCOUNT') || null,
    jitoTipAccounts: env['JITO_TIP_ACCOUNTS']
      ? [...new Set(splitList(env['JITO_TIP_ACCOUNTS']))].sort()
      : [...DEFAULT_JITO_TIP_ACCOUNTS].sort(),
    jupiterBaseUrl: optional(env, 'JUPITER_BASE_URL', DEFAULT_JUPITER_BASE_URL),
    jupiterProgramIds: env['JUPITER_PROGRAM_ALLOWLIST']
      ? [...new Set(splitList(env['JUPITER_PROGRAM_ALLOWLIST']))].sort()
      : [DEFAULT_JUPITER_PROGRAM_ID],
    swapStreamPath: required(env, 'SWAP_STREAM_PATH'),
    executorLogDir: optional(env, 'EXECUTOR_LOG_DIR', 'logs'),
    dryRun: boolean(env, 'DRY_RUN'),
  };
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse + validate the full config. Throws ConfigValidationError with the
 * missing key names when anything required is absent (fail closed).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ExecutorConfig {
  const config = poolDefaults(env);

  httpUrl(config.rpcReadUrl, 'SOLANA_RPC_URL');
  httpUrl(config.rpcWriteUrl, 'SOLANA_RPC_WRITE_URL');
  if (config.rpcWsUrl) wsUrl(config.rpcWsUrl, 'SOLANA_WS_URL');
  if (config.rpcMaxCuPerSecond <= 0) {
    throw new ConfigValidationError('SOLANA_RPC_MAX_CU_PER_SECOND must be greater than zero');
  }
  if (config.jitoBlockEngineUrl) httpUrl(config.jitoBlockEngineUrl, 'JITO_BLOCK_ENGINE_URL');
  httpUrl(config.jupiterBaseUrl, 'JUPITER_BASE_URL');
  if (config.jupiterProgramIds.length === 0) {
    throw new ConfigValidationError('JUPITER_PROGRAM_ALLOWLIST must not be empty');
  }
  for (const program of config.jupiterProgramIds) {
    try {
      new PublicKey(program);
    } catch {
      throw new ConfigValidationError('JUPITER_PROGRAM_ALLOWLIST must contain Solana public keys');
    }
  }
  if (config.commitment !== 'confirmed' && config.commitment !== 'finalized') {
    throw new ConfigValidationError('SOLANA_COMMITMENT must be confirmed|finalized');
  }
  for (const [key, value] of [
    ['MAX_SOL_PER_TX', config.maxSolPerTx],
    ['MAX_SOL_PER_RUN', config.maxSolPerRun],
    ['MAX_SLIPPAGE_BPS', config.maxSlippageBps],
    ['MAX_ACTIVE_BIN_SLIPPAGE_BINS', config.maxActiveBinSlippageBins],
    ['MAX_PRIORITY_FEE_LAMPORTS', config.maxPriorityFeeLamports],
    ['JITO_TIP_LAMPORTS', config.jitoTipLamports],
  ] as const) {
    if (value < 0) throw new ConfigValidationError(`${key} must be non-negative`);
  }
  if (config.maxSlippageBps > 10_000) {
    throw new ConfigValidationError('MAX_SLIPPAGE_BPS must be at most 10000');
  }
  if (config.maxActiveBinSlippageBins > 2_147_483_647) {
    throw new ConfigValidationError('MAX_ACTIVE_BIN_SLIPPAGE_BINS must fit i32');
  }

  if (config.walletSigner !== 'kms' && config.walletSigner !== 'keypair' && config.walletSigner !== 'file') {
    throw new ConfigValidationError('WALLET_SIGNER must be kms|keypair|file');
  }

  if (config.walletPubkey) {
    try {
      new PublicKey(config.walletPubkey);
    } catch {
      throw new ConfigValidationError('WALLET_PUBKEY must be a Solana public key');
    }
  }

  if (!config.dryRun) {
    if (config.walletSigner === 'kms' && !config.kmsKeyArn) {
      throw new ConfigValidationError('missing required env var: KMS_KEY_ARN (signer=kms)');
    }
    if (config.walletSigner === 'keypair' && !config.walletSecretArn) {
      throw new ConfigValidationError(
        'missing required env var: WALLET_SECRET_ARN (signer=keypair)',
      );
    }
    if (config.walletSigner === 'file' && !config.walletKeypairPath) {
      throw new ConfigValidationError(
        'missing required env var: WALLET_KEYPAIR_PATH (signer=file)',
      );
    }
    if (config.walletSigner === 'file' && !config.walletPubkey) {
      throw new ConfigValidationError(
        'missing required env var: WALLET_PUBKEY (signer=file pin)',
      );
    }
  }
  if (config.jitoEnabled && !config.jitoBlockEngineUrl) {
    throw new ConfigValidationError('JITO_ENABLED=true requires JITO_BLOCK_ENGINE_URL');
  }
  if (!config.jitoTipAccounts.length) {
    throw new ConfigValidationError('JITO_TIP_ACCOUNTS must not be empty');
  }
  for (const tip of config.jitoTipAccounts) {
    try {
      new PublicKey(tip);
    } catch {
      throw new ConfigValidationError('JITO_TIP_ACCOUNTS must contain Solana public keys');
    }
  }
  if (config.jitoEnabled) {
    if (!config.jitoTipAccount) {
      throw new ConfigValidationError('JITO_ENABLED=true requires JITO_TIP_ACCOUNT');
    }
    try {
      new PublicKey(config.jitoTipAccount);
    } catch {
      throw new ConfigValidationError('JITO_TIP_ACCOUNT must be a Solana public key');
    }
    if (!config.jitoTipAccounts.includes(config.jitoTipAccount)) {
      throw new ConfigValidationError('JITO_TIP_ACCOUNT must be inside JITO_TIP_ACCOUNTS');
    }
    if (config.jitoTipLamports <= 0) {
      throw new ConfigValidationError('JITO_TIP_LAMPORTS must be positive when Jito is enabled');
    }
    if (config.jitoTipLamports > config.maxPriorityFeeLamports) {
      throw new ConfigValidationError('JITO_TIP_LAMPORTS must fit MAX_PRIORITY_FEE_LAMPORTS');
    }
  }

  return config;
}

/**
 * Normalized, policy-relevant view of the config, hashed below.
 * Ordering-insensitive: allow-lists are sorted, object key order is fixed.
 */
function policyRelevant(config: ExecutorConfig): string {
  return JSON.stringify({
    rpcWriteUrl: config.rpcWriteUrl,
    commitment: config.commitment,
    walletSigner: config.walletSigner,
    kmsKeyArn: config.kmsKeyArn ? hashArn(config.kmsKeyArn) : null,
    walletSecretArn: config.walletSecretArn ? hashArn(config.walletSecretArn) : null,
    walletKeypairPath: config.walletKeypairPath ? hashArn(config.walletKeypairPath) : null,
    walletPubkey: config.walletPubkey,
    fileSignerAllowMainnet: config.fileSignerAllowMainnet,
    poolAllowlist: [...config.poolAllowlist].sort(),
    mintAllowlist: [...config.mintAllowlist].sort(),
    maxSolPerTx: config.maxSolPerTx,
    maxSolPerRun: config.maxSolPerRun,
    maxSlippageBps: config.maxSlippageBps,
    maxActiveBinSlippageBins: config.maxActiveBinSlippageBins,
    maxPriorityFeeLamports: config.maxPriorityFeeLamports,
    jitoEnabled: config.jitoEnabled,
    jitoBlockEngineUrl: config.jitoBlockEngineUrl,
    jitoTipLamports: config.jitoTipLamports,
    jitoTipAccount: config.jitoTipAccount,
    jitoTipAccounts: [...config.jitoTipAccounts].sort(),
    jupiterBaseUrl: config.jupiterBaseUrl,
    jupiterProgramIds: [...config.jupiterProgramIds].sort(),
    dryRun: config.dryRun,
  });
}

/** ARNs identify keys/secrets but hashing keeps them out of logs wholesale. */
function hashArn(arn: string): string {
  return createHash('sha256').update(arn).digest('hex').slice(0, 16);
}

/** SHA-256 of the normalized policy-relevant configuration. */
export function policyHash(config: ExecutorConfig): string {
  return createHash('sha256').update(policyRelevant(config)).digest('hex');
}
