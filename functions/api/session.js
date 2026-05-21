/**
 * functions/api/session.js
 * GET /api/session
 *
 * Validates the Bearer token and returns user context.
 * Called by auth-guard.js on every protected page load.
 *
 * Token verification uses SUPABASE_ANON_KEY only.
 * Profile/org fetch uses SUPABASE_SERVICE_ROLE_KEY (graceful if missing).
 */

import { verifyAuth, corsHeaders, okRes, errRes } from '../_middleware.js';

export async function onRequestGet({ request, env }) {
  const cors        = corsHeaders(env);
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY;

  // Step 1: Verify token — only needs anon key (handled inside verifyAuth)
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  // Step 2: Load profile — needs service role key
  // If key is not set yet, return basic user data so the app still works
  if (!supabaseUrl || !serviceKey) {
    return okRes({
      user:               { id: user.id, email: user.email },
      profile:            null,
      organization:       null,
      onboardingCompleted: false,
      warning:            'SUPABASE_SERVICE_ROLE_KEY not set — profile data unavailable',
    }, cors);
  }

  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${user.id}&select=*`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } }
  );

  const profiles = profileRes.ok ? await profileRes.json() : [];
  const profile  = profiles[0] || null;

  let org = null;
  if (profile?.organization_id) {
    const orgRes = await fetch(
      `${supabaseUrl}/rest/v1/organizations?id=eq.${profile.organization_id}&select=id,name,plan_tier`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } }
    );
    const orgs = orgRes.ok ? await orgRes.json() : [];
    org = orgs[0] || null;
  }

  return okRes({
    user:  { id: user.id, email: user.email },
    profile: profile ? {
      plan:                 profile.plan,
      onboarding_completed: profile.onboarding_completed,
      is_admin:             profile.is_admin,
    } : null,
    organization: org ? { id: org.id, name: org.name, plan_tier: org.plan_tier } : null,
    onboardingCompleted: profile?.onboarding_completed === true,
  }, cors);
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
