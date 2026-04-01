/**
 * /api/metrics
 * Cloudflare Pages Function
 *
 * action: 'dashboard'     → aggregate stats for Command Center cards
 * action: 'daily'         → day-by-day activity for charts
 * action: 'cost_report'   → token usage and cost breakdown
 * action: 'lead_funnel'   → lead pipeline stats
 */

import { verifyAuth, corsHeaders, validate, errRes, okRes } from './_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // ── Auth ────────────────────────────────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return errRes('Database not configured', 503, cors);

  let body;
  try { body = await request.json(); } catch { return errRes('Invalid request body', 400, cors); }

  const validationErrors = validate({ action: 'string|required' }, body);
  if (validationErrors.length) return errRes(validationErrors[0], 400, cors);

  const userId = user.id;

  switch (body.action) {
    case 'dashboard':   return getDashboardMetrics(userId, supabaseUrl, supabaseKey, cors);
    case 'daily':       return getDailyActivity(userId, body.days || 30, supabaseUrl, supabaseKey, cors);
    case 'cost_report': return getCostReport(userId, supabaseUrl, supabaseKey, cors);
    case 'lead_funnel': return getLeadFunnel(userId, supabaseUrl, supabaseKey, cors);
    default:            return errRes(`Unknown action: ${body.action}`, 400, cors);
  }
}

// ══════════════════════════════════════════════════════════════════
// DASHBOARD METRICS — used by Command Center cards
// ══════════════════════════════════════════════════════════════════
async function getDashboardMetrics(userId, url, key, cors) {
  // Run 4 queries in parallel
  const [strategiesRes, leadsRes, runsRes, outreachRes] = await Promise.allSettled([
    sbQuery(url, key, `strategies?user_id=eq.${userId}&select=id,status,steps_completed,total_tokens,created_at`),
    sbQuery(url, key, `leads?user_id=eq.${userId}&select=id,status,priority,icp_score,outreach_status`),
    sbQuery(url, key, `analysis_runs?user_id=eq.${userId}&select=tokens_used,cost_usd,cache_hit,run_type,created_at&order=created_at.desc&limit=500`),
    sbQuery(url, key, `outreach_events?user_id=eq.${userId}&select=event_type,created_at&order=created_at.desc&limit=200`),
  ]);

  const strategies = strategiesRes.status === 'fulfilled' ? strategiesRes.value : [];
  const leads      = leadsRes.status === 'fulfilled'      ? leadsRes.value      : [];
  const runs       = runsRes.status === 'fulfilled'       ? runsRes.value       : [];
  const outreach   = outreachRes.status === 'fulfilled'   ? outreachRes.value   : [];

  // Strategy metrics
  const totalStrategies    = strategies.length;
  const completeStrategies = strategies.filter(s => s.status === 'complete').length;
  const inProgressStrategies = strategies.filter(s => s.status === 'in_progress').length;

  // Lead metrics
  const totalLeads       = leads.length;
  const highIntentLeads  = leads.filter(l => l.priority === 'HIGH').length;
  const medIntentLeads   = leads.filter(l => l.priority === 'MEDIUM').length;
  const analyzedLeads    = leads.filter(l => l.status === 'analyzed' || l.status === 'mapped').length;
  const unprocessedLeads = leads.filter(l => l.status === 'unprocessed').length;
  const avgScore         = leads.filter(l => l.icp_score).length > 0
    ? Math.round(leads.filter(l => l.icp_score).reduce((s, l) => s + l.icp_score, 0) / leads.filter(l => l.icp_score).length)
    : 0;
  const outreachReadyLeads = leads.filter(l => l.outreach_status === 'not_sent' && l.status === 'analyzed').length;

  // Token + cost metrics
  const totalTokens   = runs.reduce((s, r) => s + (r.tokens_used || 0), 0);
  const totalCost     = runs.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const cacheHits     = runs.filter(r => r.cache_hit).length;
  const cacheHitRate  = runs.length > 0 ? ((cacheHits / runs.length) * 100).toFixed(1) : '0.0';

  // Outreach metrics
  const sent          = outreach.filter(e => e.event_type === 'sent').length;
  const replied       = outreach.filter(e => e.event_type === 'replied').length;
  const meetingBooked = outreach.filter(e => e.event_type === 'meeting_booked').length;
  const replyRate     = sent > 0 ? ((replied / sent) * 100).toFixed(1) : '0.0';

  // This week vs last week (lead adds)
  const now      = Date.now();
  const oneWeek  = 7 * 24 * 60 * 60 * 1000;
  const thisWeekRuns = runs.filter(r => now - new Date(r.created_at).getTime() < oneWeek).length;
  const lastWeekRuns = runs.filter(r => {
    const age = now - new Date(r.created_at).getTime();
    return age >= oneWeek && age < oneWeek * 2;
  }).length;
  const weekOverWeek = lastWeekRuns > 0
    ? ((thisWeekRuns - lastWeekRuns) / lastWeekRuns * 100).toFixed(1)
    : null;

  return okRes({
    strategies: {
      total:       totalStrategies,
      complete:    completeStrategies,
      in_progress: inProgressStrategies,
    },
    leads: {
      total:          totalLeads,
      high_intent:    highIntentLeads,
      medium_intent:  medIntentLeads,
      analyzed:       analyzedLeads,
      unprocessed:    unprocessedLeads,
      avg_score:      avgScore,
      outreach_ready: outreachReadyLeads,
    },
    usage: {
      total_tokens:   totalTokens,
      total_cost_usd: parseFloat(totalCost.toFixed(4)),
      total_api_calls: runs.length,
      cache_hits:     cacheHits,
      cache_hit_rate: cacheHitRate + '%',
    },
    outreach: {
      sent,
      replied,
      meeting_booked: meetingBooked,
      reply_rate:     replyRate + '%',
    },
    activity: {
      this_week_calls: thisWeekRuns,
      last_week_calls: lastWeekRuns,
      week_over_week:  weekOverWeek ? weekOverWeek + '%' : 'N/A',
    },
  }, cors);
}

