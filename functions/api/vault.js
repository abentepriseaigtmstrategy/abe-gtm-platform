/**
 * /api/vault  —  GET + POST
 * Spec-compliant vault endpoint.
 *
 * GET  /api/vault           → { reports: [] }
 * GET  /api/vault?id=UUID   → { report }
 * POST /api/vault           → delegates to gtm.js get_vault action (pagination, filters)
 */
import { verifyAuth, corsHeaders, sanitise, errRes, okRes } from './_middleware.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  const token = request.headers.get('Authorization') || '';

  const baseUrl = url.origin;

  if (id) {
    // Single report
    const res = await fetch(`${baseUrl}/api/gtm`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ action: 'get_strategy', strategy_id: sanitise(id, 36) }),
    });
    const data = await res.json();
    if (!res.ok) return errRes(data.error || 'Not found', res.status, cors);
    return okRes({ report: data.strategy }, cors);
  }

  // List all
  const res = await fetch(`${baseUrl}/api/gtm`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ action: 'get_vault', limit: 50, offset: 0 }),
  });
  const data = await res.json();
  if (!res.ok) return errRes(data.error || 'Vault fetch failed', res.status, cors);

  return okRes({ reports: data.strategies || [] }, cors);
}

// Also accept POST for advanced queries (search, filters, pagination)
export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const token   = request.headers.get('Authorization') || '';
  const baseUrl = new URL(request.url).origin;

  // Forward to gtm.js with any filters included
  const res = await fetch(`${baseUrl}/api/gtm`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ action: 'get_vault', ...body }),
  });
  const data = await res.json();
  if (!res.ok) return errRes(data.error || 'Vault fetch failed', res.status, cors);
  return okRes(data, cors);
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
