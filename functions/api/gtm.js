/**
 * /api/gtm  (v2)
 * Cloudflare Pages Function — GTM Strategy Engine
 *
 * All routes require JWT.
 * KV caching layer added for completed strategies.
 * Vault routes now support pagination, deletion, archive, resume.
 */

import { verifyAuth, corsHeaders, validate, rateLimit, sanitise, errRes, okRes, kv } from './_middleware.js';

const COST_PER_TOKEN   = 0.0000002;
const HOURLY_TOKEN_LIMIT = 200_000;
const STEP_MAX_TOKENS = { 1:1500, 2:1500, 3:1500, 4:1500, 5:2000, 6:2500, 7:2500 };

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // ── Auth — required on every action ────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const openaiKey   = env.OPENAI_API_KEY;
  const supabaseUrl = env.SUPABASE_URL      || 'https://cwcvneluhlimhlzowabv.supabase.co';
  // Service role key from Cloudflare env secrets
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!openaiKey) return errRes('OpenAI not configured', 503, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ action: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  // ── Per-user rate limiting ──────────────────────────────────────
  if (!await rateLimit(`gtm:${user.id}`, env, 60, 60_000)) {
    return errRes('Rate limit reached. Please wait before making more requests.', 429, cors);
  }

  const userId = user.id;

  switch (body.action) {
    case 'run_step':        return handleRunStep(body, userId, openaiKey, supabaseUrl, supabaseKey, env, cors);
    case 'save_strategy':   return handleSaveStrategy(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'get_vault':       return handleGetVault(body, userId, supabaseUrl, supabaseKey, cors);
    case 'get_strategy':    return handleGetStrategy(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'delete_strategy': return handleDeleteStrategy(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'archive_strategy':return handleArchiveStrategy(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'resume_strategy': return handleResumeStrategy(body, userId, supabaseUrl, supabaseKey, cors);
    case 'check_cache':     return handleCheckCache(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'score_leads':     return handleScoreLeads(body, userId, openaiKey, cors);
    case 'run_step7':       return handleRunStep7(body, userId, openaiKey, supabaseUrl, supabaseKey, env, cors);
    case 'save_step7':      return handleSaveStep7(body, userId, supabaseUrl, supabaseKey, env, cors);
    default:                return errRes(`Unknown action: ${body.action}`, 400, cors);
  }
}

// ══════════════════════════════════════════════════════════════════
// RUN STEP
// ══════════════════════════════════════════════════════════════════
async function handleRunStep(body, userId, openaiKey, supabaseUrl, supabaseKey, env, cors) {
  const errors = validate({
    step:    'number|required',
    company: 'string|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { step, company, industry, prior_steps, company_profile } = body;
  if (step < 1 || step > 6) return errRes('Step must be 1–6', 400, cors);

  // Hourly token limit check
  if (supabaseUrl && supabaseKey) {
    if (await isHourlyLimitExceeded(userId, supabaseUrl, supabaseKey)) {
      return errRes('Hourly token limit reached. Resets at the top of the hour.', 429, cors);
    }
  }

  // Check KV step cache (company+step)
  const stepCacheKey = `step:${await hash(company.toLowerCase())}:${step}`;
  const stepCached   = await kv.get(env, stepCacheKey);
  if (stepCached) {
    return okRes({ data: stepCached, tokens: 0, duration_ms: 0, step, _cached: true }, cors);
  }

  const prompt = buildStepPrompt(step, sanitise(company, 200), industry || '', prior_steps || {}, company_profile || null);
  const t0     = Date.now();

  let rawText, tokensUsed;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        temperature: step === 6 ? 0.8 : 0.3,
        max_tokens:  STEP_MAX_TOKENS[step],
        messages: [
          { role: 'system', content: 'You are a world-class B2B GTM strategist. Return ONLY valid JSON. No markdown, no prose.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      if (res.status === 429) return errRes('OpenAI rate limit reached. Please wait a moment.', 429, cors);
      return errRes(`OpenAI error: ${e?.error?.message || res.status}`, res.status, cors);
    }
    const d  = await res.json();
    rawText  = d.choices?.[0]?.message?.content || '{}';
    tokensUsed = d.usage?.total_tokens || 0;
  } catch (e) {
    return errRes('Failed to reach OpenAI: ' + e.message, 502, cors);
  }

  // Parse with retry
  let parsed = await parseWithRetry(rawText, step, prompt, openaiKey);
  if (!parsed) return errRes('AI returned unparseable response after retry', 422, cors);

  const duration = Date.now() - t0;

  // Cache in KV (1hr TTL for steps)
  await kv.put(env, stepCacheKey, parsed, 3600);

  // Log + rate limit update (non-blocking)
  if (supabaseUrl && supabaseKey) {
    logRun(userId, null, 'gtm_step', step, company, tokensUsed, duration, false, supabaseUrl, supabaseKey);
    bumpHourlyTokens(userId, tokensUsed, supabaseUrl, supabaseKey);
  }

  return okRes({ data: parsed, tokens: tokensUsed, duration_ms: duration, step }, cors);
}

// ══════════════════════════════════════════════════════════════════
// SAVE STRATEGY
// ══════════════════════════════════════════════════════════════════
async function handleSaveStrategy(body, userId, supabaseUrl, supabaseKey, env, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  const errors = validate({ company_name: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { company_name, industry, steps, total_tokens, company_url, scraped_profile, full_report, step_7_intelligence } = body;
  const cacheKey = await hash(company_name.toLowerCase().trim());

  const stepsCompleted = Object.values(steps || {}).filter(Boolean).length;
  const status = stepsCompleted === 6 ? 'complete' : 'in_progress';

  const payload = {
    user_id:          userId,
    company_name:     sanitise(company_name, 200),
    industry:         industry ? sanitise(industry, 100) : null,
    company_url:      company_url || null,
    scraped_profile:  scraped_profile || {},
    step_1_market:    steps?.[1] || null,
    step_2_tam:       steps?.[2] || null,
    step_3_icp:       steps?.[3] || null,
    step_4_sourcing:  steps?.[4] || null,
    step_5_keywords:  steps?.[5] || null,
    step_6_messaging: steps?.[6] || null,
    step_7_intelligence: step_7_intelligence || null,
    steps_completed:  stepsCompleted,
    total_tokens:     total_tokens || 0,
    status,
    cache_key:        cacheKey,
    updated_at:       new Date().toISOString(),
    full_report:      full_report || null,
  };

  // FIX: Must pass resolution=merge-duplicates so subsequent step saves UPDATE the row
  // instead of being silently ignored. Without this, steps 2-6 never persisted.
  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'POST',
    JSON.stringify(payload), '?on_conflict=cache_key',
    'return=representation,resolution=merge-duplicates');

  if (!res.ok) {
    const e = await res.text();
    return errRes('Failed to save strategy: ' + e, 500, cors);
  }

  const saved = await res.json();
  const strategyId = Array.isArray(saved) ? saved[0]?.id : saved?.id;

  // Cache complete strategy in KV
  if (status === 'complete' && strategyId) {
    await kv.put(env, `strategy:${cacheKey}`, payload, 86400);
  }

  // Save sub-tables (non-blocking)
  if (strategyId) {
    if (steps?.[3]) saveICP(strategyId, userId, company_name, steps[3], supabaseUrl, supabaseKey);
    if (steps?.[5]) saveKeywords(strategyId, userId, company_name, steps[5], supabaseUrl, supabaseKey);
    if (steps?.[6]) saveMessaging(strategyId, userId, company_name, steps[6], supabaseUrl, supabaseKey);
  }

  return okRes({ strategy_id: strategyId, cache_key: cacheKey, status, steps_completed: stepsCompleted }, cors);
}

// ══════════════════════════════════════════════════════════════════
// GET VAULT — paginated with filters, sorting
// ══════════════════════════════════════════════════════════════════
async function handleGetVault(body, userId, supabaseUrl, supabaseKey, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  const { search, status, sort = 'updated_at', limit = 24, offset = 0 } = body;
  const validSort   = ['updated_at','created_at','company_name','total_tokens'];
  const sortField   = validSort.includes(sort) ? sort : 'updated_at';

  let query = `?user_id=eq.${userId}&order=${sortField}.desc&limit=${limit}&offset=${offset}`;
  if (status && ['complete','in_progress','archived'].includes(status)) {
    query += `&status=eq.${status}`;
  } else {
    // Default: exclude archived
    query += `&status=neq.archived`;
  }
  if (search) {
    query += `&company_name=ilike.*${encodeURIComponent(sanitise(search, 100))}*`;
  }

  // Use summary view — lighter payload
  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategy_summary', 'GET', null, query);
  if (!res.ok) {
    const errBody = await res.text().catch(() => 'unreadable');
    console.error('VAULT_ERROR:', res.status, errBody);
    return errRes('Failed to fetch vault: ' + errBody, 500, cors);
  }
  const data = await res.json();

  // Get total count (for pagination UI)
  let totalQuery = `?user_id=eq.${userId}&select=id&status=neq.archived`;
  if (status) totalQuery = `?user_id=eq.${userId}&select=id&status=eq.${status}`;
  const countRes = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'GET', null, totalQuery);
  const countData = countRes.ok ? await countRes.json() : [];

  return okRes({
    strategies:  data,
    total:       countData.length,
    limit,
    offset,
    has_more:    offset + data.length < countData.length,
  }, cors);
}

// ══════════════════════════════════════════════════════════════════
// GET STRATEGY — full record
// ══════════════════════════════════════════════════════════════════
async function handleGetStrategy(body, userId, supabaseUrl, supabaseKey, env, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  const errors = validate({ strategy_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'GET', null,
    `?id=eq.${sanitise(body.strategy_id, 36)}&user_id=eq.${userId}&limit=1`);
  if (!res.ok) return errRes('Failed to fetch strategy', 500, cors);

  const data = await res.json();
  if (!data.length) return errRes('Strategy not found', 404, cors);

  // Update last_viewed_at (non-blocking)
  sbFetch(supabaseUrl, supabaseKey, 'strategies', 'PATCH',
    JSON.stringify({ last_viewed_at: new Date().toISOString() }),
    `?id=eq.${body.strategy_id}&user_id=eq.${userId}`);

  return okRes({ strategy: data[0] }, cors);
}

// ══════════════════════════════════════════════════════════════════
// DELETE STRATEGY
// ══════════════════════════════════════════════════════════════════
async function handleDeleteStrategy(body, userId, supabaseUrl, supabaseKey, env, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  const errors = validate({ strategy_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const id = sanitise(body.strategy_id, 36);

  // Get cache_key before deleting (to bust KV)
  const getRes = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'GET', null,
    `?id=eq.${id}&user_id=eq.${userId}&select=cache_key&limit=1`);
  if (getRes.ok) {
    const rows = await getRes.json();
    if (rows[0]?.cache_key) {
      await kv.del(env, `strategy:${rows[0].cache_key}`);
    }
  }

  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'DELETE', null,
    `?id=eq.${id}&user_id=eq.${userId}`);
  if (!res.ok) return errRes('Failed to delete strategy', 500, cors);
  return okRes({ deleted: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// ARCHIVE / RESTORE STRATEGY
// ══════════════════════════════════════════════════════════════════
async function handleArchiveStrategy(body, userId, supabaseUrl, supabaseKey, env, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);
  const errors = validate({ strategy_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const newStatus = body.restore ? 'complete' : 'archived';
  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'PATCH',
    JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() }),
    `?id=eq.${sanitise(body.strategy_id, 36)}&user_id=eq.${userId}`);
  if (!res.ok) return errRes('Failed to update strategy', 500, cors);
  return okRes({ status: newStatus }, cors);
}

// ══════════════════════════════════════════════════════════════════
// RESUME STRATEGY — get incomplete step context
// ══════════════════════════════════════════════════════════════════
async function handleResumeStrategy(body, userId, supabaseUrl, supabaseKey, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);
  const errors = validate({ strategy_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'GET', null,
    `?id=eq.${sanitise(body.strategy_id, 36)}&user_id=eq.${userId}&limit=1`);
  if (!res.ok) return errRes('Failed to fetch strategy', 500, cors);
  const data = await res.json();
  if (!data.length) return errRes('Strategy not found', 404, cors);

  const s = data[0];
  const steps = {
    1: s.step_1_market,
    2: s.step_2_tam,
    3: s.step_3_icp,
    4: s.step_4_sourcing,
    5: s.step_5_keywords,
    6: s.step_6_messaging,
  };

  const nextStep = [1,2,3,4,5,6].find(i => !steps[i]) || 6;

  return okRes({
    strategy_id:    s.id,
    company_name:   s.company_name,
    industry:       s.industry,
    company_url:    s.company_url,
    scraped_profile: s.scraped_profile,
    steps,
    steps_completed: s.steps_completed,
    next_step:       nextStep,
    total_tokens:    s.total_tokens,
    step_7_intelligence: s.step_7_intelligence || null,
  }, cors);
}

// ══════════════════════════════════════════════════════════════════
// CHECK CACHE — returns existing complete strategy if found
// ══════════════════════════════════════════════════════════════════
async function handleCheckCache(body, userId, supabaseUrl, supabaseKey, env, cors) {
  const errors = validate({ company_name: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const cacheKey = await hash(body.company_name.toLowerCase().trim());

  // Check KV first (fastest)
  const kvHit = await kv.get(env, `strategy:${cacheKey}`);
  if (kvHit) return okRes({ cached: true, source: 'kv', strategy: kvHit }, cors);

  // Check Supabase
  if (supabaseUrl && supabaseKey) {
    const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'GET', null,
      `?cache_key=eq.${cacheKey}&user_id=eq.${userId}&status=eq.complete&limit=1`);
    if (res.ok) {
      const data = await res.json();
      if (data.length) return okRes({ cached: true, source: 'db', strategy: data[0], updated_at: data[0].updated_at }, cors);
    }
  }

  return okRes({ cached: false, strategy: null }, cors);
}

// ══════════════════════════════════════════════════════════════════
// SCORE LEADS (simple action — deterministic scoring only)
// ══════════════════════════════════════════════════════════════════
async function handleScoreLeads(body, userId, openaiKey, cors) {
  const errors = validate({ leads: 'array|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { leads, icp_context } = body;
  if (leads.length > 50) return errRes('Max 50 leads per request. Use /api/leads for batch scoring.', 400, cors);

  const BATCH = 10;
  const results = [];

  for (let i = 0; i < leads.length; i += BATCH) {
    const batch  = leads.slice(i, i + BATCH);
    const scored = await scoreBatch(batch, icp_context || '', openaiKey);
    results.push(...scored);
  }

  return okRes({ scored_leads: results, total: results.length }, cors);
}

// ══════════════════════════════════════════════════════════════════
// RUN STEP 7 — Revenue Intelligence Enhancement (optional post-processing)
// ══════════════════════════════════════════════════════════════════
async function handleRunStep7(body, userId, openaiKey, supabaseUrl, supabaseKey, env, cors) {
  const errors = validate({
    company: 'string|required',
    steps:   'object|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { company, industry, steps } = body;

  // Require at least Step 1 & 6 to be present — otherwise there's nothing to analyse
  if (!steps[1] || !steps[6]) {
    return errRes('Step 7 requires completed Steps 1–6. Run the full GTM flow first.', 400, cors);
  }

  // Hourly token limit check (non-blocking on failure)
  if (supabaseUrl && supabaseKey) {
    if (await isHourlyLimitExceeded(userId, supabaseUrl, supabaseKey)) {
      return errRes('Hourly token limit reached. Resets at the top of the hour.', 429, cors);
    }
  }

  // ── HALLUCINATION GUARD STEP 1: Measure actual data richness BEFORE calling AI ──
  // We calculate a "data richness score" purely from what exists in Steps 1-6.
  // This score is used to:
  //   a) Cap the AI's confidence_score (AI cannot claim higher confidence than data supports)
  //   b) Build an "evidence manifest" injected into the prompt so AI only references real fields
  const richness = measureDataRichness(steps);

  // ── HALLUCINATION GUARD STEP 2: Build evidence manifest ──────────────────────
  // Extract only the concrete facts that actually exist in the step data.
  // This manifest is injected into the prompt as the ONLY facts the AI may reference.
  // AI is explicitly told: if a fact is not in this manifest, do not mention it.
  const evidenceManifest = buildEvidenceManifest(steps);

  const prompt = buildStep7Prompt(sanitise(company, 200), industry || '', steps, evidenceManifest);
  const t0 = Date.now();

  let rawText, tokensUsed;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        temperature: 0.2,   // Lower temperature = less creative hallucination
        max_tokens:  STEP_MAX_TOKENS[7],
        messages: [
          {
            role: 'system',
            content: [
              'You are a senior revenue intelligence analyst.',
              'CRITICAL ANTI-HALLUCINATION RULES — VIOLATION = INVALID OUTPUT:',
              '1. You may ONLY reference facts that appear in the EVIDENCE MANIFEST provided. Do not invent company details, competitor names, funding amounts, or growth metrics.',
              '2. signal_type MUST be one of exactly: hiring, funding, growth, tech_replacement, competitor_pressure, expansion, market_timing — no other values accepted.',
              '3. go_no_go.recommendation MUST be exactly one of: Go, Watch, No-Go — no other values accepted.',
              '4. signal strength MUST be exactly one of: High, Medium, Low — no other values accepted.',
              '5. If you cannot find evidence for a signal, omit it entirely rather than inventing one.',
              '6. Return ONLY valid JSON. No markdown, no prose, no code fences. Start with { end with }.',
            ].join('\n'),
          },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      if (res.status === 429) return errRes('OpenAI rate limit reached. Please wait a moment.', 429, cors);
      return errRes(`OpenAI error: ${e?.error?.message || res.status}`, res.status, cors);
    }
    const d  = await res.json();
    rawText    = d.choices?.[0]?.message?.content || '{}';
    tokensUsed = d.usage?.total_tokens || 0;
  } catch (e) {
    return errRes('Failed to reach OpenAI: ' + e.message, 502, cors);
  }

  // Parse Step 7 response
  let parsed = parseStep7(rawText);
  if (!parsed) return errRes('AI returned unparseable Step 7 response', 422, cors);

  // ── HALLUCINATION GUARD STEP 3: Server-side output sanitisation ──────────────
  // Enforce every enum, clamp every number, strip any field that violates the schema.
  // This runs AFTER the AI response — nothing untrusted reaches the frontend.
  parsed = sanitiseStep7Output(parsed, richness);

  const duration = Date.now() - t0;

  // Log usage (non-blocking)
  if (supabaseUrl && supabaseKey) {
    logRun(userId, null, 'gtm_step7', 7, company, tokensUsed, duration, false, supabaseUrl, supabaseKey);
    bumpHourlyTokens(userId, tokensUsed, supabaseUrl, supabaseKey);
  }

  return okRes({ data: parsed, tokens: tokensUsed, duration_ms: duration, step: 7 }, cors);
}

// ══════════════════════════════════════════════════════════════════
// HALLUCINATION GUARD — DATA RICHNESS MEASUREMENT
// Scores how much real data exists across Steps 1–6.
// Returns a number 0–100. Used to cap AI confidence_score.
// Formula: each step contributes proportional weight based on importance to Step 7.
// ══════════════════════════════════════════════════════════════════
function measureDataRichness(steps) {
  const weights = { 1: 25, 2: 15, 3: 25, 4: 10, 5: 10, 6: 15 }; // must sum to 100
  let score = 0;

  // Step 1 — Market Research (weight 25)
  if (steps[1]) {
    const s1 = steps[1];
    let pts = 0;
    if (s1.company_overview)    pts += 6;
    if (s1.growth_signals)      pts += 7;
    if (s1.market_position)     pts += 6;
    if (s1.gtm_relevance_score) pts += 6;
    score += Math.min(weights[1], pts);
  }

  // Step 2 — TAM Mapping (weight 15)
  if (steps[2]) {
    const s2 = steps[2];
    let pts = 0;
    if (s2.tam_size_estimate)        pts += 5;
    if (s2.growth_rate)              pts += 4;
    if (s2.priority_opportunities)   pts += 6;
    score += Math.min(weights[2], pts);
  }

  // Step 3 — ICP Modeling (weight 25)
  if (steps[3]) {
    const s3 = steps[3];
    let pts = 0;
    if (s3.primary_icp)           pts += 5;
    if (s3.core_pain_points)      pts += 6;
    if (s3.buying_triggers)       pts += 7;
    if (s3.decision_makers)       pts += 4;
    if (s3.objections)            pts += 3;
    score += Math.min(weights[3], pts);
  }

  // Step 4 — Account Sourcing (weight 10)
  if (steps[4]) {
    const s4 = steps[4];
    let pts = 0;
    if (s4.recommended_databases) pts += 5;
    if (s4.sourcing_playbook)      pts += 5;
    score += Math.min(weights[4], pts);
  }

  // Step 5 — Keywords (weight 10)
  if (steps[5]) {
    const s5 = steps[5];
    let pts = 0;
    if (s5.primary_keywords)  pts += 5;
    if (s5.intent_signals)    pts += 5;
    score += Math.min(weights[5], pts);
  }

  // Step 6 — Messaging (weight 15)
  if (steps[6]) {
    const s6 = steps[6];
    let pts = 0;
    if (s6.email_1)          pts += 5;
    if (s6.email_2)          pts += 4;
    if (s6.linkedin_message) pts += 6;
    score += Math.min(weights[6], pts);
  }

  return Math.round(score);
}

// ══════════════════════════════════════════════════════════════════
// HALLUCINATION GUARD — EVIDENCE MANIFEST BUILDER
// Extracts only concrete facts that ACTUALLY exist in the step data.
// This manifest is passed to the AI — it can ONLY reference these facts.
// ══════════════════════════════════════════════════════════════════
function buildEvidenceManifest(steps) {
  const facts = [];

  const add = (label, value) => {
    if (!value) return;
    if (Array.isArray(value) && value.length === 0) return;
    const v = Array.isArray(value) ? value.slice(0, 5).join(', ') : String(value).slice(0, 300);
    if (v.trim()) facts.push(`${label}: ${v}`);
  };

  if (steps[1]) {
    add('Company overview',       steps[1].company_overview);
    add('GTM relevance score',    steps[1].gtm_relevance_score);
    add('Growth signals',         steps[1].growth_signals);
    add('Market position',        steps[1].market_position);
    add('Revenue stage',          steps[1].revenue_stage);
    add('Tech stack hints',       steps[1].tech_stack_hints);
  }
  if (steps[2]) {
    add('TAM size',               steps[2].tam_size_estimate);
    add('Market growth rate',     steps[2].growth_rate);
    add('Priority opportunities', steps[2].priority_opportunities);
    add('Market maturity',        steps[2].market_maturity);
    add('Top market segments',    (steps[2].market_segments||[]).slice(0,3).map(s=>s.name||s));
  }
  if (steps[3]) {
    add('Primary ICP',            steps[3].primary_icp);
    add('Core pain points',       steps[3].core_pain_points);
    add('Buying triggers',        steps[3].buying_triggers);
    add('Decision makers',        steps[3].decision_makers);
    add('Key objections',         steps[3].objections);
    add('Deal cycle',             steps[3].deal_cycle);
  }
  if (steps[4]) {
    add('Recommended databases',  (steps[4].recommended_databases||[]).slice(0,3));
    add('Sourcing playbook',      steps[4].sourcing_playbook);
  }
  if (steps[5]) {
    add('Primary keywords',       (steps[5].primary_keywords||[]).slice(0,5));
    add('Intent signals',         steps[5].intent_signals);
  }
  if (steps[6]) {
    add('Email 1 angle',          steps[6].email_1?.angle);
    add('Email 1 subject',        steps[6].email_1?.subject);
    add('Email 2 angle',          steps[6].email_2?.angle);
    add('LinkedIn message angle', steps[6].linkedin_message ? steps[6].linkedin_message.slice(0,150) : null);
  }

  return facts.length > 0
    ? 'EVIDENCE MANIFEST (you may ONLY reference these facts):\n' + facts.map(f => `- ${f}`).join('\n')
    : 'EVIDENCE MANIFEST: Limited data available. Reflect this in a low confidence_score.';
}

// ══════════════════════════════════════════════════════════════════
// HALLUCINATION GUARD — SERVER-SIDE OUTPUT SANITISATION
// Enforces all enums, clamps all numbers, caps confidence by data richness.
// Runs after AI response. Nothing untrusted reaches the frontend.
// ══════════════════════════════════════════════════════════════════
const VALID_SIGNAL_TYPES  = new Set(['hiring','funding','growth','tech_replacement','competitor_pressure','expansion','market_timing']);
const VALID_STRENGTHS     = new Set(['High','Medium','Low']);
const VALID_GNG           = new Set(['Go','Watch','No-Go']);
const VALID_PERSONAS      = new Set(['CEO','Founder','CTO','CFO','COO','Head of Sales','Head of Marketing','VP Sales','VP Marketing','CMO','CRO','Director of Sales','Director of Marketing','Head of Growth','Head of Product','Head of Operations']);

function sanitiseStep7Output(d, richnessScore) {
  const out = {};

  // ── signal_summary: filter out invalid enums, keep max 5 ─────────
  const rawSignals = Array.isArray(d.signal_summary) ? d.signal_summary : [];
  out.signal_summary = rawSignals
    .filter(s => s && typeof s === 'object')
    .map(s => ({
      signal_type:        VALID_SIGNAL_TYPES.has(s.signal_type)  ? s.signal_type  : 'growth',
      signal_description: typeof s.signal_description === 'string' ? s.signal_description.slice(0, 400) : '',
      strength:           VALID_STRENGTHS.has(s.strength)        ? s.strength     : 'Medium',
    }))
    .filter(s => s.signal_description.length > 5)   // drop empty or nearly-empty
    .slice(0, 5);

  // ── why_now_analysis ──────────────────────────────────────────────
  out.why_now_analysis = typeof d.why_now_analysis === 'string'
    ? d.why_now_analysis.slice(0, 800)
    : 'Insufficient data to determine timing urgency.';

  // ── mcc_view ─────────────────────────────────────────────────────
  const mcc = d.mcc_view && typeof d.mcc_view === 'object' ? d.mcc_view : {};
  out.mcc_view = {
    market:     typeof mcc.market     === 'string' ? mcc.market.slice(0,400)     : 'No market data available.',
    client:     typeof mcc.client     === 'string' ? mcc.client.slice(0,400)     : 'No client data available.',
    competitor: typeof mcc.competitor === 'string' ? mcc.competitor.slice(0,400) : 'No competitor data available.',
  };

  // ── strategic_hook ────────────────────────────────────────────────
  out.strategic_hook = typeof d.strategic_hook === 'string'
    ? d.strategic_hook.slice(0, 300)
    : '';

  // ── persona_priority ─────────────────────────────────────────────
  const pp = d.persona_priority && typeof d.persona_priority === 'object' ? d.persona_priority : {};
  const rawPersona = typeof pp.persona === 'string' ? pp.persona.trim() : 'CEO';
  // Accept AI persona if it's in our valid list, otherwise fall back to nearest match or CEO
  const matchedPersona = [...VALID_PERSONAS].find(p => p.toLowerCase() === rawPersona.toLowerCase()) || rawPersona;
  out.persona_priority = {
    persona: matchedPersona.slice(0, 80),
    reason:  typeof pp.reason === 'string' ? pp.reason.slice(0, 400) : '',
  };

  // ── go_no_go ──────────────────────────────────────────────────────
  const gng = d.go_no_go && typeof d.go_no_go === 'object' ? d.go_no_go : {};
  const rawRec = typeof gng.recommendation === 'string' ? gng.recommendation.trim() : 'Watch';
  // Normalise common variations like "No Go" → "No-Go", "no-go" → "No-Go"
  const normRec = rawRec.replace(/\s+/g, '-').replace(/^no-go$/i,'No-Go').replace(/^watch$/i,'Watch').replace(/^go$/i,'Go');
  out.go_no_go = {
    recommendation: VALID_GNG.has(normRec) ? normRec : 'Watch',
    reason:         typeof gng.reason === 'string' ? gng.reason.slice(0, 400) : '',
  };

  // ── confidence_score: AI value is capped by measured data richness ─
  // The AI cannot claim higher confidence than the data supports.
  // Example: AI says 85, but data richness = 40 → capped at 40.
  // This prevents the AI from expressing false certainty on thin data.
  const aiScore = typeof d.confidence_score === 'number'
    ? d.confidence_score
    : parseInt(d.confidence_score) || 50;
  const clampedAI  = Math.max(0, Math.min(100, aiScore));
  const maxAllowed = richnessScore; // data richness is the hard ceiling
  out.confidence_score = Math.min(clampedAI, maxAllowed);

  // ── executive_brief ───────────────────────────────────────────────
  out.executive_brief = typeof d.executive_brief === 'string'
    ? d.executive_brief.slice(0, 800)
    : '';

  // ── Attach data quality metadata (shown in UI as audit trail) ─────
  out._data_quality = {
    richness_score:          richnessScore,
    signals_before_filter:   rawSignals.length,
    signals_after_filter:    out.signal_summary.length,
    confidence_ai_claimed:   clampedAI,
    confidence_after_cap:    out.confidence_score,
  };

  return out;
}

// ══════════════════════════════════════════════════════════════════
// SAVE STEP 7 — persist intelligence to existing strategy row
// ══════════════════════════════════════════════════════════════════
async function handleSaveStep7(body, userId, supabaseUrl, supabaseKey, env, cors) {
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  const errors = validate({
    strategy_id:         'string|required',
    step_7_intelligence: 'object|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { strategy_id, step_7_intelligence } = body;

  const res = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'PATCH',
    JSON.stringify({ step_7_intelligence, updated_at: new Date().toISOString() }),
    `?id=eq.${sanitise(strategy_id, 36)}&user_id=eq.${userId}`);

  if (!res.ok) {
    const e = await res.text();
    return errRes('Failed to save Step 7: ' + e, 500, cors);
  }

  return okRes({ saved: true, strategy_id }, cors);
}

// ══════════════════════════════════════════════════════════════════
// STEP 7 PROMPT BUILDER
// ══════════════════════════════════════════════════════════════════
function buildStep7Prompt(company, industry, steps, evidenceManifest) {
  const ind = industry ? ` (${industry})` : '';

  // Compress each step into a concise block to stay within token limits
  const s1 = steps[1] ? {
    overview:     steps[1].company_overview,
    gtm_score:    steps[1].gtm_relevance_score,
    growth:       steps[1].growth_signals,
    revenue_stage:steps[1].revenue_stage,
    tech_stack:   steps[1].tech_stack_hints,
    market_pos:   steps[1].market_position,
  } : null;

  const s2 = steps[2] ? {
    tam:           steps[2].tam_size_estimate,
    growth_rate:   steps[2].growth_rate,
    segments:      (steps[2].market_segments || []).slice(0, 3).map(s => s.name),
    opportunities: steps[2].priority_opportunities,
    maturity:      steps[2].market_maturity,
  } : null;

  const s3 = steps[3] ? {
    primary_icp:   steps[3].primary_icp,
    pains:         steps[3].core_pain_points,
    triggers:      steps[3].buying_triggers,
    decision_makers: steps[3].decision_makers,
    objections:    steps[3].objections,
    deal_cycle:    steps[3].deal_cycle,
  } : null;

  const s4 = steps[4] ? {
    databases:     (steps[4].recommended_databases || []).slice(0, 3),
    playbook:      steps[4].sourcing_playbook,
  } : null;

  const s5 = steps[5] ? {
    primary_kw:    steps[5].primary_keywords,
    intent_signals: steps[5].intent_signals,
  } : null;

  const s6 = steps[6] ? {
    email_angles:  [steps[6].email_1?.angle, steps[6].email_2?.angle, steps[6].email_3?.angle].filter(Boolean),
    hook_subject:  steps[6].email_1?.subject,
    linkedin_msg:  steps[6].linkedin_message,
  } : null;

  const inputBlock = JSON.stringify({ company, s1, s2, s3, s4, s5, s6 }, null, 1);

  return `You are a senior revenue intelligence analyst. Analyse the GTM data for "${company}"${ind} and produce a Revenue Intelligence Enhancement report.

GTM DATA (compressed):
${inputBlock}

${evidenceManifest || ''}

ANALYSIS RULES:
- ONLY reference facts listed in the EVIDENCE MANIFEST above. Never invent company details, funding amounts, competitor names, or growth metrics.
- If a signal is not evidenced by the manifest, omit it entirely. Do not fabricate.
- signal_type MUST be one of: hiring, funding, growth, tech_replacement, competitor_pressure, expansion, market_timing
- signal strength MUST be one of: High, Medium, Low
- Include 2-4 signals only. Quality over quantity.
- go_no_go recommendation MUST be exactly "Go", "Watch", or "No-Go" — nothing else
- strategic_hook must be ONE crisp sentence usable in a cold email opener — max 30 words
- executive_brief must be 3-4 sentences. Board-ready. No fluff.
- why_now_analysis must be ONE clear paragraph explaining timing urgency — grounded in evidence only

Return ONLY this JSON (no markdown, no prose):
{
  "signal_summary": [
    {"signal_type": "growth", "signal_description": "...", "strength": "High"}
  ],
  "why_now_analysis": "...",
  "mcc_view": {
    "market": "...",
    "client": "...",
    "competitor": "..."
  },
  "strategic_hook": "...",
  "persona_priority": {
    "persona": "...",
    "reason": "..."
  },
  "go_no_go": {
    "recommendation": "Go",
    "reason": "..."
  },
  "confidence_score": 82,
  "executive_brief": "..."
}`;
}

function parseStep7(rawText) {
  if (!rawText) return null;
  const clean = rawText.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  // Handle truncation
  let s = m[0];
  const opens  = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  if (opens > closes) {
    s = s + '}'.repeat(opens - closes);
    try { return JSON.parse(s); } catch {}
  }
  return null;
}

// ── Prompt builder ───────────────────────────────────────────────
function buildStepPrompt(step, company, industry, priorSteps, companyProfile) {
  const ind  = industry ? ` in the ${industry} industry` : '';
  const ctx  = buildContext(step, priorSteps);
  const base = `You are a world-class B2B GTM strategist. CRITICAL: Return ONLY a valid JSON object. No markdown. No code fences. Start with { end with }.`;

  // Inject verified profile if available and high confidence
  const hasProfile = companyProfile && companyProfile.extraction_confidence !== 'LOW' && companyProfile.company_overview;
  const profileBlock = hasProfile
    ? `\nVERIFIED WEBSITE PROFILE (ground truth — use this, do not contradict it):\n${JSON.stringify({
        overview: companyProfile.company_overview,
        services: companyProfile.services,
        industry: companyProfile.industry,
        target_market: companyProfile.target_market,
        tech_stack: companyProfile.tech_stack_hints,
        value_props: companyProfile.value_propositions,
      }, null, 2)}\n`
    : '';

  const prompts = {
    1:`${base}${profileBlock}
Perform deep market research on "${company}"${ind}.${hasProfile ? ' Use the verified profile as your primary source.' : ''}

Score this company as an ABE GTM target (0-100).
ABE sells AI-powered GTM intelligence and lead orchestration platforms to B2B companies.
ABE's ideal buyer: IT services firms, SaaS companies, consulting firms, B2B enterprises with sales teams.

Scoring rules — read carefully:
- Score based on ACTUAL fit, not general quality. A great company in the wrong sector scores low.
- Every company must get a UNIQUE score reflecting their specific situation.
- Never round to 75, 80, 85, 90. Use specific numbers like 67, 73, 82, 91, 44, 28.
- B2C companies (retail, food, fashion, hospitality, consumer apps): score 5-25
- Government, NGO, non-profit, education: score 10-30
- Healthcare/pharma with no IT sales focus: score 20-40
- Financial services (banks, insurance) with no tech arm: score 30-50
- IT services, SaaS, tech consulting (small <50 people): score 52-68
- IT services, SaaS, tech consulting (mid 50-500 people): score 69-84
- IT services, SaaS, tech consulting (large >500 people): score 85-96
- Mixed/unclear industry: score 35-55

Examples of correct scoring:
- Accenture (large IT consulting): 94
- A 30-person SaaS startup: 71
- McDonald's (B2C food): 8
- H&M (retail fashion): 4
- A law firm: 38
- Marriott Hotels: 22
- Mid-size fintech SaaS: 76

Never give the same score to different companies. Be specific and honest.
Return:{"company_overview":"2-3 sentences","market_position":"competitive position","products_services":"main offerings","gtm_relevance_score":<integer 0-100 based on rubric above>,"gtm_relevance_reasoning":"specific reasoning for this exact score","growth_signals":["s1","s2","s3"],"revenue_stage":"e.g. Series B","employee_count":"range","tech_stack_hints":["hint1"]}`,

    2:`${base}${profileBlock}
TAM mapping for companies selling TO/partnering with "${company}"${ind}.
Context: ${ctx}
Return:{"tam_overview":"market description","tam_size_estimate":"$Xb","sam_estimate":"SAM","growth_rate":"X% CAGR","growth_drivers":"drivers","market_segments":[{"name":"Seg","size":"$Xm","priority":"High"}],"priority_opportunities":"top opps","market_maturity":"Growth"}`,

    3:`${base}${profileBlock}
Build ICP for companies selling TO "${company}"${ind}.
Context: ${ctx}
Return:{"primary_icp":"persona","secondary_icp":"secondary","firmographics":"size/ARR/industry","buying_triggers":["t1","t2"],"core_pain_points":"3 pains","decision_makers":["VP Sales"],"deal_cycle":"cycle","objections":["obj1"]}`,

    4:`${base}
Account sourcing strategy for "${company}"${ind}.
Context: ${ctx}
Return:{"recommended_databases":["Apollo.io","ZoomInfo"],"filter_criteria":"filters","sourcing_playbook":"steps","exclusion_criteria":"exclusions","estimated_universe":"est","data_enrichment_tips":"tips"}`,

    5:`${base}
Keywords for "${company}"${ind}.
Context: ${ctx}
Return:{"primary_keywords":["kw1","kw2","kw3","kw4","kw5","kw6"],"secondary_keywords":["k1","k2","k3","k4","k5","k6","k7","k8"],"boolean_query":"\"kw\" OR \"kw2\"","linkedin_search_strings":"LI string","intent_signals":["s1","s2","s3"],"content_topics":["t1","t2","t3"]}`,

    6:`${base}
Hyper-personalised outreach for "${company}"${ind}. Use ALL prior context.
Context: ${buildCompressedCtx(priorSteps)}
Return:{"email_1":{"angle":"Pain","subject":"subj","body":"body","cta":"cta"},"email_2":{"angle":"ROI","subject":"s","body":"b","cta":"c"},"email_3":{"angle":"Proof","subject":"s","body":"b","cta":"c"},"follow_up_sequence":"Day 3: action. Day 7: action. Day 14: action.","linkedin_message":"<300 chars","linkedin_follow_up":"<200 chars"}`,
  };

  return prompts[step];
}

function buildContext(step, steps) {
  const L = {1:'Market Research',2:'TAM',3:'ICP',4:'Account Sourcing',5:'Keywords'};
  return Array.from({length:step-1},(_,i)=>i+1)
    .filter(i=>steps[i])
    .map(i=>`[Step ${i} — ${L[i]}]\n${JSON.stringify(steps[i])}`)
    .join('\n\n') || 'No prior context.';
}

function buildCompressedCtx(steps) {
  const lines = [];
  const d = n => steps[n];
  if (d(1)) { lines.push(`COMPANY: ${d(1).company_overview||''}`); lines.push(`GTM SCORE: ${d(1).gtm_relevance_score||''}`); lines.push(`GROWTH: ${(d(1).growth_signals||[]).join(', ')}`); }
  if (d(2)) { lines.push(`TAM: ${d(2).tam_size_estimate||''} (${d(2).growth_rate||''})`); lines.push(`SEGMENTS: ${(d(2).market_segments||[]).slice(0,3).map(s=>s.name).join(', ')}`); }
  if (d(3)) { lines.push(`ICP: ${d(3).primary_icp||''}`); lines.push(`PAINS: ${d(3).core_pain_points||''}`); lines.push(`TRIGGERS: ${(d(3).buying_triggers||[]).join(', ')}`); lines.push(`OBJECTIONS: ${(d(3).objections||[]).join(', ')}`); }
  if (d(4)) { lines.push(`DBs: ${(d(4).recommended_databases||[]).slice(0,3).join(', ')}`); }
  if (d(5)) { lines.push(`KWS: ${(d(5).primary_keywords||[]).join(', ')}`); lines.push(`BOOLEAN: ${d(5).boolean_query||''}`); }
  return lines.join('\n');
}

const SCHEMAS = {
  1:['company_overview','market_position','products_services','gtm_relevance_score','growth_signals'],
  2:['tam_overview','tam_size_estimate','growth_rate','market_segments','priority_opportunities'],
  3:['primary_icp','secondary_icp','firmographics','buying_triggers','core_pain_points'],
  4:['recommended_databases','filter_criteria','sourcing_playbook','exclusion_criteria'],
  5:['primary_keywords','secondary_keywords','boolean_query','linkedin_search_strings'],
  6:['email_1','email_2','email_3','follow_up_sequence'],
};

async function parseWithRetry(rawText, step, originalPrompt, openaiKey) {
  const parse = text => {
    if (!text) return null;
    // Remove markdown fences
    const clean = text.replace(/```json|```/g,'').trim();
    // Try direct parse first
    try { return JSON.parse(clean); } catch {}
    // Extract largest JSON object
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch {}
    // Handle truncated JSON: try to close unclosed structure
    let s = m[0];
    const opens = (s.match(/\{/g)||[]).length;
    const closes = (s.match(/\}/g)||[]).length;
    if (opens > closes) {
      s = s + '}'.repeat(opens - closes);
      try { return JSON.parse(s); } catch {}
    }
    // Last resort: extract field by field
    const result = {};
    const fieldPattern = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\{[^}]*\}|[^,}]+)/g;
    let match;
    while ((match = fieldPattern.exec(s)) !== null) {
      try { result[match[1]] = JSON.parse(match[2]); } catch { result[match[1]] = match[2].replace(/^"|"$/g,''); }
    }
    return Object.keys(result).length > 0 ? result : null;
  };

  let parsed = parse(rawText);
  if (!parsed) return null;

  const missing = (SCHEMAS[step]||[]).filter(k => !(k in parsed));
  if (missing.length === 0) return parsed;

  // One retry with explicit field reminder
  try {
    const retry = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.2, max_tokens: STEP_MAX_TOKENS[step],
        messages: [
          { role: 'system', content: 'Return ONLY valid JSON.' },
          { role: 'user',   content: originalPrompt + `\n\nIMPORTANT: Your response was missing: ${missing.join(', ')}. Include ALL fields.` },
        ],
      }),
    });
    const d   = await retry.json();
    const raw = d.choices?.[0]?.message?.content || '{}';
    return parse(raw) || parsed;
  } catch { return parsed; }
}

// ── Score batch ──────────────────────────────────────────────────
async function scoreBatch(leads, icpCtx, openaiKey) {
  const prompt = `Score these B2B leads 0-100.
${icpCtx?`ICP:\n${icpCtx}\n`:''}
Leads:
${leads.map((l,i)=>`${i}. ${l.name||'?'} | ${l.title||'?'} | ${l.company||'?'}`).join('\n')}
Return ONLY JSON array: [{"index":0,"score":<integer 0-100>,"priority":"HIGH|MEDIUM|LOW","reason":"one sentence"},...] Priority: HIGH(≥75) MEDIUM(50-74) LOW(<50). Score each lead individually based on their actual title and company — do NOT use the same score for all leads.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${openaiKey}`},
      body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.1, max_tokens:600,
        messages:[{role:'system',content:'Return ONLY valid JSON array.'},{role:'user',content:prompt}] }),
    });
    const d = await res.json();
    const r = d.choices?.[0]?.message?.content||'[]';
    const c = r.replace(/```json|```/g,'').trim();
    const m = c.match(/\[[\s\S]*\]/);
    const s = JSON.parse(m?m[0]:c);
    return leads.map((l,i)=>{const sc=s.find(x=>x.index===i)||{score:50,priority:'MEDIUM',reason:'N/A'};return{...l,icp_score:sc.score,priority:sc.priority,score_reason:sc.reason};});
  } catch { return leads.map(l=>({...l,icp_score:50,priority:'MEDIUM',score_reason:'Scoring unavailable'})); }
}

// ── Supabase sub-table savers — FIX: all use resolution=merge-duplicates ────
const UPSERT = 'return=representation,resolution=merge-duplicates';
async function saveICP(sid, uid, co, d, url, key) {
  try { await sbFetch(url,key,'icp_profiles','POST',JSON.stringify({strategy_id:sid,user_id:uid,company_name:co,primary_icp:d.primary_icp,secondary_icp:d.secondary_icp,firmographics:d.firmographics,buying_triggers:d.buying_triggers,core_pain_points:d.core_pain_points,decision_makers:d.decision_makers,deal_cycle:d.deal_cycle,objections:d.objections}),'?on_conflict=strategy_id',UPSERT); } catch {}
}
async function saveKeywords(sid, uid, co, d, url, key) {
  try { await sbFetch(url,key,'keywords','POST',JSON.stringify({strategy_id:sid,user_id:uid,company_name:co,primary_keywords:d.primary_keywords,secondary_keywords:d.secondary_keywords,boolean_query:d.boolean_query,linkedin_search:d.linkedin_search_strings,intent_signals:d.intent_signals,content_topics:d.content_topics}),'?on_conflict=strategy_id',UPSERT); } catch {}
}
async function saveMessaging(sid, uid, co, d, url, key) {
  try { await sbFetch(url,key,'messaging_sequences','POST',JSON.stringify({strategy_id:sid,user_id:uid,company_name:co,email_1:d.email_1,email_2:d.email_2,email_3:d.email_3,follow_up:d.follow_up_sequence}),'?on_conflict=strategy_id',UPSERT); } catch {}
}

// ── Rate limit helpers ───────────────────────────────────────────
async function isHourlyLimitExceeded(userId, url, key) {
  try {
    const ws  = new Date(); ws.setMinutes(0,0,0);
    const res = await sbFetch(url,key,'rate_limits','GET',null,`?user_id=eq.${userId}&window_start=eq.${ws.toISOString()}&limit=1`);
    const d   = await res.json();
    return d.length > 0 && d[0].tokens_used >= HOURLY_TOKEN_LIMIT;
  } catch { return false; }
}

async function bumpHourlyTokens(userId, tokens, url, key) {
  try {
    const ws = new Date(); ws.setMinutes(0,0,0);
    await sbFetch(url,key,'rate_limits','POST',JSON.stringify({user_id:userId,window_start:ws.toISOString(),request_count:1,tokens_used:tokens}),'?on_conflict=user_id,window_start',UPSERT);
  } catch {}
}

async function logRun(userId, strategyId, runType, step, company, tokens, duration, cacheHit, url, key) {
  try {
    await sbFetch(url,key,'analysis_runs','POST',JSON.stringify({user_id:userId,strategy_id:strategyId,run_type:runType,step_number:step,company_name:company,tokens_used:tokens,cost_usd:tokens*COST_PER_TOKEN,model:'gpt-4o-mini',cache_hit:cacheHit,duration_ms:duration}));
  } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────
async function hash(str) {
  const d = new TextEncoder().encode(str);
  const h = await crypto.subtle.digest('SHA-256',d);
  return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
}

// FIX: Added optional `prefer` param — upserts need 'resolution=merge-duplicates'
// Without it Supabase does INSERT OR IGNORE, silently dropping all step updates
// after the first save. Steps 2-6 never persisted. steps_completed stuck at 1.
const sbFetch = (url, key, table, method, body, qs = '', prefer = null) =>
  fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers:{ 'Content-Type':'application/json', apikey:key, Authorization:`Bearer ${key}`,
      Prefer: prefer ?? (method==='POST' ? 'return=representation' : 'return=minimal') },
    body: body||undefined,
  });

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
