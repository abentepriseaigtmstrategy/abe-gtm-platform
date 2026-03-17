/**
 * /api/strategy  —  POST
 * Thin wrapper: runs all 6 GTM steps sequentially and returns the full strategy.
 * Used by index.html "Generate Strategy" button per the spec.
 * Heavy lifting lives in gtm.js (action: run_step / save_strategy).
 */
import { verifyAuth, corsHeaders, validate, rateLimit, sanitise, errRes, okRes } from './_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const openaiKey = env.OPENAI_API_KEY;
  if (!openaiKey) return errRes('OpenAI not configured', 503, cors);

  if (!await rateLimit(`strategy:${user.id}`, env, 5, 60_000)) {
    return errRes('Rate limit: max 5 full strategies per minute', 429, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ company_name: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const company  = sanitise(body.company_name, 200);
  const industry = body.industry ? sanitise(body.industry, 100) : '';

  // Run all 6 steps by delegating to the /api/gtm endpoint internally
  const baseUrl = new URL(request.url).origin;
  const token   = request.headers.get('Authorization') || '';

  const steps = {};
  for (let step = 1; step <= 6; step++) {
    try {
      const res = await fetch(`${baseUrl}/api/gtm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({
          action:      'run_step',
          step,
          company,
          industry,
          prior_steps: steps,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        return errRes(`Step ${step} failed: ${e.error || res.status}`, res.status, cors);
      }
      const data = await res.json();
      steps[step] = data.data;
    } catch (e) {
      return errRes(`Step ${step} error: ${e.message}`, 502, cors);
    }
  }

  const strategy = {
    company_name:      company,
    industry:          industry || null,
    steps_completed:   6,
    step_1_market:     steps[1] || {},
    step_2_tam:        steps[2] || {},
    step_3_icp:        steps[3] || {},
    step_4_sourcing:   steps[4] || {},
    step_5_keywords:   steps[5] || {},
    step_6_messaging:  steps[6] || {},
  };

  return okRes({ strategy }, cors);
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
