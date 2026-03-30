/**
 * functions/api/complete-oauth.js
 * POST /api/complete-oauth
 *
 * Called by auth-callback.html for NEW Google OAuth users.
 * The user is already authenticated (JWT token exists).
 * This endpoint creates their profile, organization, and membership.
 *
 * Different from /api/signup — does NOT create a new Supabase auth user.
 * The user already exists. We just create the database records.
 */

import { verifyAuth, corsHeaders, sanitise, auditLog, okRes, errRes } from '../_middleware.js';

export async function onRequestPost({ request, env }) {
  const cors        = corsHeaders(env);
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return errRes('Server misconfiguration', 500, cors);
  }

  // Verify the JWT — user must be authenticated via Google OAuth
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const ip = request.headers.get('CF-Connecting-IP') || null;

  // Parse body (consent choices stored by login.html)
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const termsAccepted    = !!body.terms_accepted;
  const marketingConsent = !!body.marketing_consent;

  // Check if profile already exists — don't duplicate
  const checkRes = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=id`,
    {
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (checkRes.ok) {
    const existing = await checkRes.json();
    if (existing?.length > 0) {
      // Profile already exists — just return success
      return okRes({ created: false, message: 'Profile already exists' }, cors);
    }
  }

  // ── Create organization ───────────────────────────────────────
  const orgRes = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=representation',
    },
    body: JSON.stringify({
      name:      `${user.email.split('@')[0]}'s Organization`,
      plan_tier: 'free_trial',
      owner_id:  user.id,
    }),
  });

  let org = null;
  if (orgRes.ok) {
    const orgs = await orgRes.json();
    org = orgs[0] || null;
  }

  // ── Create user profile ───────────────────────────────────────
  const profileRes = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=representation',
    },
    body: JSON.stringify({
      id:                   user.id,
      email:                user.email,
      organization_id:      org?.id || null,
      plan:                 'free_trial',
      tc_accepted:          termsAccepted,
      marketing_consent:    marketingConsent,
      onboarding_completed: false,
      is_admin:             false,
      is_blocked:           false,
      created_at:           new Date().toISOString(),
    }),
  });

  if (!profileRes.ok) {
    const errBody = await profileRes.json().catch(() => ({}));
    return errRes(errBody.message || 'Failed to create profile', 500, cors);
  }

  // ── Create membership ─────────────────────────────────────────
  if (org?.id) {
    await fetch(`${supabaseUrl}/rest/v1/organization_members`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey:          serviceKey,
        Authorization:   `Bearer ${serviceKey}`,
        Prefer:          'return=minimal',
      },
      body: JSON.stringify({
        organization_id: org.id,
        user_id:         user.id,
        role:            'owner',
        joined_at:       new Date().toISOString(),
      }),
    });
  }

  // ── Audit log ─────────────────────────────────────────────────
  await auditLog(env, {
    userId:    user.id,
    orgId:     org?.id || null,
    eventType: 'oauth_signup',
    eventData: { email: user.email, provider: 'google', plan: 'free_trial' },
    ipAddress: ip,
  });

  return okRes({ created: true }, cors);
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
