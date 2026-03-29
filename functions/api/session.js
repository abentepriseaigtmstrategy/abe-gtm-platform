/**
 * functions/api/session.js
 * GET /api/session
 *
 * Validates the Authorization token and returns the current
 * authenticated user context (user, profile, organization).
 * Used by auth-guard.js on every protected page load.
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

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  // ── Load user profile ─────────────────────────────────────────────────────
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=*`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const profiles = profileRes.ok ? await profileRes.json() : [];
  const profile  = profiles[0] || null;

  // ── Load organization ─────────────────────────────────────────────────────
  let org = null;
  if (profile?.organization_id) {
    const orgRes = await fetch(
      `${supabaseUrl}/rest/v1/organizations?id=eq.${profile.organization_id}&select=*`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const orgs = orgRes.ok ? await orgRes.json() : [];
    org = orgs[0] || null;
  }

  return okRes(
    {
      user: {
        id:    user.id,
        email: user.email,
      },
      profile: profile
        ? {
            plan:                 profile.plan,
            onboarding_completed: profile.onboarding_completed,
            is_admin:             profile.is_admin,
          }
        : null,
      organization: org
        ? {
            id:        org.id,
            name:      org.name,
            plan_tier: org.plan_tier,
          }
        : null,
      onboardingCompleted: profile?.onboarding_completed === true,
    },
    cors
  );
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
