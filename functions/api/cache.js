/**
 * cache.js — Cloudflare KV cache abstraction
 *
 * Wraps env.STRATEGY_CACHE with consistent get/put/del/wrap helpers.
 * All workers import from here — never access KV directly.
 *
 * Key naming conventions:
 *   website:{hostname}         → website analysis (24h)
 *   intent:{company_id}        → intent signals aggregate (6h)
 *   tech:{hostname}            → technology detection (48h)
 *   graph:{company_id}         → account graph (1h)
 *   weights:{user_id}          → learning weights (1h)
 *   hot:{user_id}              → hot accounts list (30m)
 */

const KV_BINDING = 'STRATEGY_CACHE';

/**
 * Get a cached value. Returns parsed object or null.
 */
export async function cacheGet(env, key) {
  const store = env?.[KV_BINDING];
  if (!store) return null;
  try {
    const val = await store.get(key);
    if (!val) return null;
    return JSON.parse(val);
  } catch { return null; }
}

/**
 * Store a value in cache with a TTL in seconds.
 */
export async function cachePut(env, key, value, ttlSeconds = 86400) {
  const store = env?.[KV_BINDING];
  if (!store) return;
  try {
    await store.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    });
  } catch {}
}

/**
 * Delete a cached value.
 */
export async function cacheDel(env, key) {
  const store = env?.[KV_BINDING];
  if (!store) return;
  try { await store.delete(key); } catch {}
}

/**
 * Cache-wrap pattern: returns cached result or runs fn() and caches result.
 *
 * Usage:
 *   const data = await cacheWrap(env, 'website:example.com', 86400, () => expensiveFetch())
 */
export async function cacheWrap(env, key, ttlSeconds, fn) {
  const cached = await cacheGet(env, key);
  if (cached !== null) return { data: cached, cached: true };

  const result = await fn();
  await cachePut(env, key, result, ttlSeconds);
  return { data: result, cached: false };
}

/**
 * Invalidate all cache keys matching a prefix.
 * Cloudflare KV supports list() for prefix scanning.
 */
export async function cacheInvalidatePrefix(env, prefix) {
  const store = env?.[KV_BINDING];
  if (!store) return 0;
  try {
    let count  = 0;
    let cursor = undefined;
    do {
      const result = await store.list({ prefix, cursor, limit: 100 });
      for (const key of result.keys) {
        await store.delete(key.name);
        count++;
      }
      cursor = result.list_complete ? null : result.cursor;
    } while (cursor);
    return count;
  } catch { return 0; }
}

/**
 * TTL constants (seconds) for consistent usage across workers.
 */
export const TTL = {
  WEBSITE_ANALYSIS: 86400,    // 24 hours
  INTENT_SIGNALS:   21600,    // 6 hours
  TECH_DETECTION:   172800,   // 48 hours
  ACCOUNT_GRAPH:    3600,     // 1 hour
  HOT_ACCOUNTS:     1800,     // 30 minutes
  WEIGHTS:          3600,     // 1 hour
  METRICS:          300,      // 5 minutes
};
