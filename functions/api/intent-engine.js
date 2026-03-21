/**
 * /api/intent-engine
 * Cloudflare Pages Function — Intent Signal Engine
 *
 * action: 'score_company'   → calculate intent score for one company
 * action: 'score_all'       → batch recalculate intent for all user companies
 * action: 'get_signals'     → list signals for a company
 * action: 'add_signal'      → manually add a signal
 * action: 'get_weights'     → get current scoring weights
 * action: 'hot_accounts'    → return top accounts by intent score
 */

import { verifyAuth, corsHeaders, validate, rateLimit, sanitise, errRes, okRes } from './_middleware.js';
import { cacheGet, cachePut, cacheDel, TTL } from './cache.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  if (!await rateLimit(`intent:${user.id}`, env, 60, 60_000)) {
    return errRes('Rate limit reached.', 429, cors);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ action: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const userId = user.id;

  switch (body.action) {
    case 'score_company':  return scoreCompany(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'score_all':      return scoreAllCompanies(userId, supabaseUrl, supabaseKey, env, cors);
    case 'get_signals':    return getSignals(body, userId, supabaseUrl, supabaseKey, cors);
    case 'add_signal':     return addSignal(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'get_weights':    return getWeights(userId, supabaseUrl, supabaseKey, env, cors);
    case 'hot_accounts':   return getHotAccounts(body, userId, supabaseUrl, supabaseKey, env, cors);
    default:               return errRes(`Unknown action: ${body.action}`, 400, cors);
  }
}

// ══════════════════════════════════════════════════════════════════
// SCORE COMPANY — calculate intent score from its stored signals
// Uses dynamic weights from learning_weights table
// ══════════════════════════════════════════════════════════════════
async function scoreCompany(body, userId, url, key, env, cors) {
  const errors = validate({ company_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const companyId = sanitise(body.company_id, 36);

  // Load signals for this company (last 30 days)
  const signalsRes = await sb(url, key, 'intent_signals', 'GET', null,
    `?company_id=eq.${companyId}&user_id=eq.${userId}&created_at=gte.${thirtyDaysAgo()}&order=created_at.desc`);
  if (!signalsRes.ok) return errRes('Failed to load signals', 500, cors);
  const signals = await signalsRes.json();

  // Load current weights
  const weights = await loadWeights(userId, url, key, env);

  // Calculate intent score
  const result = calculateIntentScore(signals, weights);

  // Update company's lead_priority in leads table (non-blocking)
  updateLeadPriorities(userId, companyId, result.intent_score, url, key);

  return okRes({
    company_id:    companyId,
    intent_score:  result.intent_score,
    intent_tier:   result.intent_tier,
    signal_count:  signals.length,
    signal_breakdown: result.breakdown,
    signals:       signals.slice(0, 10),
    weights_used:  weights,
  }, cors);
}

// ══════════════════════════════════════════════════════════════════
// CORE INTENT SCORING MODEL
// Each signal type has a base score (0-20).
// Multiplied by the dynamic weight from learning_weights.
// Total capped at 100.
// ══════════════════════════════════════════════════════════════════
export function calculateIntentScore(signals, weights = {}) {
  // Default weights if not yet learned
  const w = {
    hiring_growth:    weights.hiring_growth    ?? 1.0,
    product_launch:   weights.product_launch   ?? 1.0,
    tech_adoption:    weights.tech_adoption    ?? 1.0,
    content_activity: weights.content_activity ?? 1.0,
    website_change:   weights.website_change   ?? 1.0,
    funding_signal:   weights.funding_signal   ?? 1.0,
    leadership_change:weights.leadership_change?? 1.0,
    expansion_signal: weights.expansion_signal ?? 1.0,
  };

  // Base point values per signal type
  const BASE_POINTS = {
    hiring_growth:     20,
    product_launch:    20,
    tech_adoption:     15,
    content_activity:  10,
    website_change:    10,
    funding_signal:    20,
    leadership_change: 15,
    expansion_signal:  15,
  };

  const breakdown = {};
  let rawScore = 0;

  // Group signals by type, take best score per type
  const byType = {};
  for (const sig of signals) {
    const t = sig.signal_type;
    if (!byType[t] || sig.score > byType[t].score) {
      byType[t] = sig;
    }
  }

  for (const [type, sig] of Object.entries(byType)) {
    const base    = BASE_POINTS[type] || 10;
    const weight  = w[type] || 1.0;
    // Recency decay: signals older than 14 days score at 50%
    const ageMs   = Date.now() - new Date(sig.created_at).getTime();
    const decayFactor = ageMs > 14 * 86400 * 1000 ? 0.5 : 1.0;
    const points  = Math.round(base * weight * decayFactor);
    breakdown[type] = { points, weight, decay: decayFactor };
    rawScore += points;
  }

  const intent_score = Math.min(100, Math.max(0, rawScore));
  const intent_tier  = intent_score >= 60 ? 'HOT'
                     : intent_score >= 30 ? 'WARM'
                     : 'COLD';

  return { intent_score, intent_tier, breakdown };
}

// ══════════════════════════════════════════════════════════════════
// SCORE ALL — batch recalculate intent for every company
// ══════════════════════════════════════════════════════════════════
async function scoreAllCompanies(userId, url, key, env, cors) {
  const companiesRes = await sb(url, key, 'companies', 'GET', null,
    `?user_id=eq.${userId}&select=id,name,intent_score,intent_tier`);
  if (!companiesRes.ok) return errRes('Failed to load companies', 500, cors);
  const companies = await companiesRes.json();

  if (!companies.length) {
    return okRes({ companies_scored: 0, results: [], message: 'No companies to score' }, cors);
  }

  const weights = await loadWeights(userId, url, key, env);
  const results = [];
  let updated = 0;
  let tiers_changed = 0;

  for (const company of companies) {
    const signalsRes = await sb(url, key, 'intent_signals', 'GET', null,
      `?company_id=eq.${company.id}&user_id=eq.${userId}&detected_at=gte.${thirtyDaysAgo()}&order=detected_at.desc`);
    if (!signalsRes.ok) continue;
    const signals = await signalsRes.json();

    const { intent_score, intent_tier, breakdown } = calculateIntentScore(signals, weights);

    const prev_tier  = company.intent_tier  || 'COLD';
    const prev_score = company.intent_score || 0;
    const tier_changed = prev_tier !== intent_tier;
    if (tier_changed) tiers_changed++;

    // ── CRITICAL FIX: Write score directly to companies table ─────
    // The trigger only fires on intent_signals changes.
    // score_all must also write directly so scores update on demand.
    await sb(url, key, 'companies', 'PATCH',
      JSON.stringify({
        intent_score,
        intent_tier,
        updated_at: new Date().toISOString(),
      }),
      `?id=eq.${company.id}&user_id=eq.${userId}`);

    // Also update any leads linked to this company
    await sb(url, key, 'leads', 'PATCH',
      JSON.stringify({ intent_score, last_scored_at: new Date().toISOString() }),
      `?company_id=eq.${company.id}&user_id=eq.${userId}`);

    results.push({
      company_id:   company.id,
      company_name: company.name,
      prev_score,
      prev_tier,
      intent_score,
      intent_tier,
      signal_count: signals.length,
      tier_changed,
      breakdown,
    });
    updated++;
  }

  // Bust all cache variants
  await Promise.allSettled([
    cacheDel(env, `hot:${userId}`),
    cacheDel(env, `hot:${userId}:all`),
    cacheDel(env, `hot:${userId}:HOT`),
    cacheDel(env, `hot:${userId}:WARM`),
    cacheDel(env, `hot:${userId}:COLD`),
  ]);

  return okRes({
    companies_scored: updated,
    tiers_changed,
    results,
    summary: results.map(r => ({
      name:        r.company_name,
      score:       r.intent_score,
      tier:        r.intent_tier,
      signals:     r.signal_count,
      changed:     r.tier_changed,
      prev:        r.prev_tier !== r.intent_tier ? `${r.prev_tier} → ${r.intent_tier}` : null,
    })),
  }, cors);
}

// ══════════════════════════════════════════════════════════════════
// GET SIGNALS — list signals for a company
// ══════════════════════════════════════════════════════════════════
async function getSignals(body, userId, url, key, cors) {
  const errors = validate({ company_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { company_id, limit = 50, signal_type } = body;
  let query = `?company_id=eq.${sanitise(company_id, 36)}&user_id=eq.${userId}&order=created_at.desc&limit=${limit}`;
  if (signal_type) query += `&signal_type=eq.${sanitise(signal_type, 50)}`;

  const res = await sb(url, key, 'intent_signals', 'GET', null, query);
  if (!res.ok) return errRes('Failed to load signals', 500, cors);
  const signals = await res.json();
  return okRes({ signals, total: signals.length }, cors);
}

// ══════════════════════════════════════════════════════════════════
// ADD SIGNAL — manually add a signal to a company
// ══════════════════════════════════════════════════════════════════
async function addSignal(body, userId, url, key, env, cors) {
  const errors = validate({
    company_id:  'string|required',
    signal_type: 'string|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const VALID_TYPES = ['hiring_growth','product_launch','tech_adoption',
    'content_activity','website_change','funding_signal','leadership_change','expansion_signal'];
  if (!VALID_TYPES.includes(body.signal_type)) {
    return errRes(`Invalid signal_type. Must be one of: ${VALID_TYPES.join(', ')}`, 400, cors);
  }

  const res = await sb(url, key, 'intent_signals', 'POST', JSON.stringify({
    user_id:     userId,
    company_id:  sanitise(body.company_id, 36),
    signal_type: body.signal_type,
    signal_data: body.signal_data || {},
    score:       body.score || 15,
    source:      'manual',
  }));

  if (!res.ok) return errRes('Failed to save signal', 500, cors);

  // Bust cache for this company
  await cacheDel(env, `intent:${body.company_id}`);
  await cacheDel(env, `graph:${body.company_id}`);

  return okRes({ saved: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// GET WEIGHTS — return current learning weights
// ══════════════════════════════════════════════════════════════════
async function getWeights(userId, url, key, env, cors) {
  const weights = await loadWeights(userId, url, key, env);
  return okRes({ weights }, cors);
}

// ══════════════════════════════════════════════════════════════════
// HOT ACCOUNTS — top accounts ranked by buying intent
// ══════════════════════════════════════════════════════════════════
async function getHotAccounts(body, userId, url, key, env, cors) {
  const { limit = 20, tier } = body;
  const cacheKey = `hot:${userId}`;

  // Check cache (30-minute TTL)
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    const filtered = tier ? cached.filter(a => a.intent_tier === tier) : cached;
    return okRes({ accounts: filtered.slice(0, limit), cached: true }, cors);
  }

  // Query the hot_accounts view
  let query = `?user_id=eq.${userId}&order=total_intent_score.desc&limit=50`;
  if (tier) query += `&intent_tier=eq.${sanitise(tier, 10)}`;

  const res = await sb(url, key, 'hot_accounts', 'GET', null, query);
  if (!res.ok) return errRes('Failed to load hot accounts', 500, cors);
  const accounts = await res.json();

  await cachePut(env, cacheKey, accounts, TTL.HOT_ACCOUNTS);
  return okRes({ accounts: accounts.slice(0, limit), cached: false }, cors);
}

// ── Helpers ──────────────────────────────────────────────────────
async function loadWeights(userId, url, key, env) {
  // Try cache first
  const cacheKey = `weights:${userId}`;
  const cached   = await cacheGet(env, cacheKey);
  if (cached) return cached;

  const res = await sb(url, key, 'learning_weights', 'GET', null, `?user_id=eq.${userId}`);
  if (!res.ok) return {};

  const rows = await res.json();
  if (!rows.length) {
    // Seed defaults for this user
    await sb(url, key, 'rpc/seed_default_weights', 'POST', JSON.stringify({ p_user_id: userId }));
    return {};
  }

  const weights = {};
  for (const row of rows) weights[row.factor] = parseFloat(row.weight);

  await cachePut(env, cacheKey, weights, TTL.WEIGHTS);
  return weights;
}

async function updateLeadPriorities(userId, companyId, intentScore, url, key) {
  try {
    // Get all leads for this company, update their priority
    const leads = await sb(url, key, 'leads', 'GET', null,
      `?user_id=eq.${userId}&company_id=eq.${companyId}&select=id,icp_score`);
    if (!leads.ok) return;
    const data = await leads.json();
    for (const lead of data) {
      const icp      = lead.icp_score || 50;
      const priority = (icp * 0.6) + (intentScore * 0.4);
      await sb(url, key, 'leads', 'PATCH',
        JSON.stringify({ intent_score: intentScore, lead_priority: Math.round(priority * 10) / 10, last_scored_at: new Date().toISOString() }),
        `?id=eq.${lead.id}&user_id=eq.${userId}`);
    }
  } catch {}
}

function thirtyDaysAgo() {
  return new Date(Date.now() - 30 * 86400 * 1000).toISOString();
}

const sb = (url, key, table, method, body, qs = '') =>
  fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: key, Authorization: `Bearer ${key}`,
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body || undefined,
  });

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
