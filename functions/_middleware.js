/**
 * functions/_middleware.js
 * Shared backend utilities.
 * Keys ONLY from Cloudflare environment — never hardcoded.
 *
 * RESILIENCE RULE:
 *   - SUPABASE_URL + SUPABASE_ANON_KEY → required for all token verification
 *   - SUPABASE_SERVICE_ROLE_KEY        → required for DB writes / admin reads
 *   - If service key missing → endpoints that need it return a clear 503
 *     with an actionable message, never a silent 500
 */

const _ipMap = new Map();

// ── Verify a user JWT (only needs anon key) ───────────────────────
export async function verifyAuth(request, env) {
  const supabaseUrl  = env.SUPABASE_URL;
  const supabaseAnon = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnon) {
    return { user: null, error: 'Server misconfiguration: SUPABASE_URL or SUPABASE_ANON_KEY missing from Cloudflare env vars' };
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
    if (!res.ok) return { user: null, error: `Token invalid or expired (${res.status})` };
    const user = await res.json();
    if (!user?.id) return { user: null, error: 'Invalid token payload' };
    return { user, error: null };
  } catch (e) {
    return { user: null, error: 'Auth check failed: ' + e.message };
  }
}

// ── Require service role key — returns clear error if missing ─────
export function requireServiceKey(env, cors) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return {
      key: null,
      response: errRes(
        'SUPABASE_SERVICE_ROLE_KEY is not configured. ' +
        'Go to: Cloudflare Dashboard → Workers & Pages → abe-gtm-platform → Settings → Environment Variables → Add Secret',
        503,
        cors
      ),
    };
  }
  return { key, response: null };
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

// ── Validation ────────────────────────────────────────────────────
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

// ── Sanitise ──────────────────────────────────────────────────────
export function sanitise(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val.replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

// ── Audit log (non-fatal — never blocks a request) ────────────────
export async function auditLog(env, { userId, orgId, eventType, eventData, ipAddress }) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/audit_logs`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey:          key,
        Authorization:   `Bearer ${key}`,
        Prefer:          'return=minimal',
      },
      body: JSON.stringify({
        user_id:         userId || null,
        organization_id: orgId  || null,
        event_type:      eventType,
        event_data:      eventData || {},
        ip_address:      ipAddress || null,
        created_at:      new Date().toISOString(),
      }),
    });
  } catch (_) {}
}

// ── KV cache ──────────────────────────────────────────────────────
export const kv = {
  async get(env, key) {
    const s = env?.STRATEGY_CACHE || env?.CACHE;
    if (!s) return null;
    try { const v = await s.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
  },
  async put(env, key, value, ttl = 86400) {
    const s = env?.STRATEGY_CACHE || env?.CACHE;
    if (!s) return;
    try { await s.put(key, JSON.stringify(value), { expirationTtl: ttl }); } catch {}
  },
};

// ── Rate limiter ──────────────────────────────────────────────────
export async function rateLimit(key, env, limit = 20, windowMs = 60_000) {
  const cacheKey = `rl:${key}`;
  const store    = env?.STRATEGY_CACHE || env?.CACHE;
  const now      = Date.now();
  if (store) {
    try {
      const e = await store.get(cacheKey, { type: 'json' });
      if (!e || now - e.start > windowMs) {
        await store.put(cacheKey, JSON.stringify({ count: 1, start: now }), { expirationTtl: 120 });
        return true;
      }
      if (e.count >= limit) return false;
      await store.put(cacheKey, JSON.stringify({ count: e.count + 1, start: e.start }), { expirationTtl: 120 });
      return true;
    } catch {}
  }
  const e = _ipMap.get(cacheKey) || { count: 0, start: now };
  if (now - e.start > windowMs) { _ipMap.set(cacheKey, { count: 1, start: now }); return true; }
  if (e.count >= limit) return false;
  e.count++;
  _ipMap.set(cacheKey, e);
  return true;
}

// ── Response helpers ──────────────────────────────────────────────
export const okRes  = (d, h) => new Response(JSON.stringify(d),            { status: 200, headers: h });
export const errRes = (m, s, h) => new Response(JSON.stringify({ error: m }), { status: s,   headers: h });

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

// ── Global OPTIONS handler ────────────────────────────────────────
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
