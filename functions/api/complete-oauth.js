/**
 * functions/api/complete-oauth.js
 * POST /api/complete-oauth
 *
 * Called by auth-callback.html for NEW Google/OAuth users only.
 * User is already authenticated. This creates their DB records.
 */

import { verifyAuth, corsHeaders, auditLog, okRes, errRes, requireServiceKey } from '../_middleware.js';

export async function onRequestPost({ request, env }) {
  const cors        = corsHeaders(env);
  const supabaseUrl = env.SUPABASE_URL;

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const { key: serviceKey, response: keyErr } = requireServiceKey(env, cors);
  if (keyErr) return keyErr;

  let body = {};
  try { body = await request.json(); } catch (_) {}

  const termsAccepted    = !!body.terms_accepted;
  const marketingConsent = !!body.marketing_consent;
  const ip               = request.headers.get('CF-Connecting-IP') || null;

  // Check if profile already exists
  const check = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } }
  );
  if (check.ok) {
    const existing = await check.json();
    if (existing?.length > 0) return okRes({ created: false }, cors);
  }

  // Create organization
  const orgRes = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=representation' },
    body:    JSON.stringify({ name: `${user.email.split('@')[0]}'s Organization`, plan_tier: 'free_trial', owner_id: user.id }),
  });
  const orgs = orgRes.ok ? await orgRes.json() : [];
  const org  = orgs[0] || null;

  // Create profile
  await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' },
    body:    JSON.stringify({
      id: user.id, email: user.email, organization_id: org?.id || null,
      plan: 'free_trial', tc_accepted: termsAccepted, marketing_consent: marketingConsent,
      onboarding_completed: false, is_admin: false, is_blocked: false,
      created_at: new Date().toISOString(),
    }),
  });

  // Create membership
  if (org?.id) {
    await fetch(`${supabaseUrl}/rest/v1/organization_members`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' },
      body:    JSON.stringify({ organization_id: org.id, user_id: user.id, role: 'owner', joined_at: new Date().toISOString() }),
    });
  }

  await auditLog(env, { userId: user.id, orgId: org?.id, eventType: 'oauth_signup', eventData: { email: user.email, provider: 'google' }, ipAddress: ip });

  return okRes({ created: true }, cors);
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
