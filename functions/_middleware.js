/**
 * functions/_middleware.js
 * ─────────────────────────────────────────────────────────────────
 * Shared backend utilities used by every API function.
 * ALL keys come from Cloudflare environment variables — never hardcoded.
 * ─────────────────────────────────────────────────────────────────
 */

const _ipMap = new Map();

// ── Verify user JWT token ─────────────────────────────────────────
export async function verifyAuth(request, env) {
  const supabaseUrl  = env.SUPABASE_URL;
  const supabaseAnon = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnon) {
    return { user: null, error: 'Server misconfiguration — missing env vars' };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token      = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { user: null, error: 'Missing Authorization header' };

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization:  `Bearer ${token}`,
        apikey:         supabaseAnon,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      return { user: null, error: `Invalid or expired token (${res.status})` };
    }

    const user = await res.json();
    if (!user?.id) return { user: null, error: 'Invalid token payload' };

    // Blocked-user check (uses service role key — never exposed to browser)
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      try {
        const blockRes = await fetch(
          `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=is_blocked,blocked_reason`,
          {
            headers: {
              apikey:         serviceKey,
              Authorization:  `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
          }
        );
        if (blockRes.ok) {
          const profiles = await blockRes.json();
          if (profiles?.[0]?.is_blocked) {
            return {
              user:  null,
              error: `Account suspended: ${profiles[0].blocked_reason || 'contact support'}`,
            };
          }
        }
      } catch (_) { /* fail open — never block legitimate users on check error */ }
    }

    return { user, error: null };
  } catch (e) {
    return { user: null, error: 'Auth check failed: ' + e.message };
  }
}

// ── CORS headers ──────────────────────────────────────────────────
export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env?.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type':                 'application/json',
    'X-Content-Type-Options':       'nosniff',
    'X-Frame-Options':              'DENY',
  };
}

// ── Input validation ──────────────────────────────────────────────
export function validate(schema, data) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const val      = data?.[field];
    const required = rule === 'required' || rule.includes('required');
    if (required && (val === undefined || val === null || val === '')) {
      errors.push(`Missing required field: ${field}`); continue;
    }
    if (val === undefined || val === null) continue;
    const type = rule.replace('|required', '').trim();
    if (type === 'string'  && typeof val !== 'string')  errors.push(`${field} must be a string`);
    if (type === 'boolean' && typeof val !== 'boolean') errors.push(`${field} must be a boolean`);
    if (type === 'number'  && typeof val !== 'number')  errors.push(`${field} must be a number`);
    if (type === 'array'   && !Array.isArray(val))      errors.push(`${field} must be an array`);
  }
  return errors;
}

// ── Sanitise input ────────────────────────────────────────────────
export function sanitise(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, maxLen);
}

// ── Audit log writer ──────────────────────────────────────────────
export async function auditLog(env, { userId, orgId, eventType, eventData, ipAddress }) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // silently skip if not configured yet

  try {
    await fetch(`${url}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey:          key,
        Authorization:   `Bearer ${key}`,
        Prefer:          'return=minimal',
      },
      body: JSON.stringify({
        user_id:         userId        || null,
        organization_id: orgId         || null,
        event_type:      eventType,
        event_data:      eventData     || {},
        ip_address:      ipAddress     || null,
        created_at:      new Date().toISOString(),
      }),
    });
  } catch (_) { /* never fail a request because of logging */ }
}

// ── KV cache helpers ──────────────────────────────────────────────
export const kv = {
  async get(env, key) {
    const store = env?.STRATEGY_CACHE || env?.CACHE;
    if (!store) return null;
    try { const v = await store.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
  },
  async put(env, key, value, ttl = 86400) {
    const store = env?.STRATEGY_CACHE || env?.CACHE;
    if (!store) return;
    try { await store.put(key, JSON.stringify(value), { expirationTtl: ttl }); } catch {}
  },
  async del(env, key) {
    const store = env?.STRATEGY_CACHE || env?.CACHE;
    if (!store) return;
    try { await store.delete(key); } catch {}
  },
};

// ── Rate limiter ──────────────────────────────────────────────────
export async function rateLimit(key, env, limit = 20, windowMs = 60_000) {
  const cacheKey = `rl:${key}`;
  const store    = env?.STRATEGY_CACHE || env?.CACHE;
  const now      = Date.now();

  if (store) {
    try {
      const entry = await store.get(cacheKey, { type: 'json' });
      if (!entry || now - entry.start > windowMs) {
        await store.put(cacheKey, JSON.stringify({ count: 1, start: now }), { expirationTtl: 120 });
        return true;
      }
      if (entry.count >= limit) return false;
      await store.put(cacheKey, JSON.stringify({ count: entry.count + 1, start: entry.start }), { expirationTtl: 120 });
      return true;
    } catch {}
  }

  // In-memory fallback (single Worker instance)
  const entry = _ipMap.get(cacheKey) || { count: 0, start: now };
  if (now - entry.start > windowMs) { _ipMap.set(cacheKey, { count: 1, start: now }); return true; }
  if (entry.count >= limit) return false;
  entry.count++;
  _ipMap.set(cacheKey, entry);
  return true;
}

// ── Response helpers ──────────────────────────────────────────────
export const okRes  = (data, h) => new Response(JSON.stringify(data),          { status: 200, headers: h });
export const errRes = (msg, s, h) => new Response(JSON.stringify({ error: msg }), { status: s,   headers: h });

// ── Supabase REST helper ──────────────────────────────────────────
export const sbFetch = (url, key, table, method, body, qs = '', prefer = '') =>
  fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey:          key,
      Authorization:   `Bearer ${key}`,
      Prefer:          prefer || (method === 'POST' ? 'return=representation' : 'return=minimal'),
    },
    body: body || undefined,
  });

// ── Global OPTIONS handler (Cloudflare Pages middleware) ──────────
export async function onRequest({ request, next }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
  return next();
}
