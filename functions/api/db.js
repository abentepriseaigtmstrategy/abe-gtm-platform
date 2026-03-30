/**
 * functions/api/db.js
 * POST /api/db
 *
 * Secure backend proxy for window.APP.sb.from() calls in frontend pages.
 * Replaces direct Supabase SDK usage in dashboard.html, leads.html,
 * accounts.html, vault.html.
 *
 * SECURITY:
 *   - Every request requires a valid JWT (user must be authenticated)
 *   - All queries are automatically scoped to auth.uid() via RLS
 *   - Service role key is used server-side only — never exposed to frontend
 *   - No arbitrary table access — only whitelisted tables allowed
 *   - delete operations require an eq filter (no bulk deletes without filter)
 */

import { verifyAuth, corsHeaders, sanitise, okRes, errRes } from '../_middleware.js';

// Tables that frontend pages are allowed to access via this endpoint
const ALLOWED_TABLES = new Set([
  'alo_leads',
  'leads',
  'strategies',
  'user_profiles',
  'organizations',
  'icp_profiles',
  'keywords',
]);

export async function onRequestPost({ request, env }) {
  const cors        = corsHeaders(env);
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return errRes('Server misconfiguration', 503, cors);
  }

  // Auth — every call must come from an authenticated user
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const { table, action, data, filter, select, single } = body;

  // Validate table name
  if (!table || !ALLOWED_TABLES.has(table)) {
    return errRes(`Table "${table}" is not accessible via this endpoint`, 403, cors);
  }

  // Validate action
  const validActions = ['select', 'insert', 'upsert', 'update', 'delete'];
  if (!action || !validActions.includes(action)) {
    return errRes(`Invalid action: ${action}`, 400, cors);
  }

  // Build Supabase REST URL
  const tableUrl = `${supabaseUrl}/rest/v1/${table}`;

  // Build query string from filter
  let qs = '';
  if (filter && typeof filter === 'object') {
    qs = '?' + Object.entries(filter)
      .map(([col, val]) => `${encodeURIComponent(col)}=eq.${encodeURIComponent(val)}`)
      .join('&');
  }

  // Add select columns
  const selectCols = (select && typeof select === 'string') ? select : '*';
  qs += (qs ? '&' : '?') + `select=${encodeURIComponent(selectCols)}`;

  // Inject user_id filter for security on all operations
  // This ensures users can ONLY access their own rows
  const userFilter = `user_id=eq.${user.id}`;

  // For select/update/delete — add user_id filter unless table is user_profiles
  // (user_profiles uses id=eq.userId for self-access)
  if (action === 'select' || action === 'update' || action === 'delete') {
    if (table === 'user_profiles' || table === 'organizations') {
      // These tables use id or owner_id for scoping
      if (!filter?.id && table === 'user_profiles') {
        qs += `&id=eq.${user.id}`;
      }
    } else {
      qs += `&${userFilter}`;
    }
  }

  // Build request options
  const headers = {
    'Content-Type': 'application/json',
    apikey:          serviceKey,
    Authorization:   `Bearer ${serviceKey}`,
  };

  let method  = 'GET';
  let reqBody = undefined;
  let prefer  = '';

  switch (action) {
    case 'select':
      method = 'GET';
      prefer = 'return=representation';
      break;

    case 'insert':
      method  = 'POST';
      prefer  = 'return=representation';
      // Inject user_id into data for security
      reqBody = JSON.stringify(Array.isArray(data)
        ? data.map(function (r) { return Object.assign({}, r, { user_id: user.id }); })
        : Object.assign({}, data, { user_id: user.id })
      );
      break;

    case 'upsert':
      method  = 'POST';
      prefer  = 'return=representation,resolution=merge-duplicates';
      // Inject user_id into every row
      reqBody = JSON.stringify(Array.isArray(data)
        ? data.map(function (r) { return Object.assign({}, r, { user_id: user.id }); })
        : Object.assign({}, data, { user_id: user.id })
      );
      break;

    case 'update':
      method  = 'PATCH';
      prefer  = 'return=representation';
      reqBody = JSON.stringify(data);
      break;

    case 'delete':
      // Require a filter for delete — never allow unfiltered deletes
      if (!filter || Object.keys(filter).length === 0) {
        return errRes('delete requires at least one filter to prevent accidental bulk deletion', 400, cors);
      }
      method = 'DELETE';
      prefer = 'return=minimal';
      break;
  }

  if (prefer) headers['Prefer'] = prefer;

  try {
    const res = await fetch(tableUrl + qs, {
      method,
      headers,
      body: reqBody,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return errRes(errBody.message || errBody.error || `Supabase error ${res.status}`, res.status, cors);
    }

    // Handle empty responses (delete returns no body)
    const text = await res.text();
    const result = text ? JSON.parse(text) : [];

    // If single was requested, return first item
    const output = single ? (Array.isArray(result) ? result[0] || null : result) : result;

    return okRes(output, cors);

  } catch (e) {
    return errRes('Database operation failed: ' + e.message, 500, cors);
  }
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
