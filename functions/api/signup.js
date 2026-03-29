/**
 * functions/api/signup.js
 * POST /api/signup
 *
 * Creates a new user, profile, organization, and membership.
 * Logs the event to audit_logs.
 * Returns user context on success.
 */

import {
  corsHeaders,
  validate,
  sanitise,
  auditLog,
  okRes,
  errRes,
} from '../_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey     = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return errRes('Server misconfiguration', 500, cors);
  }

  // Parse body
  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  // Validate required fields
  const errors = validate(
    {
      email:              'string|required',
      password:           'string|required',
      terms_accepted:     'boolean|required',
      marketing_consent:  'boolean|required',
    },
    body
  );
  if (errors.length) return errRes(errors[0], 400, cors);

  const email             = sanitise(body.email, 254).toLowerCase();
  const password          = body.password;
  const termsAccepted     = body.terms_accepted;
  const marketingConsent  = body.marketing_consent;

  // Terms are non-negotiable
  if (!termsAccepted) {
    return errRes('You must accept the Terms of Service to continue', 400, cors);
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errRes('Invalid email address', 400, cors);
  }

  // Password minimum length
  if (password.length < 8) {
    return errRes('Password must be at least 8 characters', 400, cors);
  }

  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;

  // ── Step 1: Create Supabase auth user ────────────────────────────────────
  const authRes = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
    },
    body: JSON.stringify({
      email,
      password,
      data: {
        terms_accepted:    termsAccepted,
        marketing_consent: marketingConsent,
      },
    }),
  });

  const authData = await authRes.json();

  if (!authRes.ok || authData.error) {
    const msg = authData.error?.message || authData.msg || 'Signup failed';
    return errRes(msg, authRes.status, cors);
  }

  const user    = authData.user;
  const session = authData.session;

  if (!user?.id) {
    return errRes('Signup did not return a user', 500, cors);
  }

  // ── Step 2: Create organization ───────────────────────────────────────────
  const orgRes = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      name:      `${email.split('@')[0]}'s Organization`,
      plan_tier: 'free_trial',
      owner_id:  user.id,
    }),
  });

  if (!orgRes.ok) {
    const orgErr = await orgRes.json().catch(() => ({}));
    // Attempt to clean up the auth user before failing
    await deleteAuthUser(supabaseUrl, serviceKey, user.id);
    return errRes(orgErr.message || 'Failed to create organization', 500, cors);
  }

  const [org] = await orgRes.json();

  // ── Step 3: Create user_profile ───────────────────────────────────────────
  const profileRes = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      id:                   user.id,
      email:                email,
      organization_id:      org.id,
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
    const profileErr = await profileRes.json().catch(() => ({}));
    await deleteAuthUser(supabaseUrl, serviceKey, user.id);
    return errRes(profileErr.message || 'Failed to create profile', 500, cors);
  }

  const [profile] = await profileRes.json();

  // ── Step 4: Create organization membership ────────────────────────────────
  await fetch(`${supabaseUrl}/rest/v1/organization_members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      organization_id: org.id,
      user_id:         user.id,
      role:            'owner',
      joined_at:       new Date().toISOString(),
    }),
  });

  // ── Step 5: Audit log ─────────────────────────────────────────────────────
  await auditLog(env, {
    userId:    user.id,
    orgId:     org.id,
    eventType: 'signup',
    eventData: {
      email,
      plan:              'free_trial',
      marketing_consent: marketingConsent,
    },
    ipAddress: ip,
  });

  return okRes(
    {
      user: {
        id:    user.id,
        email: user.email,
      },
      profile: {
        onboarding_completed: profile.onboarding_completed,
        plan:                 profile.plan,
        is_admin:             profile.is_admin,
      },
      organization: {
        id:        org.id,
        name:      org.name,
        plan_tier: org.plan_tier,
      },
      onboardingCompleted: false,
      // Return session token so the frontend can begin authenticated requests
      token: session?.access_token || null,
    },
    cors
  );
}

// Cleanup helper — removes an auth user on downstream failure
async function deleteAuthUser(supabaseUrl, serviceKey, userId) {
  try {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
  } catch (_) {}
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
