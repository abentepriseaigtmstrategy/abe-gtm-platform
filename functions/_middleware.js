/**
 * functions/_middleware.js
 * Shared utilities — imported by ALL API functions.
 * Global Cloudflare Pages middleware (handles OPTIONS for all /api/* routes).
 *
 * SECURITY: ALL keys come from env bindings ONLY.
 * Zero hardcoded credentials. Zero fallback secrets.
 */

const _ipMap = new Map();

// ── Auth ─────────────────────────────────────────────────────────────────────
export async function verifyAuth(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseAnon = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnon) {
    return { user: null, error: 'Server misconfiguration: missing Supabase env vars' };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { user: null, error: 'Missing Authorization header' };

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnon,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      return { user: null, error: `Invalid or expired token (${res.status})` };
    }

    const user = await res.json();
    if (!user?.id) return { user: null, error: 'Invalid token payload' };

    // Blocked user check — uses service role key to bypass RLS
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      try {
        const blockRes = await fetch(
          `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=is_blocked,blocked_reason`,
          {
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
          }
        );
        if (blockRes.ok) {
          const profiles = await blockRes.json();
          if (profiles?.[0]?.is_blocked) {
            const reason = profiles[0].blocked_reason || 'Account suspended';
            return { user: null, error: `Account suspended: ${reason}` };
          }
        }
      } catch (_) {
        // Fail open — don't block legitimate users on check failure
      }
    }

    return { user, error: null };
  } catch (e) {
    return { user: null, error: 'Auth verification failed: ' + e.message };
  }
}

// ── CORS headers ──────────────────────────────────────────────────────────────
export function corsHeaders(env) {
  const origin = env?.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
  };
}

// ── Validation ────────────────────────────────────────────────────────────────
export function validate(schema, data) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const val = data?.[field];
    const required = rule === 'required' || rule.includes('required');
    if (required && (val === undefined || val === null || val === '')) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }
    if (val === undefined || val === null) continue;
    const type = rule.replace('|required', '').trim();
    if (type === 'string' && typeof val !== 'string') errors.push(`${field} must be a string`);
    if (type === 'number' && typeof val !== 'number') errors.push(`${field} must be a number`);
    if (type === 'boolean' && typeof val !== 'boolean') errors.push(`${field} must be a boolean`);
    if (type === 'array' && !Array.isArray(val)) errors.push(`${field} must be an array`);
  }
  return errors;
}

// ── KV helpers ────────────────────────────────────────────────────────────────
export const kv = {
  async get(env, key) {
    const store = env?.STRATEGY_CACHE || env?.CACHE;
    if (!store) return null;
    try {
      const val = await store.get(key);
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  },
  async put(env, key, value, ttlSeconds = 86400) {
    const store = env?.STRATEGY_CACHE || env?.CACHE;
    if (!store) return;
    try {
      await store.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    } catch {}
  },
  async del(env, key) {
    const store = env?.STRATEGY_CACHE || env?.CACHE;
    if (!store) return;
    try { await store.delete(key); } catch {}
  },
};

// ── Rate limiting ─────────────────────────────────────────────────────────────
export async function rateLimit(key, env, limit = 10, windowMs = 60_000) {
  const cacheKey = `rl:${key}`;
  const store = env?.STRATEGY_CACHE || env?.CACHE;
  if (store) {
    try {
      const entry = await store.get(cacheKey, { type: 'json' });
      const now = Date.now();
      if (!entry || now - entry.start > windowMs) {
        await store.put(cacheKey, JSON.stringify({ count: 1, start: now }), {
          expirationTtl: Math.ceil(windowMs / 1000) + 5,
        });
        return true;
      }
      if (entry.count >= limit) return false;
      await store.put(
        cacheKey,
        JSON.stringify({ count: entry.count + 1, start: entry.start }),
        { expirationTtl: Math.ceil(windowMs / 1000) + 5 }
      );
      return true;
    } catch {}
  }
  // In-memory fallback
  const now = Date.now();
  const entry = _ipMap.get(cacheKey) || { count: 0, start: now };
  if (now - entry.start > windowMs) { _ipMap.set(cacheKey, { count: 1, start: now }); return true; }
  if (entry.count >= limit) return false;
  entry.count++;
  _ipMap.set(cacheKey, entry);
  return true;
}

// ── Sanitise ──────────────────────────────────────────────────────────────────
export function sanitise(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, maxLen);
}

// ── Audit log helper ──────────────────────────────────────────────────────────
export async function auditLog(env, { userId, orgId, eventType, eventData, ipAddress }) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  try {
    await fetch(`${url}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId || null,
        organization_id: orgId || null,
        event_type: eventType,
        event_data: eventData || {},
        ip_address: ipAddress || null,
        created_at: new Date().toISOString(),
      }),
    });
  } catch (_) {
    // Never fail a request because of audit logging
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────
export const okRes  = (data, h) => new Response(JSON.stringify(data), { status: 200, headers: h });
export const errRes = (msg, status, h) => new Response(JSON.stringify({ error: msg }), { status, headers: h });

// ── Supabase REST fetch helper ────────────────────────────────────────────────
export const sbFetch = (url, key, table, method, body, qs = '', prefer = '') => {
  const defaultPrefer = method === 'POST' ? 'return=representation' : 'return=minimal';
  return fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: prefer || defaultPrefer,
    },
    body: body || undefined,
  });
};

// ── Global Cloudflare Pages middleware (OPTIONS handler) ──────────────────────
export async function onRequest(context) {
  const { request, next } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
  return next();
}
