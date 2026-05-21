/**
 * functions/api/signal-score.js
 * POST /api/signal-score
 *
 * Signal Scoring Engine — replaces the "Map Lead" button.
 * ALL scoring logic lives here. Zero scoring in frontend.
 *
 * Required body: { lead_id: string }
 * Optional body: { icp_criteria: object }
 *
 * Returns:
 * {
 *   score: "High" | "Medium" | "Low",
 *   numeric_score: number,
 *   signals: [{ message: string, type: string, category: string }],
 *   breakdown: [...],
 *   reason: string
 * }
 */

import {
  verifyAuth,
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

  if (!supabaseUrl || !serviceKey) {
    return errRes('Server misconfiguration', 500, cors);
  }

  // Auth
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ lead_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const leadId = sanitise(body.lead_id, 36);
  const ip     = request.headers.get('CF-Connecting-IP') || null;

  // ── Fetch lead (scoped to authenticated user) ─────────────────────────────
  const leadRes = await fetch(
    `${supabaseUrl}/rest/v1/leads?id=eq.${leadId}&user_id=eq.${user.id}&select=*`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!leadRes.ok) return errRes('Failed to fetch lead', 500, cors);
  const leads = await leadRes.json();
  if (!leads.length) return errRes('Lead not found', 404, cors);
  const lead = leads[0];

  // ── Fetch user ICP criteria ───────────────────────────────────────────────
  let icp = body.icp_criteria || {};
  if (!Object.keys(icp).length) {
    icp = await fetchUserICP(user.id, supabaseUrl, serviceKey);
  }

  // ── Score the lead (deterministic, reproducible) ──────────────────────────
  const scoreResult = computeScore(lead, icp);

  // ── Generate signals (rule-based + optional AI enrichment) ───────────────
  const signals = await buildSignals(lead, icp, scoreResult, env.OPENAI_API_KEY);

  // ── Persist scored result back to lead record ─────────────────────────────
  await fetch(
    `${supabaseUrl}/rest/v1/leads?id=eq.${leadId}&user_id=eq.${user.id}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        icp_score:    scoreResult.numeric,
        priority:     scoreResult.tier,
        score_reason: scoreResult.reason,
        score_details: JSON.stringify({
          breakdown: scoreResult.breakdown,
          signals,
          scored_at: new Date().toISOString(),
        }),
        status: lead.status === 'unprocessed' ? 'analyzed' : lead.status,
      }),
    }
  );

  // ── Audit log ─────────────────────────────────────────────────────────────
  await auditLog(env, {
    userId:    user.id,
    orgId:     null,
    eventType: 'signal_score',
    eventData: {
      lead_id:      leadId,
      score:        scoreResult.tier,
      numeric_score: scoreResult.numeric,
    },
    ipAddress: ip,
  });

  return okRes(
    {
      lead_id:       leadId,
      score:         scoreResult.tier,      // "High" | "Medium" | "Low"
      numeric_score: scoreResult.numeric,   // 0–100
      signals:       signals.map(s => s.message), // plain string array per spec
      signals_detail: signals,              // full detail for rich UI
      breakdown:     scoreResult.breakdown,
      reason:        scoreResult.reason,
    },
    cors
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE — deterministic, reproducible, backend-only
// ─────────────────────────────────────────────────────────────────────────────

function computeScore(lead, icp) {
  const breakdown = [];
  let total = 0;

  const title    = (lead.title    || '').toLowerCase();
  const location = (lead.location || '').toLowerCase();

  // 1. Title Seniority (25 pts)
  let seniorityPts  = 0;
  let seniorityLabel = 'Individual Contributor';
  if (/\b(ceo|cto|coo|cmo|cpo|founder|co-founder|president|owner)\b/.test(title)) {
    seniorityPts = 25; seniorityLabel = 'C-Level / Founder';
  } else if (/\b(vp|vice president|svp|evp|gm|general manager)\b/.test(title)) {
    seniorityPts = 22; seniorityLabel = 'VP-Level';
  } else if (/\b(director|head of|chief)\b/.test(title)) {
    seniorityPts = 18; seniorityLabel = 'Director';
  } else if (/\b(senior|sr\.?|lead|principal)\b/.test(title)) {
    seniorityPts = 12; seniorityLabel = 'Senior';
  } else if (/\bmanager\b/.test(title)) {
    seniorityPts = 8; seniorityLabel = 'Manager';
  } else {
    seniorityPts = 4;
  }
  total += seniorityPts;
  breakdown.push({ criterion: 'Title Seniority', points: seniorityPts, max: 25, matched: seniorityPts >= 18, detail: seniorityLabel });

  // 2. ICP Title Match (25 pts)
  let icpTitlePts    = 0;
  let icpTitleDetail = 'No ICP defined (neutral)';
  if (icp.target_titles?.length) {
    const exact = icp.target_titles.some(t => title.includes(t.toLowerCase()));
    if (exact) {
      icpTitlePts = 25; icpTitleDetail = 'Exact ICP title match';
    } else {
      const partial = icp.target_titles.some(t =>
        t.toLowerCase().split(/\s+/).some(w => w.length > 3 && title.includes(w))
      );
      icpTitlePts    = partial ? 12 : 0;
      icpTitleDetail = partial ? 'Partial ICP title match' : 'No ICP title match';
    }
  } else {
    icpTitlePts = 12;
  }
  total += icpTitlePts;
  breakdown.push({ criterion: 'ICP Title Match', points: icpTitlePts, max: 25, matched: icpTitlePts >= 20, detail: icpTitleDetail });

  // 3. Industry Match (20 pts)
  let industryPts    = 0;
  let industryDetail = 'No industry criteria (neutral)';
  if (icp.target_industries?.length) {
    const li = (lead.industry || '').toLowerCase();
    const hit = icp.target_industries.some(i => li.includes(i.toLowerCase()));
    industryPts    = hit ? 20 : 0;
    industryDetail = hit ? `Industry match: ${lead.industry}` : 'Industry mismatch';
  } else {
    industryPts = 10;
  }
  total += industryPts;
  breakdown.push({ criterion: 'Industry Match', points: industryPts, max: 20, matched: industryPts >= 15, detail: industryDetail });

  // 4. Location Match (10 pts)
  let locationPts    = 0;
  let locationDetail = 'No location criteria (neutral)';
  if (icp.target_locations?.length) {
    const hit = icp.target_locations.some(loc => location.includes(loc.toLowerCase()));
    locationPts    = hit ? 10 : 0;
    locationDetail = hit ? `Target location: ${lead.location}` : 'Location outside target';
  } else {
    locationPts = 5;
  }
  total += locationPts;
  breakdown.push({ criterion: 'Location', points: locationPts, max: 10, matched: locationPts >= 8, detail: locationDetail });

  // 5. Data Completeness (20 pts)
  let complPts    = 0;
  const hasFields = [];
  if (lead.email)        { complPts += 5; hasFields.push('email'); }
  if (lead.linkedin_url) { complPts += 5; hasFields.push('LinkedIn'); }
  if (lead.website)      { complPts += 5; hasFields.push('website'); }
  if (lead.title)        { complPts += 5; hasFields.push('title'); }
  total += complPts;
  breakdown.push({ criterion: 'Data Completeness', points: complPts, max: 20, matched: complPts >= 15, detail: `Has: ${hasFields.join(', ') || 'none'}` });

  const tier   = total >= 75 ? 'High' : total >= 50 ? 'Medium' : 'Low';
  const reason = `Score ${total}/100 (${tier}) — ${seniorityLabel} at ${lead.company || 'unknown company'}`;

  return { numeric: total, tier, breakdown, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL BUILDER — rule-based + optional AI enrichment
// ─────────────────────────────────────────────────────────────────────────────

async function buildSignals(lead, icp, scoreResult, openaiKey) {
  const signals = [];

  // Tier signal
  if (scoreResult.tier === 'High') {
    signals.push({ type: 'positive', category: 'icp_fit', message: `ICP fit ≥75% (${scoreResult.numeric}/100)`, weight: 'high', source: 'scoring_engine' });
  } else if (scoreResult.tier === 'Medium') {
    signals.push({ type: 'neutral', category: 'icp_fit', message: `Moderate ICP fit (${scoreResult.numeric}/100) — nurture recommended`, weight: 'medium', source: 'scoring_engine' });
  } else {
    signals.push({ type: 'negative', category: 'icp_fit', message: `Low ICP fit (${scoreResult.numeric}/100) — not a priority target`, weight: 'low', source: 'scoring_engine' });
  }

  // Breakdown signals
  for (const item of scoreResult.breakdown) {
    if (item.matched) {
      signals.push({
        type:     'positive',
        category: item.criterion.toLowerCase().replace(/\s+/g, '_'),
        message:  `✓ ${item.criterion}: ${item.detail}`,
        weight:   item.points >= 20 ? 'high' : 'medium',
        source:   'scoring_engine',
      });
    } else if (item.points === 0 && item.max >= 15) {
      signals.push({
        type:     'negative',
        category: item.criterion.toLowerCase().replace(/\s+/g, '_'),
        message:  `✗ ${item.criterion}: ${item.detail}`,
        weight:   'low',
        source:   'scoring_engine',
      });
    }
  }

  // Hiring growth signal (inferred from title keywords)
  if (/\b(hiring|growing|expanding)\b/i.test(JSON.stringify(lead))) {
    signals.push({ type: 'positive', category: 'growth', message: 'Hiring growth detected in lead data', weight: 'medium', source: 'scoring_engine' });
  }

  // AI enrichment (optional — only if OpenAI key configured)
  if (openaiKey) {
    try {
      const prompt = `Analyze this B2B lead and return 2 concise buying-intent signals as JSON array [{\"message\":\"...\"}]. No preamble.\n\nLead: ${lead.name} — ${lead.title} at ${lead.company}\nLocation: ${lead.location || 'unknown'}, Industry: ${lead.industry || 'unknown'}, Score: ${scoreResult.numeric}/100 (${scoreResult.tier})\n\nFocus: intent signals, funding, hiring trends, tech adoption. If data limited, say so.`;

      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
      });

      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const content = aiData.choices?.[0]?.message?.content || '[]';
        const cleaned = content.replace(/```json|```/g, '').trim();
        const aiSignals = JSON.parse(cleaned);
        for (const s of aiSignals) {
          if (s.message) {
            signals.push({ type: 'insight', category: 'enrichment', message: s.message, weight: 'medium', source: 'ai_analysis' });
          }
        }
      }
    } catch (_) {
      signals.push({ type: 'neutral', category: 'system', message: 'AI enrichment unavailable — rule-based scoring applied', weight: 'low', source: 'system' });
    }
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// ICP Fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUserICP(userId, url, key) {
  try {
    const res = await fetch(
      `${url}/rest/v1/icp_profiles?user_id=eq.${userId}&order=created_at.desc&limit=1`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!res.ok) return {};
    const profiles = await res.json();
    if (!profiles?.length) return {};
    const p = profiles[0];
    return {
      target_titles:     Array.isArray(p.decision_makers) ? p.decision_makers : [],
      target_industries: parseIndustries(p.firmographics || ''),
      target_locations:  [],
      primary_icp:       p.primary_icp || '',
    };
  } catch (_) {
    return {};
  }
}

function parseIndustries(firmographics) {
  const m = firmographics.match(/industry[:\s]+([^,\n]+)/i);
  if (!m) return [];
  return m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
