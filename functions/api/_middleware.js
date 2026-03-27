/**
 * Root middleware for ABE GTM Platform
 * Handles OPTIONS globally and provides shared utilities
 */

const _ipMap = new Map();

const SUPABASE_URL_DEFAULT = 'https://cwcvneluhlimhlzowabv.supabase.co';
const SUPABASE_ANON_KEY_DEFAULT = 'sb_publishable_EeDAvGbX7TpO_hgBoUZMhQ_B_nJtAbb';

export async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { user: null, error: 'Missing Authorization header' };

  const supabaseUrl  = env?.SUPABASE_URL      || SUPABASE_URL_DEFAULT;
  const supabaseAnon = env?.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY_DEFAULT;

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnon,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return { user: null, error: `Invalid token (${res.status})` };
    const user = await res.json();
    return { user, error: null };
  } catch (e) {
    return { user: null, error: 'Auth verification failed' };
  }
}

export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

export async function onRequest(context) {
  const { request, next } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(context.env) });
  }
  return next();
}

// Re-export utilities
export { rateLimit, sanitise, okRes, errRes, kv } from './utils.js';
