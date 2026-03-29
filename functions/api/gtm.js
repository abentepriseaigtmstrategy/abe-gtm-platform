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
const STEP_MAX_TOKENS = { 1:1500, 2:1500, 3:1500, 4:1500, 5:1500, 6:2500 };

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // ── Auth — required on every action ────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const openaiKey   = env.OPENAI_API_KEY;
  const supabaseUrl = env.SUPABASE_URL;
  // Use service key if set; fall back to anon key so saves still work without the secret
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!supabaseKey) return errRes('Supabase not configured', 503, cors);
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

  const { company_name, industry, steps, total_tokens, company_url, scraped_profile, full_report } = body;
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
    const clean = text.replace(/```json|```/g,'').trim();
    const m     = clean.match(/\{[\s\S]*\}/);
    try { return JSON.parse(m ? m[0] : clean); } catch { return null; }
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
