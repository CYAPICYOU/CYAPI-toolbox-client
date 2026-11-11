import { SERVER_URL } from './native';
import { readPrices, validDeliveredPrices } from '../usage';
import type { DeliveredPrices, UsagePrices } from '../usage';

/**
 * Server-delivered official reference prices (a models.dev projection).
 * They sit above the built-in table and below per-model custom prices;
 * an unavailable server only costs the reference, never usage data.
 */
const CACHE_KEY = 'cyapi.model-prices.v1';
const REFRESH_MS = 24 * 86400000;

interface CacheEntry {
  fetchedAt: number;
  updatedAt: string;
  prices: UsagePrices;
}
function readCache(): CacheEntry | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const fetchedAt = raw.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
    const prices = readPrices(JSON.stringify(raw.prices ?? {}));
    const updatedAt = raw.updatedAt;
    if (!Object.keys(prices).length || typeof updatedAt !== 'string' || !updatedAt) return null;
    return { fetchedAt, updatedAt, prices };
  } catch {
    return null;
  }
}
function writeCache(entry: CacheEntry) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // An unavailable browser cache does not discard a valid server response.
  }
}
export async function fetchDeliveredPrices(): Promise<DeliveredPrices | null> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < REFRESH_MS)
    return { prices: cached.prices, updatedAt: cached.updatedAt };
  try {
    const response = await fetch(`${SERVER_URL}/api/model-prices`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('unavailable');
    const delivered = validDeliveredPrices(await response.json());
    if (!delivered) throw new Error('invalid');
    writeCache({ fetchedAt: Date.now(), ...delivered });
    return delivered;
  } catch {
    return cached ? { prices: cached.prices, updatedAt: cached.updatedAt } : null;
  }
}
