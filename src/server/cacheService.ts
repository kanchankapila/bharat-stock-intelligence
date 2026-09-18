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
    connectTimeout: 5000,
    enableOfflineQueue: false,
    autoResubscribe: true,
    maxRetriesPerRequest: 0,
    // Reconnect with backoff: 200ms → 1s → 5s, give up after 10 attempts.
    // This handles transient Docker networking blips without permanently losing Redis.
    retryStrategy: (times) => {
      if (times > 10) return null;
      return Math.min(times * 200, 5000) + Math.floor(Math.random() * 100);
    },
  });

  client.on('connect', () => {
    redisAvailable = true;
    console.log(`[CACHE] Redis connected at ${host}:${port}`);
  });

  client.on('ready', () => {
    redisAvailable = true;
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

  client.on('reconnecting', () => {
    console.log('[CACHE] Redis reconnecting...');
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
  // Write through to L1 even when Redis is up. cacheGet promotes Redis hits into L1 for 30s,
  // so a Redis-only set followed by an L1-hit read used to serve the STALE pre-write value
  // for up to 30s (AF-20260902-18). Both tiers now always agree.
  memSet(key, value, ttlSeconds);
  if (redisAvailable && redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // L1 already updated — Redis write failure must not surface as a cache miss
    }
  }
}

export async function cacheDel(key: string): Promise<void> {
  memCache.delete(key);
  if (redisAvailable && redis) {
    try { await redis.del(key); } catch { /* ignore */ }
  }
}

/**
 * Delete every cached entry whose key starts with `prefix`, from BOTH tiers. Returns the
 * number of entries evicted.
 *
 * Why this exists (and why `cacheDel` alone was not enough): `fetchWithCache` call sites key
 * on their own INPUT PARAMETERS, e.g. the corporate-actions calendar uses
 * `fund:filed-corp-actions:${daysBack}:${daysForward}:${symbol}`. A background job that has
 * just refreshed the underlying table cannot know which parameter combinations have been
 * requested, so it has no exact key to pass to `cacheDel` — only a prefix.
 *
 * Concrete case this fixes: `investsights_corporate_actions_fetcher.py` refreshes
 * nse_filed_corporate_actions daily, while fundamentals.router caches the same table for
 * 1800 s. Without prefix invalidation the fetcher's own stated goal ("it should stay fresher
 * than the thing it's checking") could not hold, because the month-old cache entry kept
 * being served for up to 30 minutes after new filings landed.
 *
 * Uses cursor-based SCAN, NOT KEYS: KEYS is O(keyspace) and blocks Redis's single thread for
 * the entire scan, stalling every other caller of this cache. SCAN is incremental.
 */
export async function cacheDelPrefix(prefix: string): Promise<number> {
  let removed = 0;

  // L1 first — synchronous and always available, even when Redis is down.
  for (const key of memCache.keys()) {
    if (key.startsWith(prefix)) {
      memCache.delete(key);
      removed++;
    }
  }

  if (redisAvailable && redis) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor, 'MATCH', `${prefix}*`, 'COUNT', 100,
        );
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
    } catch {
      // Redis error — L1 is already cleared; the remaining Redis entries expire on their own
      // TTL. Must not throw: this runs inside background jobs whose failures are caught and
      // reported separately, and a failed invalidation is not worth failing the job over.
    }
  }

  return removed;
}

export function isCacheAvailable(): boolean {
  return redisAvailable;
}

const _inFlight = new Map<string, Promise<unknown>>();

/**
 * Return cached value for `key` if present; otherwise call `fetcher`,
 * store the result with `ttlSeconds`, and return it.
 * Deduplicates concurrent fetches for the same key to prevent cache stampedes.
 */
export async function fetchWithCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = 300,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;

  // Return existing in-flight promise if one is running for this key
  const existing = _inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fetcher().then(result => {
    if (result !== null && result !== undefined) {
      cacheSet(key, result, ttlSeconds);
    }
    _inFlight.delete(key);
    return result;
  }).catch(err => {
    _inFlight.delete(key);
    throw err;
  });
  _inFlight.set(key, promise);
  return promise;
}
