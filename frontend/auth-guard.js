/**
 * /api/account-graph
 * Cloudflare Pages Function — Account Intelligence Graph
 *
 * action: 'get_graph'           → full account intelligence graph for one company
 * action: 'get_hot_accounts'    → ranked hot accounts with graph data
 * action: 'add_company'         → add/update a company in the graph
 * action: 'add_contact'         → add a contact to a company
 * action: 'link_lead_company'   → associate a lead with a company entity
 * action: 'get_tech_overlap'    → companies that share technology with a target
 * action: 'prioritize_leads'    → score all leads using ICP + intent weights
 */

import { verifyAuth, corsHeaders, validate, rateLimit, sanitise, errRes, okRes } from './_middleware.js';
import { cacheGet, cachePut, cacheDel, TTL } from './cache.js';
import { calculateIntentScore } from './intent-engine.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  if (!await rateLimit(`graph:${user.id}`, env, 60, 60_000)) {
    return errRes('Rate limit reached.', 429, cors);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  let body;
  try { body = await request.json(); } catch { return errRes('Invalid body', 400, cors); }

  const errors = validate({ action: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const userId = user.id;

  switch (body.action) {
    case 'get_graph':         return getGraph(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'get_hot_accounts':  return getHotAccounts(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'add_company':       return addCompany(body, userId, supabaseUrl, supabaseKey, env, cors);
    case 'add_contact':       return addContact(body, userId, supabaseUrl, supabaseKey, cors);
    case 'link_lead_company': return linkLeadCompany(body, userId, supabaseUrl, supabaseKey, cors);
    case 'get_tech_overlap':  return getTechOverlap(body, userId, supabaseUrl, supabaseKey, cors);
    case 'prioritize_leads':  return prioritizeLeads(body, userId, supabaseUrl, supabaseKey, env, cors);
    default:                  return errRes(`Unknown action: ${body.action}`, 400, cors);
  }
}

// ══════════════════════════════════════════════════════════════════
// GET GRAPH — full account intelligence object
// ══════════════════════════════════════════════════════════════════
async function getGraph(body, userId, url, key, env, cors) {
  const errors = validate({ company_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const companyId = sanitise(body.company_id, 36);
  const cacheKey  = `graph:${companyId}`;

  // Cache check (1hr TTL)
  const cached = await cacheGet(env, cacheKey);
  if (cached) return okRes({ ...cached, _cached: true }, cors);

  // Use the account_graph view which pre-joins everything
  const graphRes = await sb(url, key, 'account_graph', 'GET', null,
    `?company_id=eq.${companyId}&user_id=eq.${userId}&limit=1`);
  if (!graphRes.ok) return errRes('Failed to load account graph', 500, cors);
  const graphData = await graphRes.json();
  if (!graphData.length) return errRes('Company not found', 404, cors);

  const base = graphData[0];

  // Load detailed signals (last 30 days)
  const signalsRes = await sb(url, key, 'intent_signals', 'GET', null,
    `?company_id=eq.${companyId}&user_id=eq.${userId}&order=created_at.desc&limit=20&created_at=gte.${thirtyDaysAgo()}`);
  const signals = signalsRes.ok ? await signalsRes.json() : [];

  // Load campaign events for this company
  const eventsRes = await sb(url, key, 'campaign_events', 'GET', null,
    `?company_id=eq.${companyId}&user_id=eq.${userId}&order=created_at.desc&limit=20`);
  const events = eventsRes.ok ? await eventsRes.json() : [];

  // Assemble graph
  const graph = {
    company: {
      id:         companyId,
      name:       base.company_name,
      domain:     base.domain,
      industry:   base.industry,
    },
    intelligence: {
      intent_score:       base.intent_score || 0,
      intent_tier:        scoreTier(base.intent_score || 0),
      signal_count:       base.recent_signal_count || 0,
      avg_icp_score:      base.avg_icp_score ? Math.round(base.avg_icp_score) : null,
      lead_count:         base.lead_count || 0,
      total_touchpoints:  base.total_touchpoints || 0,
      positive_responses: base.positive_responses || 0,
      response_rate:      base.total_touchpoints > 0
        ? ((base.positive_responses / base.total_touchpoints) * 100).toFixed(1) + '%'
        : '0.0%',
    },
    contacts: base.top_contacts || [],
    technologies: base.technologies || [],
    signals: signals.map(s => ({
      type:       s.signal_type,
      score:      s.score,
      data:       s.signal_data,
      detected_at: s.created_at,
    })),
    timeline: buildTimeline(signals, events),
    recommendations: buildRecommendations(base, signals),
  };

  await cachePut(env, cacheKey, graph, TTL.ACCOUNT_GRAPH);
  return okRes(graph, cors);
}

// ══════════════════════════════════════════════════════════════════
// GET HOT ACCOUNTS
// ══════════════════════════════════════════════════════════════════
async function getHotAccounts(body, userId, url, key, env, cors) {
  const { limit = 20, tier, min_score = 0 } = body;
  const cacheKey = `hot:${userId}:${tier || 'all'}`;

  const cached = await cacheGet(env, cacheKey);
  if (cached) return okRes({ accounts: cached.slice(0, limit), cached: true, total: cached.length }, cors);

  let query = `?user_id=eq.${userId}&total_intent_score=gte.${min_score}&order=total_intent_score.desc&limit=50`;
  if (tier) query += `&intent_tier=eq.${sanitise(tier, 10)}`;

  const res = await sb(url, key, 'hot_accounts', 'GET', null, query);
  if (!res.ok) return errRes('Failed to load hot accounts', 500, cors);
  const accounts = await res.json();

  await cachePut(env, cacheKey, accounts, TTL.HOT_ACCOUNTS);
  return okRes({ accounts: accounts.slice(0, limit), cached: false, total: accounts.length }, cors);
}

// ══════════════════════════════════════════════════════════════════
// ADD COMPANY — create or update a company in the intelligence graph
// ══════════════════════════════════════════════════════════════════
async function addCompany(body, userId, url, key, env, cors) {
  const errors = validate({ name: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { name, domain, industry, size } = body;
  const payload = {
    user_id:     userId,
    name:        sanitise(name, 200),
    domain:      domain ? normaliseDomain(domain) : null,
    industry:    industry ? sanitise(industry, 100) : null,
    size:        size || null,
    scan_status: domain ? 'pending' : 'skipped',
  };

  // ── FIX: PostgREST upsert requires named constraint + resolution header ──
  const res = await fetch(`${url}/rest/v1/companies?on_conflict=companies_user_name_unique`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    console.error('[addCompany] HTTP', res.status, errText);
    // Surface actual Supabase error to frontend for debugging
    return errRes('DB_ERROR ' + res.status + ': ' + errText, 500, cors);
  }

  const saved = await res.json();
  const companyId = Array.isArray(saved) ? saved[0]?.id : saved?.id;

  // Bust caches
  await cacheDel(env, `hot:${userId}`);
  await cacheDel(env, `hot:${userId}:HOT`);

  return okRes({ company_id: companyId, created: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// ADD CONTACT
// ══════════════════════════════════════════════════════════════════
async function addContact(body, userId, url, key, cors) {
  const errors = validate({
    company_id: 'string|required',
    name:       'string|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const seniority = inferSeniority(body.title || '');

  const res = await sb(url, key, 'contacts', 'POST', JSON.stringify({
    user_id:    userId,
    company_id: sanitise(body.company_id, 36),
    name:       sanitise(body.name, 150),
    title:      body.title ? sanitise(body.title, 150) : null,
    email:      body.email ? sanitise(body.email, 200) : null,
    linkedin_url: body.linkedin_url ? sanitise(body.linkedin_url, 300) : null,
    seniority,
    department: body.department ? sanitise(body.department, 100) : null,
  }));

  if (!res.ok) return errRes('Failed to add contact', 500, cors);
  return okRes({ saved: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// LINK LEAD → COMPANY
// Associates a lead record with a company entity for graph tracking
// ══════════════════════════════════════════════════════════════════
async function linkLeadCompany(body, userId, url, key, cors) {
  const errors = validate({
    lead_id:    'string|required',
    company_id: 'string|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const res = await sb(url, key, 'leads', 'PATCH',
    JSON.stringify({ company_id: sanitise(body.company_id, 36) }),
    `?id=eq.${sanitise(body.lead_id, 36)}&user_id=eq.${userId}`);

  if (!res.ok) return errRes('Failed to link lead', 500, cors);
  return okRes({ linked: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// TECH OVERLAP — companies that share tech with a target
// ══════════════════════════════════════════════════════════════════
async function getTechOverlap(body, userId, url, key, cors) {
  const errors = validate({ company_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const companyId = sanitise(body.company_id, 36);

  // Get target company's tech
  const techRes = await sb(url, key, 'company_technologies', 'GET', null,
    `?company_id=eq.${companyId}&user_id=eq.${userId}&select=technology_id`);
  if (!techRes.ok) return errRes('Failed to load tech', 500, cors);
  const targetTech = await techRes.json();
  const techIds    = targetTech.map(t => `"${t.technology_id}"`).join(',');

  if (!techIds) return okRes({ overlapping_companies: [] }, cors);

  // Find other companies using the same tech
  const overlapRes = await sb(url, key, 'company_technologies', 'GET', null,
    `?technology_id=in.(${techIds})&user_id=eq.${userId}&company_id=neq.${companyId}&select=company_id,technology_id`);
  if (!overlapRes.ok) return errRes('Failed to find overlap', 500, cors);
  const overlap = await overlapRes.json();

  // Count shared technologies per company
  const countMap = {};
  for (const row of overlap) {
    countMap[row.company_id] = (countMap[row.company_id] || 0) + 1;
  }

  const sorted = Object.entries(countMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([cid, count]) => ({ company_id: cid, shared_tech_count: count }));

  return okRes({ overlapping_companies: sorted, target_tech_count: targetTech.length }, cors);
}

// ══════════════════════════════════════════════════════════════════
// PRIORITIZE LEADS — score all user leads using current weights
// Combines ICP score + Intent score into lead_priority
// ══════════════════════════════════════════════════════════════════
async function prioritizeLeads(body, userId, url, key, env, cors) {
  // Load current scoring weights
  const weightsRes = await sb(url, key, 'learning_weights', 'GET', null, `?user_id=eq.${userId}`);
  const weightRows = weightsRes.ok ? await weightsRes.json() : [];
  const weights    = {};
  for (const r of weightRows) weights[r.factor] = parseFloat(r.weight);

  const icpW    = weights.icp_weight    || 0.6;
  const intentW = weights.intent_weight || 0.4;

  // Get all leads that have both scores
  const leadsRes = await sb(url, key, 'leads', 'GET', null,
    `?user_id=eq.${userId}&select=id,icp_score,intent_score,company_id&not.icp_score.is.null`);
  if (!leadsRes.ok) return errRes('Failed to fetch leads', 500, cors);
  const leads = await leadsRes.json();

  let updated = 0;
  await Promise.allSettled(leads.map(async lead => {
    const icp    = lead.icp_score    || 50;
    const intent = lead.intent_score || 0;
    const priority = parseFloat(((icp * icpW) + (intent * intentW)).toFixed(1));
    const tier     = priority >= 75 ? 'HIGH' : priority >= 50 ? 'MEDIUM' : 'LOW';

    await sb(url, key, 'leads', 'PATCH',
      JSON.stringify({ lead_priority: priority, priority: tier, last_scored_at: new Date().toISOString() }),
      `?id=eq.${lead.id}&user_id=eq.${userId}`);
    updated++;
  }));

  return okRes({
    leads_prioritized: updated,
    weights_used: { icp: icpW, intent: intentW },
  }, cors);
}

// ── Helpers ───────────────────────────────────────────────────────
function scoreTier(score) {
  return score >= 60 ? 'HOT' : score >= 30 ? 'WARM' : 'COLD';
}

function inferSeniority(title) {
  const t = title.toLowerCase();
  if (/\b(ceo|cto|coo|cmo|cpo|founder|president|owner)\b/.test(t)) return 'c_suite';
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 'vp';
  if (/\b(director|head of)\b/.test(t)) return 'director';
  if (/\b(manager)\b/.test(t)) return 'manager';
  return 'ic';
}

function normaliseDomain(domain) {
  if (!domain) return null;
  return domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase().trim();
}

function buildTimeline(signals, events) {
  const items = [
    ...signals.map(s => ({
      type: 'signal', date: s.created_at,
      label: s.signal_type.replace(/_/g, ' '),
      score: s.score,
    })),
    ...events.map(e => ({
      type: 'outreach', date: e.created_at,
      label: e.event_type.replace(/_/g, ' '),
      channel: e.channel,
    })),
  ];
  return items.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
}

function buildRecommendations(base, signals) {
  const recs = [];
  const signalTypes = new Set(signals.map(s => s.signal_type));

  if (base.intent_score >= 60) recs.push({ priority: 'HIGH', action: 'Reach out now — company showing strong buying intent' });
  if (signalTypes.has('hiring_growth')) recs.push({ priority: 'HIGH', action: 'Mention growth challenges — they are actively hiring' });
  if (signalTypes.has('product_launch')) recs.push({ priority: 'MEDIUM', action: 'Reference their recent launch in outreach messaging' });
  if (signalTypes.has('tech_adoption')) recs.push({ priority: 'MEDIUM', action: 'Highlight integration capabilities with their tech stack' });
  if ((base.lead_count || 0) === 0) recs.push({ priority: 'LOW', action: 'No leads imported for this company yet — source contacts' });
  if ((base.contact_count || 0) === 0) recs.push({ priority: 'MEDIUM', action: 'No contacts in graph — add decision makers from LinkedIn' });

  return recs;
}

function thirtyDaysAgo() {
  return new Date(Date.now() - 30 * 86400 * 1000).toISOString();
}

const sb = (url, key, table, method, body, qs = '', prefer = null) =>
  fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: key, Authorization: `Bearer ${key}`,
      Prefer: prefer ?? (method === 'POST' ? 'return=representation' : 'return=minimal'),
    },
    body: body || undefined,
  });

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