// ══════════════════════════════════════════════════════════════════
// DAILY ACTIVITY — line chart data for dashboard
// ══════════════════════════════════════════════════════════════════
async function getDailyActivity(userId, days, url, key, cors) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const runs   = await sbQuery(url, key,
    `analysis_runs?user_id=eq.${userId}&created_at=gte.${since}&select=created_at,run_type,tokens_used,cost_usd,cache_hit`
  );

  // Group by date
  const byDay = {};
  for (const run of runs) {
    const day = run.created_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { date: day, calls: 0, tokens: 0, cost: 0, cache_hits: 0 };
    byDay[day].calls++;
    byDay[day].tokens  += run.tokens_used || 0;
    byDay[day].cost    += run.cost_usd    || 0;
    if (run.cache_hit) byDay[day].cache_hits++;
  }

  // Fill in missing days with zeros
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    result.push(byDay[d] || { date: d, calls: 0, tokens: 0, cost: 0, cache_hits: 0 });
  }

  return okRes({ days: result, period_days: days }, cors);
}

// ══════════════════════════════════════════════════════════════════
// COST REPORT — breakdown by model and run type
// ══════════════════════════════════════════════════════════════════
async function getCostReport(userId, url, key, cors) {
  const runs = await sbQuery(url, key,
    `analysis_runs?user_id=eq.${userId}&select=run_type,model,tokens_used,cost_usd,cache_hit,created_at`
  );

  const byType = {};
  for (const run of runs) {
    const t = run.run_type || 'unknown';
    if (!byType[t]) byType[t] = { calls: 0, tokens: 0, cost: 0, cached: 0 };
    byType[t].calls++;
    byType[t].tokens += run.tokens_used || 0;
    byType[t].cost   += run.cost_usd    || 0;
    if (run.cache_hit) byType[t].cached++;
  }

  const totalCost   = runs.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const totalTokens = runs.reduce((s, r) => s + (r.tokens_used || 0), 0);
  const totalCached = runs.filter(r => r.cache_hit).length;
  const savedCost   = totalCached * 0.0003; // approx savings per cached call

  return okRes({
    total_cost_usd:   parseFloat(totalCost.toFixed(4)),
    total_tokens:     totalTokens,
    total_calls:      runs.length,
    cached_calls:     totalCached,
    estimated_savings_usd: parseFloat(savedCost.toFixed(4)),
    by_type:          byType,
  }, cors);
}

// ══════════════════════════════════════════════════════════════════
// LEAD FUNNEL — pipeline stage counts
// ══════════════════════════════════════════════════════════════════
async function getLeadFunnel(userId, url, key, cors) {
  const leads = await sbQuery(url, key,
    `leads?user_id=eq.${userId}&select=status,priority,outreach_status,icp_score`
  );

  const funnel = {
    imported:       leads.length,
    analyzed:       leads.filter(l => l.status !== 'unprocessed').length,
    high_intent:    leads.filter(l => l.priority === 'HIGH').length,
    outreach_sent:  leads.filter(l => l.outreach_status === 'sent').length,
    replied:        leads.filter(l => l.outreach_status === 'replied').length,
  };

  const conversionRates = {
    import_to_analyzed:  pct(funnel.analyzed,      funnel.imported),
    analyzed_to_high:    pct(funnel.high_intent,   funnel.analyzed),
    high_to_outreach:    pct(funnel.outreach_sent, funnel.high_intent),
    outreach_to_reply:   pct(funnel.replied,       funnel.outreach_sent),
  };

  // Score distribution buckets
  const scored = leads.filter(l => l.icp_score != null);
  const dist = { '0-24': 0, '25-49': 0, '50-74': 0, '75-89': 0, '90-100': 0 };
  for (const l of scored) {
    const s = l.icp_score;
    if (s < 25)       dist['0-24']++;
    else if (s < 50)  dist['25-49']++;
    else if (s < 75)  dist['50-74']++;
    else if (s < 90)  dist['75-89']++;
    else              dist['90-100']++;
  }

  return okRes({ funnel, conversion_rates: conversionRates, score_distribution: dist }, cors);
}

// ── Helpers ──────────────────────────────────────────────────────
function pct(num, denom) {
  if (!denom) return '0.0%';
  return ((num / denom) * 100).toFixed(1) + '%';
}

async function sbQuery(url, key, path) {
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return res.ok ? await res.json() : [];
  } catch { return []; }
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
