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
// Phase token budgets:
// P1=Signal Extraction, P2=Scoring, P3=Verdict, P4=Deal Lens, P5=Risks, P6=Final
const STEP_MAX_TOKENS = { 1:1800, 2:1500, 3:1200, 4:1500, 5:1500, 6:2000, 7:2500 };

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

  // Attempt to resolve a trusted company profile from the request or historical enrichment data.
  const resolvedProfile = await resolveCompanyProfile(
    sanitise(company, 200),
    company_profile || null,
    userId,
    supabaseUrl,
    supabaseKey
  );

  // Check KV step cache (company+step+evidence)
  const evidenceFingerprint = resolvedProfile
    ? await hash(JSON.stringify({ name: resolvedProfile.company_name || '', url: resolvedProfile._meta?.website_url || '' }))
    : 'none';
  const stepCacheKey = `step:${await hash(company.toLowerCase())}:${step}:${evidenceFingerprint}`;
  const stepCached   = await kv.get(env, stepCacheKey);
  if (stepCached) {
    return okRes({ data: stepCached, tokens: 0, duration_ms: 0, step, _cached: true }, cors);
  }

  const prompt = buildStepPrompt(step, sanitise(company, 200), industry || '', prior_steps || {}, resolvedProfile);
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

  // Attach safe RAG metadata without changing existing payload fields
  const stepData = augmentStepOutput(parsed, resolvedProfile);

  const duration = Date.now() - t0;

  // Cache in KV (1hr TTL for steps)
  await kv.put(env, stepCacheKey, stepData, 3600);

  // Log + rate limit update (non-blocking)
  if (supabaseUrl && supabaseKey) {
    logRun(userId, null, 'gtm_step', step, company, tokensUsed, duration, false, supabaseUrl, supabaseKey);
    bumpHourlyTokens(userId, tokensUsed, supabaseUrl, supabaseKey);
  }

  return okRes({ data: stepData, tokens: tokensUsed, duration_ms: duration, step }, cors);
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

