/**
 * functions/api/magic-link.js
 * POST /api/magic-link
 *
 * Sends a Supabase magic link (OTP) email to the user.
 * After clicking the link in their email, the user lands on
 * /auth-callback.html where the token is captured.
 */

import { corsHeaders, validate, sanitise, okRes, errRes } from '../_middleware.js';

export async function onRequestPost({ request, env }) {
  const cors        = corsHeaders(env);
  const supabaseUrl = env.SUPABASE_URL;
  const anonKey     = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return errRes('Server misconfiguration: SUPABASE_URL or SUPABASE_ANON_KEY not set', 503, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ email: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const email      = sanitise(body.email, 254).toLowerCase();
  const redirectTo = body.redirect_to || `${supabaseUrl.replace('.supabase.co', '.pages.dev')}/auth-callback.html`;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errRes('Invalid email address', 400, cors);
  }

  // Send magic link via Supabase OTP
  const res = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body:    JSON.stringify({
      email,
      create_user:  true,
      options: {
        email_redirect_to: 'https://abe-gtm-platform.pages.dev/auth-callback.html',
      },
    }),
  });

  // Supabase returns 200 with empty body on success (not JSON)
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    return errRes(errData.error?.message || 'Failed to send magic link', res.status, cors);
  }

  return okRes({ success: true, message: `Magic link sent to ${email}` }, cors);
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
