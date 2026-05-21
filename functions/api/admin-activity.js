/**
 * functions/api/admin/activity.js
 * GET /api/admin/activity
 *
 * Returns audit logs. Restricted to users where is_admin = true.
 * Access enforced by backend + RLS — never exposed to regular users.
 *
 * Query params (all optional):
 *   user_id     — filter by user
 *   org_id      — filter by organization
 *   event_type  — filter by event (signup, login, signal_score, etc.)
 *   limit       — max rows (default 100, max 500)
 *   offset      — pagination offset
 */

import {
  verifyAuth,
  corsHeaders,
  okRes,
  errRes,
} from '../_middleware.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return errRes('Server misconfiguration', 500, cors);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  // ── Admin check — backend enforced ───────────────────────────────────────
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=is_admin,organization_id`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const profiles = profileRes.ok ? await profileRes.json() : [];
  const profile  = profiles[0];

  if (!profile?.is_admin) {
    return errRes('Forbidden — admin access required', 403, cors);
  }

  // ── Parse query params ────────────────────────────────────────────────────
  const url         = new URL(request.url);
  const filterUser  = url.searchParams.get('user_id')    || null;
  const filterOrg   = url.searchParams.get('org_id')     || null;
  const filterEvent = url.searchParams.get('event_type') || null;
  const rawLimit    = parseInt(url.searchParams.get('limit')  || '100', 10);
  const rawOffset   = parseInt(url.searchParams.get('offset') || '0',   10);
  const limit       = Math.min(Math.max(1, rawLimit),  500);
  const offset      = Math.max(0, rawOffset);

  // ── Build query ───────────────────────────────────────────────────────────
  let qs = `?order=created_at.desc&limit=${limit}&offset=${offset}`;
  if (filterUser)  qs += `&user_id=eq.${encodeURIComponent(filterUser)}`;
  if (filterOrg)   qs += `&organization_id=eq.${encodeURIComponent(filterOrg)}`;
  if (filterEvent) qs += `&event_type=eq.${encodeURIComponent(filterEvent)}`;

  // ── Fetch audit logs ──────────────────────────────────────────────────────
  const logsRes = await fetch(`${supabaseUrl}/rest/v1/audit_logs${qs}&select=*`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'count=exact',
    },
  });

  if (!logsRes.ok) {
    return errRes('Failed to fetch audit logs', 500, cors);
  }

  const logs        = await logsRes.json();
  const totalHeader = logsRes.headers.get('Content-Range') || '';
  const total       = parseInt(totalHeader.split('/')[1] || '0', 10);

  // ── Fetch organizations for admin panel ───────────────────────────────────
  const orgsRes = await fetch(
    `${supabaseUrl}/rest/v1/organizations?select=id,name,plan_tier,created_at,owner_id&order=created_at.desc&limit=200`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const organizations = orgsRes.ok ? await orgsRes.json() : [];

  // ── KPI aggregates ────────────────────────────────────────────────────────
  const kpiRes = await fetch(
    `${supabaseUrl}/rest/v1/audit_logs?select=event_type`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const allEvents = kpiRes.ok ? await kpiRes.json() : [];
  const kpis = allEvents.reduce(
    (acc, e) => {
      acc.total++;
      acc[e.event_type] = (acc[e.event_type] || 0) + 1;
      return acc;
    },
    { total: 0 }
  );

  return okRes(
    {
      logs,
      total,
      limit,
      offset,
      organizations,
      kpis,
    },
    cors
  );
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