async function resolveCompanyProfile(company, providedProfile, userId, supabaseUrl, supabaseKey) {
  const hasProvided = providedProfile && providedProfile.extraction_confidence !== 'LOW' && providedProfile.company_overview;
  if (hasProvided) return providedProfile;

  if (!company || !supabaseUrl || !supabaseKey) return providedProfile || null;

  try {
    const encodedName = encodeURIComponent(company).replace(/%2A/g, '*');
    const enrichmentQuery = `?user_id=eq.${userId}&company_name=ilike.*${encodedName}*&source=eq.website&limit=1`;
    const enrichmentRes = await sbFetch(supabaseUrl, supabaseKey, 'company_enrichment', 'GET', null, enrichmentQuery);
    if (enrichmentRes.ok) {
      const rows = await enrichmentRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const payload = rows[0]?.payload;
        if (payload && typeof payload === 'object') return payload;
      }
    }

    const strategyQuery = `?user_id=eq.${userId}&company_name=ilike.*${encodedName}*&select=scraped_profile&limit=1`;
    const strategyRes = await sbFetch(supabaseUrl, supabaseKey, 'strategies', 'GET', null, strategyQuery);
    if (!strategyRes.ok) return providedProfile || null;
    const strategyRows = await strategyRes.json();
    if (Array.isArray(strategyRows) && strategyRows.length > 0) {
      const scraped = strategyRows[0]?.scraped_profile;
      if (scraped && typeof scraped === 'object') return scraped;
    }

    return providedProfile || null;
  } catch (e) {
    console.error('[resolveCompanyProfile]', e.message);
    return providedProfile || null;
  }
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
// DATA RICHNESS MEASUREMENT — Phase-based
// Measures how much real phase data exists for Step 7 intelligence.
// Returns 0–100 based on phase completeness.
// ══════════════════════════════════════════════════════════════════
function measureDataRichness(steps) {
  // Phase weights for Step 7 (must sum to 100)
  // P1(signals)=20, P2(scores)=20, P3(verdict)=20, P4(deal)=15, P5(risks)=15, P6(final)=10
  const weights = { 1: 20, 2: 20, 3: 20, 4: 15, 5: 15, 6: 10 };
  let score = 0;

  // Phase 1 — Signal Extraction (weight 20)
  if (steps[1]) {
    const p1 = steps[1];
    let pts = 0;
    if (p1.demand_signals?.length)   pts += 7;
    if (p1.market_timing?.length)    pts += 7;
    if (p1.icp_fit?.target_description && p1.icp_fit.target_description !== 'missing data') pts += 6;
    score += Math.min(weights[1], pts);
  }

  // Phase 2 — Scoring (weight 20)
  if (steps[2]) {
    const p2 = steps[2];
    let pts = 0;
    if (typeof p2.demand_score?.score === 'number')           pts += 5;
    if (typeof p2.market_timing_score?.score === 'number')    pts += 5;
    if (typeof p2.icp_fit_score?.score === 'number')          pts += 5;
    if (typeof p2.data_completeness_score?.score === 'number')pts += 5;
    score += Math.min(weights[2], pts);
  }

  // Phase 3 — Verdict (weight 20)
  if (steps[3]) {
    const p3 = steps[3];
    let pts = 0;
    if (p3.verdict)          pts += 8;
    if (p3.verdict_reasoning)pts += 7;
    if (p3.score_basis)      pts += 5;
    score += Math.min(weights[3], pts);
  }

  // Phase 4 — Deal Lens (weight 15)
  if (steps[4]) {
    const p4 = steps[4];
    let pts = 0;
    if (p4.target_roles?.length)  pts += 5;
    if (p4.core_problem)          pts += 5;
    if (p4.why_now)               pts += 5;
    score += Math.min(weights[4], pts);
  }

  // Phase 5 — Risks (weight 15)
  if (steps[5]) {
    const p5 = steps[5];
    let pts = 0;
    if (p5.key_risks?.length)      pts += 7;
    if (typeof p5.confidence_score === 'number') pts += 8;
    score += Math.min(weights[5], pts);
  }

  // Phase 6 — Final Output (weight 10)
  if (steps[6]) {
    const p6 = steps[6];
    let pts = 0;
    if (p6.executive_brief)        pts += 5;
    if (p6.recommended_next_action)pts += 5;
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

  // Phase 1 — Signal Extraction
  if (steps[1]) {
    (steps[1].demand_signals||[]).slice(0,5).forEach((s,i)=>add(`Demand signal ${i+1}`, `[${s.type}/${s.strength}] ${s.signal}`));
    (steps[1].market_timing||[]).slice(0,3).forEach((s,i)=>add(`Market timing signal ${i+1}`, `[${s.category}/${s.strength}] ${s.signal}`));
    add('ICP target',       steps[1].icp_fit?.target_description);
    add('ICP fit indicators', (steps[1].icp_fit?.fit_indicators||[]).slice(0,3));
    add('Missing data',     (steps[1].data_completeness?.missing||[]).slice(0,5));
  }
  // Phase 2 — Scoring
  if (steps[2]) {
    add('Demand score',          `${steps[2].demand_score?.score??0}/40 — ${steps[2].demand_score?.rationale||''}`);
    add('Market timing score',   `${steps[2].market_timing_score?.score??0}/25`);
    add('ICP fit score',         `${steps[2].icp_fit_score?.score??0}/20`);
    add('Data completeness score',`${steps[2].data_completeness_score?.score??0}/15`);
    add('Total score',           `${steps[2].total_score??0}/100 (${steps[2].score_verification||''})`);
  }
  // Phase 3 — Verdict
  if (steps[3]) {
    add('Verdict',          steps[3].verdict);
    add('Verdict reasoning',steps[3].verdict_reasoning);
    add('Score basis',      steps[3].score_basis);
    add('Demand assessment',steps[3].demand_assessment);
    add('ICP assessment',   steps[3].icp_assessment);
    if (steps[3].conditions?.length) add('Conditions', steps[3].conditions);
  }
  // Phase 4 — Deal Lens
  if (steps[4]) {
    add('Target roles',     (steps[4].target_roles||[]).join(', '));
    add('Core problem',     steps[4].core_problem);
    add('Solution angle',   steps[4].solution_angle);
    add('Why now',          steps[4].why_now);
    add('Deal size',        steps[4].estimated_deal_size?.range);
    add('Sales approach',   steps[4].sales_approach);
  }
  // Phase 5 — Risks
  if (steps[5]) {
    (steps[5].key_risks||[]).slice(0,3).forEach((r,i)=>add(`Risk ${i+1}`, `[${r.impact}] ${r.risk}`));
    add('Confidence score', steps[5].confidence_score);
    add('Validation needed',(steps[5].validation_needed||[]).slice(0,3));
  }
  // Phase 6 — Final Output
  if (steps[6]) {
    add('Executive brief',  steps[6].executive_brief);
    add('Deal summary',     steps[6].deal_lens_summary);
    add('Next action',      steps[6].recommended_next_action);
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
  const sourceInstructions = `\nSOURCE ATTRIBUTION: include these metadata fields in your JSON output exactly as named: _source_context, _profile_source, _confidence_basis, _rag_enabled, _missing_evidence. If verified profile evidence is present, _profile_source must be "verified_company_profile". If verified evidence is missing, _profile_source must be "ai_estimate_validate_manually" and all source-backed facts should be avoided unless they come from the AI estimate context.`;
  const base = `You are a B2B GTM opportunity qualification analyst. CRITICAL: Return ONLY a valid JSON object. No markdown. No code fences. Start with { end with }. Use verified TRUTH LAYER evidence first. If verified evidence is missing, mark the output as an AI estimate and do not invent source-backed facts.${sourceInstructions}`;

  // Inject verified profile if available and high confidence
  const hasProfile = companyProfile && companyProfile.extraction_confidence !== 'LOW' && companyProfile.company_overview;
  const profileBlock = hasProfile
    ? `\nTRUTH LAYER: VERIFIED COMPANY PROFILE (use as ground truth — do not contradict):\n${JSON.stringify({
        overview: companyProfile.company_overview,
        services: companyProfile.services,
        industry: companyProfile.industry,
        target_market: companyProfile.target_market,
        tech_stack: companyProfile.tech_stack_hints,
        value_props: companyProfile.value_propositions,
      }, null, 2)}\n`
    : `\nTRUTH LAYER: NO VERIFIED COMPANY PROFILE AVAILABLE. This is an AI estimate and must be validated manually. Do not invent source-backed facts.\n`;

  // ── Build prior phase context for chaining ──
  const phaseCtx = buildPhaseContext(step, priorSteps);

  const prompts = {

    // ════════════════════════════════════════════════
    // PHASE 1 — SIGNAL EXTRACTION
    // ════════════════════════════════════════════════
    1:`${base}${profileBlock}
PHASE 1 — SIGNAL EXTRACTION for "${company}"${ind}.

Your ONLY job: extract real, observable business signals. Do NOT score. Do NOT conclude. Do NOT invent.
If a signal category has no evidence, use "missing data" as the value.

Group signals into 4 categories:
1. DEMAND SIGNALS: hiring, expansion, product launches, partnerships, funding
2. MARKET TIMING: growth trends, competitive pressure, regulation, technology shifts
3. ICP FIT: who they sell to, how well they match a B2B sales-team-equipped buyer
4. DATA COMPLETENESS: what information is available vs missing

Rules:
- Every signal must be a real, observable fact
- If no evidence exists for a category, set to "missing data"
- No scoring, no summaries, no conclusions

Return exact JSON:
{"demand_signals":[{"signal":"observable fact","type":"hiring|expansion|product_launch|partnership|funding","strength":"High|Medium|Low"}],"market_timing":[{"signal":"observable fact","category":"growth|competition|regulation|trend","strength":"High|Medium|Low"}],"icp_fit":{"target_description":"who they sell to, or missing data","fit_indicators":["evidence of fit"],"mismatches":["evidence of mismatch, or missing data"]},"data_completeness":{"available":["fields with real data"],"missing":["missing data: field name"]},"section_context":"one sentence on why signal extraction matters first","analyst_insight":"one specific observation about signal quality for this company"}`,

    // ════════════════════════════════════════════════
    // PHASE 2 — SCORING
    // ════════════════════════════════════════════════
    2:`${base}
PHASE 2 — SCORING for "${company}"${ind}.

Phase 1 extracted signals:
${phaseCtx}

Your ONLY job: score the signals. No new assumptions.

Scoring buckets (must sum to total_score exactly):
- Demand signals:    max 40 points
- Market timing:     max 25 points
- ICP fit:           max 20 points
- Data completeness: max 15 points

Rules:
- Strong, specific signal = full points
- Partial/vague signal = proportional points
- "missing data" = 0 points, no exceptions
- total_score = exact arithmetic sum
- Show exact calculation string: "X + Y + Z + W = total"

Return exact JSON:
{"demand_score":{"score":0,"max":40,"rationale":"specific reason from Phase 1","sub_breakdown":"e.g. hiring: +12, expansion: +10"},"market_timing_score":{"score":0,"max":25,"rationale":"specific reason from Phase 1","sub_breakdown":"e.g. growth trend: +10, competition: +8"},"icp_fit_score":{"score":0,"max":20,"rationale":"specific reason from Phase 1","sub_breakdown":"e.g. target match: +12"},"data_completeness_score":{"score":0,"max":15,"rationale":"fields present vs missing","sub_breakdown":"e.g. 8 of 12 fields present: +10"},"total_score":0,"score_verification":"X + Y + Z + W = total","section_context":"one sentence on why rigorous scoring prevents over-qualifying","analyst_insight":"one insight on scoring gaps and what data would improve it"}`,

    // ════════════════════════════════════════════════
    // PHASE 3 — VERDICT
    // ════════════════════════════════════════════════
    3:`${base}
PHASE 3 — VERDICT for "${company}"${ind}.

Prior phases:
${phaseCtx}

Your ONLY job: assign verdict strictly from scores. No opinion overrides.

Verdict rules (follow exactly):
- GO: total_score >= 70 AND demand is strong AND ICP fit is strong
- CONDITIONAL GO: total_score 55-69, OR one major fixable gap exists
- NO GO: total_score < 55 OR demand is weak

verdict must be exactly: "GO", "CONDITIONAL GO", or "NO GO"

Return exact JSON:
{"verdict":"GO|CONDITIONAL GO|NO GO","verdict_reasoning":"specific reasoning citing scores — no opinion","score_basis":"Total: X/100 (Demand: A/40 · Timing: B/25 · ICP: C/20 · Data: D/15)","demand_assessment":"strong|partial|weak","icp_assessment":"strong|partial|weak","conditions":["condition if CONDITIONAL GO — empty array if GO or NO GO"],"what_would_change_verdict":"single data point that would flip the verdict","section_context":"one sentence on why verdict must follow scores","analyst_insight":"one honest observation about this verdict's strength"}`,

    // ════════════════════════════════════════════════
    // PHASE 4 — DEAL LENS
    // ════════════════════════════════════════════════
    4:`${base}
PHASE 4 — DEAL LENS for "${company}"${ind}.

Prior phases:
${phaseCtx}

Your job: convert verified signals into practical sales direction.

Rules:
- Every element must trace back to a Phase 1 signal
- No generic statements
- Use exact job titles
- Clearly label deal size estimates
- solution_angle must be: cost_saving, growth, efficiency, compliance, or risk_reduction

Return exact JSON:
{"target_roles":["Exact Title 1","Exact Title 2","Exact Title 3"],"core_problem":"specific evidence-backed problem from signals","solution_angle":"cost_saving|growth|efficiency|compliance|risk_reduction","solution_pitch":"2-3 sentences tied directly to signals — industry-neutral","why_now":"specific reason from market timing or demand signal — not generic","estimated_deal_size":{"range":"$X – $Y","is_estimate":true,"basis":"reasoning: company size, deal type, signals"},"sales_approach":"enterprise|mid_market|partnership|direct","approach_rationale":"why this approach fits based on signals","section_context":"one sentence on why deal lens must come from signals","analyst_insight":"one revenue-specific observation"}`,

    // ════════════════════════════════════════════════
    // PHASE 5 — RISKS & CONFIDENCE
    // ════════════════════════════════════════════════
    5:`${base}
PHASE 5 — RISKS & CONFIDENCE for "${company}"${ind}.

Prior phases:
${phaseCtx}

Your job: identify genuine uncertainties. Every risk from missing or weak signals.

Rules:
- Each risk must come from a specific missing or weak signal in Phase 1
- No generic risks ("market may change")
- confidence_score is a number 0-100, capped by data_completeness_score from Phase 2

Return exact JSON:
{"key_risks":[{"risk":"specific risk description","source":"exact missing or weak signal","impact":"high|medium|low","mitigation":"what would resolve this risk"}],"confidence_level":"high|medium|low","confidence_score":0,"confidence_reasoning":"explanation linking confidence to data completeness","validation_needed":["specific action that would validate this opportunity"],"section_context":"one sentence on why data gaps drive confidence not gut feel","analyst_insight":"one honest assessment of the biggest uncertainty"}`,

    // ════════════════════════════════════════════════
    // PHASE 6 — FINAL OUTPUT
    // ════════════════════════════════════════════════
    6:`${base}
PHASE 6 — FINAL OUTPUT for "${company}"${ind}.

ALL prior phases:
${phaseCtx}

Your job: produce the final structured output. Combine all phases.

Rules:
- Do NOT change scores or verdicts from prior phases
- Do NOT add new assumptions
- Everything must be consistent with prior phases
- executive_brief: 3-5 sentences, board-ready, no jargon
- signal_highlights: the 3 strongest real signals from Phase 1

Return exact JSON:
{"signal_highlights":[{"signal":"top signal 1","type":"demand|timing|icp","strength":"High|Medium|Low"},{"signal":"top signal 2","type":"demand|timing|icp","strength":"High|Medium|Low"},{"signal":"top signal 3","type":"demand|timing|icp","strength":"High|Medium|Low"}],"score_breakdown":{"demand":0,"market_timing":0,"icp_fit":0,"data_completeness":0,"total":0,"verification":"X + Y + Z + W = total"},"verdict":"GO|CONDITIONAL GO|NO GO","deal_lens_summary":"2-sentence summary of who to target, problem, and why now","risks_summary":"2-sentence summary of key risk and resolution","confidence_note":"confidence score and what it means for next steps","executive_brief":"3-5 sentence board-ready opportunity summary","recommended_next_action":"single most important next step","section_context":"one sentence on why final output must be consistent","analyst_insight":"one strategic observation tying the full analysis together"}`,
  };

  return prompts[step];
}


// ── Build compressed prior phase context for chaining ──────────
function buildPhaseContext(step, steps) {
  const labels = {1:'PHASE 1 — Signal Extraction',2:'PHASE 2 — Scoring',3:'PHASE 3 — Verdict',4:'PHASE 4 — Deal Lens',5:'PHASE 5 — Risks'};
  return Array.from({length:step-1},(_,i)=>i+1)
    .filter(i=>steps[i])
    .map(i=>`[${labels[i]}]\n${JSON.stringify(steps[i])}`)
    .join('\n\n') || 'No prior phase data.';
}

// Kept for backward compat if referenced elsewhere
function buildContext(step, steps) { return buildPhaseContext(step, steps); }
function buildCompressedCtx(steps) { return buildPhaseContext(6, steps); }

const SCHEMAS = {
  1:['demand_signals','market_timing','icp_fit','data_completeness','section_context','analyst_insight'],
  2:['demand_score','market_timing_score','icp_fit_score','data_completeness_score','total_score','score_verification','section_context','analyst_insight'],
  3:['verdict','verdict_reasoning','score_basis','demand_assessment','icp_assessment','section_context','analyst_insight'],
  4:['target_roles','core_problem','solution_angle','solution_pitch','why_now','estimated_deal_size','sales_approach','section_context','analyst_insight'],
  5:['key_risks','confidence_level','confidence_score','validation_needed','section_context','analyst_insight'],
  6:['signal_highlights','score_breakdown','verdict','deal_lens_summary','risks_summary','confidence_note','executive_brief','recommended_next_action','section_context','analyst_insight'],
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

function augmentStepOutput(data, companyProfile) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

  const hasVerified = companyProfile && companyProfile.extraction_confidence !== 'LOW' && companyProfile.company_overview;
  const profileSource = hasVerified ? 'verified_company_profile' : 'ai_estimate_validate_manually';
  const confidenceFactor = hasVerified ? 1.0 : 0.85;
  const confidenceBasis = hasVerified
    ? 'Verified website profile evidence'
    : 'AI-only estimate with 0.85x confidence penalty applied';
  const sourceContext = hasVerified
    ? 'Verified profile evidence is available and should be used first.'
    : 'No verified profile evidence available; output is an AI estimate and should be validated manually.';
  const missingEvidence = hasVerified ? 'none' : 'verified company profile';

  const output = { ...data };

  if (typeof output.confidence_score === 'number') {
    output.confidence_score = Math.round(output.confidence_score * confidenceFactor);
  } else if (typeof output.confidence_score === 'string' && !Number.isNaN(Number(output.confidence_score))) {
    output.confidence_score = Math.round(Number(output.confidence_score) * confidenceFactor);
  }

  output._source_context = sourceContext;
  output._profile_source = profileSource;
  output._confidence_basis = confidenceBasis;
  output._rag_enabled = true;
  output._missing_evidence = missingEvidence;

  return output;
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
