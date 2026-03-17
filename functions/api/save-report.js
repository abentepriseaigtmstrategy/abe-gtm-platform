/**
 * /api/save-report  —  POST
 * Spec-compliant wrapper around gtm.js action:save_strategy.
 * Accepts: { strategy, company_name }
 * Returns: { success: true, report_id }
 */
import { verifyAuth, corsHeaders, validate, sanitise, errRes, okRes } from './_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ company_name: 'string|required', strategy: 'required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { strategy, company_name } = body;

  // Delegate to /api/gtm save_strategy
  const baseUrl = new URL(request.url).origin;
  const token   = request.headers.get('Authorization') || '';

  // Build steps object from strategy fields
  const steps = {
    1: strategy.step_1_market    || null,
    2: strategy.step_2_tam       || null,
    3: strategy.step_3_icp       || null,
    4: strategy.step_4_sourcing  || null,
    5: strategy.step_5_keywords  || null,
    6: strategy.step_6_messaging || null,
  };

  try {
    const res = await fetch(`${baseUrl}/api/gtm`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        action:       'save_strategy',
        company_name: sanitise(company_name, 200),
        industry:     strategy.industry || null,
        steps,
        total_tokens: strategy.total_tokens || 0,
      }),
    });

    const data = await res.json();
    if (!res.ok) return errRes(data.error || 'Save failed', res.status, cors);

    return okRes({
      success:   true,
      report_id: data.strategy_id,
    }, cors);

  } catch (e) {
    return errRes('Save failed: ' + e.message, 502, cors);
  }
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
