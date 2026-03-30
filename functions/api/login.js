/**
 * functions/api/login.js
 * POST /api/login
 *
 * Authenticates user, loads their profile and organization,
 * writes audit log, returns token + full context.
 */

import { corsHeaders, validate, sanitise, auditLog, okRes, errRes } from '../_middleware.js';

export async function onRequestPost({ request, env }) {
  const cors        = corsHeaders(env);
  const supabaseUrl = env.SUPABASE_URL;
  const anonKey     = env.SUPABASE_ANON_KEY;
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return errRes('Server misconfiguration — contact administrator', 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid JSON body', 400, cors); }

  const errors = validate({ email: 'string|required', password: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const email = sanitise(body.email, 254).toLowerCase();
  const ip    = request.headers.get('CF-Connecting-IP') || null;

  // ── Authenticate via Supabase ─────────────────────────────────
  const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body:    JSON.stringify({ email, password: body.password }),
  });

  const authData = await authRes.json();
  if (!authRes.ok || authData.error) {
    return errRes(
      authData.error_description || authData.error?.message || 'Invalid email or password',
      401,
      cors
    );
  }

  const { user, access_token } = authData;
  if (!user?.id || !access_token) {
    return errRes('Authentication failed — no session returned', 500, cors);
  }

  // ── Load user profile ─────────────────────────────────────────
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=*`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } }
  );
  const profiles = profileRes.ok ? await profileRes.json() : [];
  const profile  = profiles[0] || null;

  if (profile?.is_blocked) {
    return errRes(`Account suspended: ${profile.blocked_reason || 'contact support'}`, 403, cors);
  }

  // ── Load organization ─────────────────────────────────────────
  let org = null;
  if (profile?.organization_id) {
    const orgRes = await fetch(
      `${supabaseUrl}/rest/v1/organizations?id=eq.${profile.organization_id}&select=*`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } }
    );
    const orgs = orgRes.ok ? await orgRes.json() : [];
    org = orgs[0] || null;
  }

  // ── Audit log ─────────────────────────────────────────────────
  await auditLog(env, {
    userId:    user.id,
    orgId:     profile?.organization_id || null,
    eventType: 'login',
    eventData: { email, plan: profile?.plan || 'unknown' },
    ipAddress: ip,
  });

  return okRes({
    token: access_token,
    user:  { id: user.id, email: user.email },
    profile: profile ? {
      plan:                 profile.plan,
      onboarding_completed: profile.onboarding_completed,
      is_admin:             profile.is_admin,
    } : null,
    organization: org ? {
      id:        org.id,
      name:      org.name,
      plan_tier: org.plan_tier,
    } : null,
    onboardingCompleted: profile?.onboarding_completed === true,
  }, cors);
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
