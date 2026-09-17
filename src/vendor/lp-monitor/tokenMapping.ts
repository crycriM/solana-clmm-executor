// Token mapping cache. Disk persistence is intentionally omitted; rate limiting
// and the in-memory fetch cache are retained.

import axios from 'axios';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface TokenMapping {
  address: string;
  symbol: string;
  coingeckoId: string;
  decimals: number;
}

// Rate limiter: minimum delay between remote HTTP calls
let lastCallTimestamp = 0;
const MIN_DELAY_MS = 3000;

async function rateLimit(): Promise<void> {
  const sinceLast = Date.now() - lastCallTimestamp;
  if (sinceLast < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - sinceLast);
  }
  lastCallTimestamp = Date.now();
}

// Fetch cache so each token is requested once per process.
const mappingCache = new Map<string, TokenMapping | null>();

async function withRetry<T>(fn: () => Promise<T>, retries = 4, baseDelayMs = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      await rateLimit();
      return await fn();
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429 && i < retries - 1) {
        await sleep(baseDelayMs * Math.pow(2, i));
        continue;
      }
      throw error;
    }
  }
  throw new Error('max retries reached');
}

async function fetchTokenInfoFromCoinGecko(
  address: string,
  chain = 'solana',
): Promise<Omit<TokenMapping, 'address'> | null> {
  return withRetry(async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${chain}/contract/${address}`;
    const response = await axios.get(url);
    const data = response.data as {
      symbol?: string;
      id?: string;
      detail_platforms?: { solana?: { decimal_place?: number | string } };
    };
    const decimals = Number(data.detail_platforms?.solana?.decimal_place ?? 0);
    return {
      symbol: (data.symbol ?? 'UNKNOWN').toUpperCase(),
      coingeckoId: data.id ?? '',
      decimals,
    };
  });
}

/** Get-or-fetch a token mapping. Cache hits never call the network. */
export async function getTokenMapping(address: string): Promise<TokenMapping> {
  const cached = mappingCache.get(address);
  if (cached !== undefined) {
    return cached ?? { address, symbol: 'Unknown', coingeckoId: '', decimals: 0 };
  }
  let mapping: TokenMapping = { address, symbol: 'Unknown', coingeckoId: '', decimals: 0 };
  try {
    const fetched = await fetchTokenInfoFromCoinGecko(address);
    if (fetched) mapping = { address, ...fetched };
  } catch {
    // Leave the Unknown mapping; decimals 0 disables precision adjustments.
  }
  mappingCache.set(address, mapping.coingeckoId ? mapping : null);
  return mapping;
}

/** Prices for several tokens in one batched call (buckets of 50). */
export async function getTokenPrices(coingeckoIds: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const ids = [...new Set(coingeckoIds.filter((id) => id))];
  const buckets: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) {
    buckets.push(ids.slice(i, i + 50));
  }
  for (const bucket of buckets) {
    const bucketMap = await withRetry(async () => {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: { ids: bucket.join(','), vs_currencies: 'usd' },
      });
      const out = new Map<string, number>();
      for (const [id, priceData] of Object.entries(response.data as Record<string, unknown>)) {
        const usd = (priceData as { usd?: number }).usd;
        if (typeof usd === 'number') out.set(id, usd);
      }
      return out;
    });
    for (const [id, price] of bucketMap) prices.set(id, price);
  }
  return prices;
}
