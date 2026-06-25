import Redis from 'ioredis';
import { REDIS_BASE } from './redisConfig';

// ─── Redis client (optional — gracefully falls back to in-process Map) ─────────

let redis: Redis | null = null;
let redisAvailable = false;

function createRedisClient(): Redis | null {
  const { host, port, password } = REDIS_BASE;

  const client = new Redis({ 
    host, 
    port, 
    password, 
    lazyConnect: true, 
    connectTimeout: 3000, 
    enableOfflineQueue: false,
    autoResubscribe: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null // Stop retrying immediately
  });

  client.on('connect', () => {
    redisAvailable = true;
    console.log(`[CACHE] Redis connected at ${host}:${port}`);
  });

  client.on('error', (err) => {
    if (redisAvailable) {
      console.warn('[CACHE] Redis error, falling back to in-memory:', err.message);
    }
    redisAvailable = false;
  });

  client.on('close', () => {
    redisAvailable = false;
  });

  return client;
}

export async function initCache(): Promise<boolean> {
  try {
    redis = createRedisClient();
    await redis!.connect();
    return true;
  } catch {
    console.log('[CACHE] Redis unavailable — using in-memory cache');
    redis = null;
    redisAvailable = false;
    return false;
  }
}

// ─── In-memory fallback ──────────────────────────────────────────────────────

// `parsed` keeps the live object so hot-path reads skip JSON.parse entirely.
// `data` is the serialised string used only when writing to Redis.
interface MemEntry { data: string; parsed: unknown; expires: number }
const memCache = new Map<string, MemEntry>();

function memGet<T>(key: string): T | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) { memCache.delete(key); return null; }
  return entry.parsed as T;
}

function memSet(key: string, value: unknown, ttlSeconds: number): void {
  memCache.set(key, {
    data: JSON.stringify(value),
    parsed: value,
    expires: Date.now() + ttlSeconds * 1000,
  });
}

// Evict expired keys periodically to avoid unbounded memory growth
const memCacheEvictionInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memCache) {
    if (v.expires < now) memCache.delete(k);
  }
}, 60_000);
memCacheEvictionInterval.unref?.();

// ─── Public API ───────────────────────────────────────────────────────────────

export async function cacheGet<T>(key: string): Promise<T | null> {
  // L1: in-process parsed object (no network, no JSON.parse on repeat reads)
  const l1 = memGet<T>(key);
  if (l1 !== null) return l1;

  if (redisAvailable && redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        // Promote to L1 for 30 s to absorb burst re-reads from the same process
        memSet(key, parsed, 30);
        return parsed;
      }
    } catch {
      // Redis error — L1 already missed, fall through to null
    }
  }
  return null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (redisAvailable && redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
      return;
    } catch {
      // fall through to memory
    }
  }
  memSet(key, value, ttlSeconds);
}

export async function cacheDel(key: string): Promise<void> {
  memCache.delete(key);
  if (redisAvailable && redis) {
    try { await redis.del(key); } catch { /* ignore */ }
  }
}

export function isCacheAvailable(): boolean {
  return redisAvailable;
}

/**
 * Return cached value for `key` if present; otherwise call `fetcher`,
 * store the result with `ttlSeconds`, and return it.
 */
export async function fetchWithCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = 300,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  const value = await fetcher();
  if (value !== null && value !== undefined) {
    await cacheSet(key, value, ttlSeconds);
  }
  return value;
}
