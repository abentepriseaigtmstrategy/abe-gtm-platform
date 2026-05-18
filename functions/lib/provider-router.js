/**
 * provider-router.js  —  AI Provider Failover Module
 * ABE GTM Platform  ·  Cloudflare Workers compatible
 *
 * Primary provider  : OpenAI   (gpt-4o-mini)
 * Fallback provider : Google   (gemini-2.5-flash for steps 1-6, gemini-2.5-pro for step 7)
 *
 * Failover triggers:
 *   ✓ Network timeout / fetch throws
 *   ✓ HTTP 429 (rate limit / quota exceeded)
 *   ✓ HTTP 502 / 503 / 5xx  (provider unavailable)
 *   ✓ Empty or null response body
 *   ✓ Unparseable / malformed JSON
 *   ✓ Missing critical schema fields
 *   ✓ Invalid / unusable response structure
 *
 * Does NOT trigger failover:
 *   ✗ HTTP 400 / 401 / 403 (bad request — our fault, not provider's)
 *   ✗ Minor optional field differences
 *   ✗ Formatting-only differences
 *
 * Environment variables (Wrangler secrets):
 *   OPENAI_API_KEY           — required for primary
 *   GEMINI_API_KEY           — required for fallback
 *   ENABLE_PROVIDER_FAILOVER — optional, default "true"; set "false" to disable
 *
 * Exported API:
 *   routeProviderRequest(params, env)  → { rawText, parsed, tokensUsed, provider, fallbackTriggered, fallbackReason }
 *   normalizeStepOutput(step, data, provider)  → normalized data object
 *   validateStepSchema(step, data)             → { valid, missing, provider, fallback_used }
 */

// ══════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════

const OPENAI_TIMEOUT_MS  = 24_000;  // keep under Cloudflare Pages 30s wall
const GEMINI_TIMEOUT_MS  = 24_000;
const OPENAI_MODEL       = 'gpt-4o-mini';
// Use stable model IDs — never use dated preview suffixes (they expire and break silently).
// Flash: fast, cheap — used for steps 1-6. Pro: higher reasoning — used for step 7.
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_PRO_MODEL   = 'gemini-2.5-pro';

// Steps where higher Gemini reasoning is preferred for fallback
// Step 7 = Revenue Intelligence — benefits from Pro reasoning when primary fails
const GEMINI_PRO_STEPS = [7];

// ── Critical fields per step ──────────────────────────────────────
// Missing ANY of these in a primary response triggers fallback.
// Non-critical / optional fields are filled by normalizeStepOutput instead.
const CRITICAL_FIELDS = {
  1: ['demand_signals', 'icp_fit', 'data_completeness'],
  2: ['total_score', 'demand_score', 'icp_fit_score'],
  3: ['verdict', 'verdict_reasoning'],
  4: ['target_roles', 'core_problem', 'solution_angle'],
  5: ['key_risks', 'confidence_score'],
  6: ['verdict', 'executive_brief', 'recommended_next_action'],
  7: ['signal_summary', 'go_no_go', 'mcc_view', 'executive_brief'],
};

// ── Safe placeholder values ───────────────────────────────────────
// Applied when non-critical fields are absent.
// Allowed labels per spec: "AI-inferred — validate" / "Demo placeholder — requires validation" / "Source data missing"
const PLACEHOLDER = {
  TEXT:       'AI-inferred — validate',
  DEMO:       'Demo placeholder — requires validation',
  MISSING:    'Source data missing',
  LOW_STR:    'Low',
  PARTIAL:    'partial',
  COND_GO:    'CONDITIONAL GO',
  WATCH:      'Watch',
};

// ══════════════════════════════════════════════════════════════════
// SHARED JSON PARSER  (identical to gtm.js parseWithRetry inner fn)
// ══════════════════════════════════════════════════════════════════

function parseJSON(raw) {
  if (!raw) return null;
  const clean = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  // Attempt to close truncated structures
  let s = m[0];
  const opens  = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  if (opens > closes) {
    s = s + '}'.repeat(opens - closes);
    try { return JSON.parse(s); } catch {}
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// FAILOVER DECISION
// ══════════════════════════════════════════════════════════════════

function shouldFallback(statusCode, fetchError, rawText, parsed, step) {
  // Network/fetch error → fallback
  if (fetchError) {
    return { fallback: true, reason: `network_error:${fetchError.slice(0, 80)}` };
  }

  // Timeout → fallback
  if (statusCode === 408) {
    return { fallback: true, reason: 'timeout' };
  }

  // Rate limit → fallback
  if (statusCode === 429) {
    return { fallback: true, reason: 'rate_limit_429' };
  }

  // Provider unavailable / server error → fallback
  if (statusCode === 502 || statusCode === 503) {
    return { fallback: true, reason: `provider_unavailable_${statusCode}` };
  }
  if (statusCode >= 500) {
    return { fallback: true, reason: `server_error_${statusCode}` };
  }

  // Client error (bad request / auth / not-found) — do NOT fallback; it's our fault
  if (statusCode >= 400 && statusCode < 500) {
    return { fallback: false, reason: `client_error_${statusCode}` };
  }

  // Empty response → fallback
  if (!rawText || rawText.trim() === '' || rawText.trim() === '{}' || rawText.trim() === 'null') {
    return { fallback: true, reason: 'empty_response' };
  }

  // Unparseable JSON → fallback
  if (!parsed) {
    return { fallback: true, reason: 'malformed_json' };
  }

  // Missing critical schema fields → fallback
  const criticals = CRITICAL_FIELDS[step] || [];
  const missingCriticals = criticals.filter(
    f => !(f in parsed) || parsed[f] === null || parsed[f] === undefined,
  );
  if (missingCriticals.length > 0) {
    return { fallback: true, reason: `missing_critical_fields:${missingCriticals.join(',')}` };
  }

  return { fallback: false, reason: 'ok' };
}

// ══════════════════════════════════════════════════════════════════
// OPENAI CALLER
// ══════════════════════════════════════════════════════════════════

async function callOpenAI({ systemPrompt, userPrompt, maxTokens, temperature, step }, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    return { error: 'OPENAI_API_KEY not set', statusCode: 503, fetchError: 'no_key' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      }),
    });
    clearTimeout(timer);

    const statusCode = res.status;
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { error: e?.error?.message || `HTTP ${statusCode}`, statusCode };
    }

    const d = await res.json();
    const rawText    = d.choices?.[0]?.message?.content || '';
    const tokensUsed = d.usage?.total_tokens || 0;
    return { rawText, tokensUsed, statusCode: 200 };

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      error:      isTimeout ? 'openai_timeout' : err.message,
      statusCode: isTimeout ? 408 : 502,
      fetchError: err.message,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// GEMINI CALLER
// ══════════════════════════════════════════════════════════════════

async function callGemini({ systemPrompt, userPrompt, maxTokens, temperature, step }, env) {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    return { error: 'GEMINI_API_KEY not set', statusCode: 503 };
  }

  const model = GEMINI_PRO_STEPS.includes(step) ? GEMINI_PRO_MODEL : GEMINI_FLASH_MODEL;
  const url   = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [{
          role: 'user',
          parts: [{ text: userPrompt }],
        }],
        generationConfig: {
          temperature,
          maxOutputTokens:  maxTokens,
          responseMimeType: 'application/json',  // enforces JSON output
        },
      }),
    });
    clearTimeout(timer);

    const statusCode = res.status;
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { error: e?.error?.message || `Gemini HTTP ${statusCode}`, statusCode };
    }

    const d = await res.json();
    const rawText    = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokensUsed = d.usageMetadata?.totalTokenCount || 0;
    return { rawText, tokensUsed, statusCode: 200 };

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      error:      isTimeout ? 'gemini_timeout' : err.message,
      statusCode: isTimeout ? 408 : 502,
      fetchError: err.message,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// SCHEMA NORMALIZATION
// Ensures both OpenAI and Gemini outputs are normalized into the
// same structure before reaching save-report.js / report.html / export-pdf.js.
// Fills only absent fields — never overwrites valid provider data.
// ══════════════════════════════════════════════════════════════════

export function normalizeStepOutput(stepNumber, data, provider = 'openai') {
  // Defensive: ensure data is a plain object
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = {};
  }

  // ── Provider audit metadata ───────────────────────────────────
  // Stored under underscore-prefix so existing field consumers are unaffected.
  data._provider      = provider;
  data._fallback_used = provider !== 'openai';

  // ── Common optional fields ────────────────────────────────────
  if (!('section_context'  in data)) data.section_context  = PLACEHOLDER.TEXT;
  if (!('analyst_insight'  in data)) data.analyst_insight  = PLACEHOLDER.TEXT;

  // ── Step-specific normalization ───────────────────────────────
  switch (stepNumber) {

    // ──────────────────────────────────────────────
    // PHASE 1 — Signal Extraction
    // report.html consumers: demand_signals, market_timing, icp_fit, data_completeness, swot
    // ──────────────────────────────────────────────
    case 1: {
      if (!Array.isArray(data.demand_signals) || data.demand_signals.length === 0) {
        data.demand_signals = [{
          signal:   PLACEHOLDER.TEXT,
          type:     'expansion',
          strength: PLACEHOLDER.LOW_STR,
        }];
      }
      if (!Array.isArray(data.market_timing) || data.market_timing.length === 0) {
        data.market_timing = [{
          signal:   PLACEHOLDER.TEXT,
          category: 'trend',
          strength: PLACEHOLDER.LOW_STR,
        }];
      }
      if (!data.icp_fit || typeof data.icp_fit !== 'object') {
        data.icp_fit = {
          target_description: PLACEHOLDER.DEMO,
          fit_indicators:     [],
          mismatches:         [PLACEHOLDER.MISSING],
        };
      } else {
        if (!Array.isArray(data.icp_fit.fit_indicators)) data.icp_fit.fit_indicators = [];
        if (!Array.isArray(data.icp_fit.mismatches))     data.icp_fit.mismatches     = [];
        if (!data.icp_fit.target_description) data.icp_fit.target_description = PLACEHOLDER.DEMO;
      }
      if (!data.data_completeness || typeof data.data_completeness !== 'object') {
        data.data_completeness = { available: [], missing: [PLACEHOLDER.MISSING] };
      } else {
        if (!Array.isArray(data.data_completeness.available)) data.data_completeness.available = [];
        if (!Array.isArray(data.data_completeness.missing))   data.data_completeness.missing   = [];
      }
      if (!data.swot || typeof data.swot !== 'object') {
        data.swot = {
          strengths:     [PLACEHOLDER.TEXT],
          weaknesses:    [PLACEHOLDER.MISSING],
          opportunities: [PLACEHOLDER.TEXT],
          threats:       [PLACEHOLDER.MISSING],
        };
      } else {
        for (const k of ['strengths', 'weaknesses', 'opportunities', 'threats']) {
          if (!Array.isArray(data.swot[k])) data.swot[k] = [PLACEHOLDER.TEXT];
        }
      }
      break;
    }

    // ──────────────────────────────────────────────
    // PHASE 2 — Scoring
    // report.html consumers: demand_score, market_timing_score, icp_fit_score,
    //   data_completeness_score, total_score, score_verification
    // ──────────────────────────────────────────────
    case 2: {
      const safeScore = (obj, max) => {
        if (!obj || typeof obj !== 'object') {
          return { score: 0, max, rationale: PLACEHOLDER.DEMO, sub_breakdown: PLACEHOLDER.MISSING };
        }
        if (typeof obj.score !== 'number') obj.score = 0;
        if (!obj.rationale)    obj.rationale    = PLACEHOLDER.DEMO;
        if (!obj.sub_breakdown) obj.sub_breakdown = PLACEHOLDER.MISSING;
        obj.max = max;
        return obj;
      };
      data.demand_score           = safeScore(data.demand_score,           40);
      data.market_timing_score    = safeScore(data.market_timing_score,    25);
      data.icp_fit_score          = safeScore(data.icp_fit_score,          20);
      data.data_completeness_score = safeScore(data.data_completeness_score, 15);

      if (typeof data.total_score !== 'number') {
        data.total_score = (data.demand_score.score || 0)
          + (data.market_timing_score.score || 0)
          + (data.icp_fit_score.score || 0)
          + (data.data_completeness_score.score || 0);
      }
      if (!data.score_verification) {
        data.score_verification = `${data.demand_score.score} + ${data.market_timing_score.score} + ${data.icp_fit_score.score} + ${data.data_completeness_score.score} = ${data.total_score}`;
      }
      break;
    }

    // ──────────────────────────────────────────────
    // PHASE 3 — Verdict
    // report.html consumers: verdict, verdict_reasoning, score_basis,
    //   demand_assessment, icp_assessment, conditions
    // ──────────────────────────────────────────────
    case 3: {
      if (!data.verdict) data.verdict = PLACEHOLDER.COND_GO;
      if (!data.verdict_reasoning) data.verdict_reasoning = PLACEHOLDER.DEMO;
      if (!data.score_basis)       data.score_basis       = PLACEHOLDER.DEMO;
      if (!data.demand_assessment) data.demand_assessment = PLACEHOLDER.PARTIAL;
      if (!data.icp_assessment)    data.icp_assessment    = PLACEHOLDER.PARTIAL;
      if (!Array.isArray(data.conditions)) data.conditions = [];
      if (!data.what_would_change_verdict) data.what_would_change_verdict = PLACEHOLDER.MISSING;
      break;
    }

    // ──────────────────────────────────────────────
    // PHASE 4 — Deal Lens
    // report.html consumers: target_roles, core_problem, solution_angle,
    //   solution_pitch, why_now, estimated_deal_size, sales_approach
    // ──────────────────────────────────────────────
    case 4: {
      if (!Array.isArray(data.target_roles) || data.target_roles.length === 0) {
        data.target_roles = [PLACEHOLDER.TEXT];
      }
      if (!data.core_problem)        data.core_problem        = PLACEHOLDER.DEMO;
      if (!data.solution_angle)      data.solution_angle      = PLACEHOLDER.TEXT;
      if (!data.solution_pitch)      data.solution_pitch      = PLACEHOLDER.TEXT;
      if (!data.why_now)             data.why_now             = PLACEHOLDER.TEXT;
      if (!data.estimated_deal_size) data.estimated_deal_size = PLACEHOLDER.MISSING;
      if (!data.sales_approach)      data.sales_approach      = PLACEHOLDER.TEXT;
      break;
    }

    // ──────────────────────────────────────────────
    // PHASE 5 — Risk & Confidence
    // report.html consumers: key_risks, confidence_level, confidence_score, validation_needed
    // ──────────────────────────────────────────────
    case 5: {
      if (!Array.isArray(data.key_risks) || data.key_risks.length === 0) {
        data.key_risks = [{
          risk:       PLACEHOLDER.DEMO,
          severity:   'Medium',
          mitigation: PLACEHOLDER.MISSING,
        }];
      }
      if (!data.confidence_level) data.confidence_level = PLACEHOLDER.LOW_STR;
      if (typeof data.confidence_score !== 'number') {
        const parsed = parseInt(data.confidence_score);
        data.confidence_score = isNaN(parsed) ? 30 : Math.max(0, Math.min(100, parsed));
      }
      if (!Array.isArray(data.validation_needed) || data.validation_needed.length === 0) {
        data.validation_needed = [PLACEHOLDER.MISSING];
      }
      break;
    }

    // ──────────────────────────────────────────────
    // PHASE 6 — Final Summary / Messaging
    // report.html consumers: signal_highlights, score_breakdown, verdict,
    //   deal_lens_summary, risks_summary, confidence_note, executive_brief, recommended_next_action
    // ──────────────────────────────────────────────
    case 6: {
      if (!Array.isArray(data.signal_highlights) || data.signal_highlights.length === 0) {
        data.signal_highlights = [PLACEHOLDER.TEXT];
      }
      if (!data.score_breakdown || typeof data.score_breakdown !== 'object') {
        data.score_breakdown = { demand: 0, timing: 0, icp: 0, data: 0, total: 0 };
      }
      if (!data.verdict)                 data.verdict                 = PLACEHOLDER.COND_GO;
      if (!data.deal_lens_summary)       data.deal_lens_summary       = PLACEHOLDER.TEXT;
      if (!data.risks_summary)           data.risks_summary           = PLACEHOLDER.TEXT;
      if (!data.confidence_note)         data.confidence_note         = PLACEHOLDER.TEXT;
      if (!data.executive_brief)         data.executive_brief         = PLACEHOLDER.DEMO;
      if (!data.recommended_next_action) data.recommended_next_action = PLACEHOLDER.TEXT;
      break;
    }

    // ──────────────────────────────────────────────
    // PHASE 7 — Revenue Intelligence
    // report.html consumers: signal_summary, go_no_go, mcc_view,
    //   persona_priority, executive_brief, report_pages, why_now_analysis
    // ──────────────────────────────────────────────
    case 7: {
      if (!Array.isArray(data.signal_summary) || data.signal_summary.length === 0) {
        data.signal_summary = [{
          signal_type:        'growth',
          signal_description: PLACEHOLDER.TEXT,
          strength:           'Low',
        }];
      }
      if (!data.go_no_go || typeof data.go_no_go !== 'object') {
        data.go_no_go = {
          recommendation: PLACEHOLDER.WATCH,
          reason:         PLACEHOLDER.DEMO,
        };
      } else {
        if (!data.go_no_go.recommendation) data.go_no_go.recommendation = PLACEHOLDER.WATCH;
        if (!data.go_no_go.reason)         data.go_no_go.reason         = PLACEHOLDER.DEMO;
      }
      if (!data.mcc_view || typeof data.mcc_view !== 'object') {
        data.mcc_view = {
          market:     PLACEHOLDER.MISSING,
          client:     PLACEHOLDER.MISSING,
          competitor: PLACEHOLDER.MISSING,
        };
      } else {
        if (!data.mcc_view.market)     data.mcc_view.market     = PLACEHOLDER.MISSING;
        if (!data.mcc_view.client)     data.mcc_view.client     = PLACEHOLDER.MISSING;
        if (!data.mcc_view.competitor) data.mcc_view.competitor = PLACEHOLDER.MISSING;
      }
      if (!data.executive_brief)    data.executive_brief    = PLACEHOLDER.DEMO;
      if (!data.why_now_analysis)   data.why_now_analysis   = PLACEHOLDER.TEXT;
      if (!data.strategic_hook)     data.strategic_hook     = '';
      if (!data.persona_priority || typeof data.persona_priority !== 'object') {
        data.persona_priority = { persona: 'CEO', reason: PLACEHOLDER.TEXT };
      }
      if (!Array.isArray(data.report_pages)) data.report_pages = [];
      if (!data.full_report_text) data.full_report_text = '';
      break;
    }
  }

  return data;
}

// ══════════════════════════════════════════════════════════════════
// SCHEMA VALIDATION
// Returns a structured result — never throws.
// ══════════════════════════════════════════════════════════════════

export function validateStepSchema(stepNumber, data) {
  const criticals = CRITICAL_FIELDS[stepNumber] || [];
  const missing   = criticals.filter(
    f => !(f in data) || data[f] === null || data[f] === undefined,
  );
  return {
    valid:        missing.length === 0,
    missing,
    provider:     data?._provider      || 'unknown',
    fallback_used: data?._fallback_used || false,
  };
}

// ══════════════════════════════════════════════════════════════════
// MAIN PROVIDER ROUTER
// Returns a normalized, validated result regardless of which provider
// was used. Consumers (handleRunStep, handleRunStep7) are provider-agnostic.
// ══════════════════════════════════════════════════════════════════

export async function routeProviderRequest(params, env) {
  const {
    step,
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature = 0.3,
  } = params;

  // Respect kill-switch (set ENABLE_PROVIDER_FAILOVER=false to disable Gemini fallback)
  const failoverEnabled = (env.ENABLE_PROVIDER_FAILOVER ?? 'true') !== 'false';

  // ── 1. Primary: OpenAI ──────────────────────────────────────────
  const primary       = await callOpenAI({ systemPrompt, userPrompt, maxTokens, temperature, step }, env);
  const primaryParsed = parseJSON(primary.rawText || '');
  const { fallback, reason } = shouldFallback(
    primary.statusCode,
    primary.fetchError  || null,
    primary.rawText     || '',
    primaryParsed,
    step,
  );

  // Primary succeeded and no critical issues → normalize and return
  if (!fallback && !primary.error) {
    const normalized = normalizeStepOutput(step, primaryParsed || {}, 'openai');
    console.log(`[provider-router] step=${step} provider=openai tokens=${primary.tokensUsed} status=${primary.statusCode}`);
    return {
      rawText:           primary.rawText,
      parsed:            normalized,
      tokensUsed:        primary.tokensUsed || 0,
      provider:          'openai',
      fallbackTriggered: false,
      fallbackReason:    null,
    };
  }

  // Client error (4xx — bad request, auth) — do not fallback, surface the error
  if (!fallback && primary.error) {
    return { error: primary.error, statusCode: primary.statusCode || 400 };
  }

  // Failover disabled — surface whatever we have
  if (!failoverEnabled) {
    console.warn(`[provider-router] step=${step} failover_disabled reason=${reason} status=${primary.statusCode}`);
    if (primaryParsed) {
      return {
        rawText:           primary.rawText,
        parsed:            normalizeStepOutput(step, primaryParsed, 'openai'),
        tokensUsed:        primary.tokensUsed || 0,
        provider:          'openai',
        fallbackTriggered: false,
        fallbackReason:    reason,
      };
    }
    return { error: `OpenAI failed (failover disabled): ${reason}`, statusCode: primary.statusCode || 502 };
  }

  // ── 2. Fallback: Gemini ─────────────────────────────────────────
  console.warn(
    `[provider-router] FALLBACK step=${step} reason=${reason} openai_status=${primary.statusCode} model=${GEMINI_PRO_STEPS.includes(step) ? GEMINI_PRO_MODEL : GEMINI_FLASH_MODEL}`,
  );

  const fallbackResult = await callGemini({ systemPrompt, userPrompt, maxTokens, temperature, step }, env);

  if (fallbackResult.error) {
    console.error(
      `[provider-router] BOTH_FAILED step=${step} openai_reason=${reason} gemini_error=${fallbackResult.error}`,
    );
    // Both failed — if we have any partial primary data, return it normalized with placeholders
    if (primaryParsed) {
      const degraded = normalizeStepOutput(step, primaryParsed, 'openai_degraded');
      return {
        rawText:           primary.rawText,
        parsed:            degraded,
        tokensUsed:        primary.tokensUsed || 0,
        provider:          'openai_degraded',
        fallbackTriggered: true,
        fallbackReason:    reason,
        bothFailed:        true,
      };
    }
    return {
      error:      `Both providers failed — OpenAI: ${reason} | Gemini: ${fallbackResult.error}`,
      statusCode: 502,
    };
  }

  const geminiParsed = parseJSON(fallbackResult.rawText || '');
  const normalized   = normalizeStepOutput(step, geminiParsed || {}, 'gemini');

  console.log(
    `[provider-router] step=${step} provider=gemini tokens=${fallbackResult.tokensUsed} fallback_reason=${reason}`,
  );

  return {
    rawText:           fallbackResult.rawText,
    parsed:            normalized,
    tokensUsed:        fallbackResult.tokensUsed || 0,
    provider:          'gemini',
    fallbackTriggered: true,
    fallbackReason:    reason,
  };
}

// ══════════════════════════════════════════════════════════════════
// RETRY HELPER
// Used by the internal parseWithRetry path in gtm.js.
// Retries with field-reminder prompt — routes through full fallback chain.
// ══════════════════════════════════════════════════════════════════

export async function retryWithProvider(step, originalPrompt, missingFields, env) {
  const systemPrompt = 'Return ONLY valid JSON. No markdown, no prose, no code fences. Start with { end with }.';
  const userPrompt   = `${originalPrompt}\n\nIMPORTANT: Your previous response was missing required fields: ${missingFields.join(', ')}. Return a complete JSON object that includes ALL required fields.`;
  return routeProviderRequest({
    step,
    systemPrompt,
    userPrompt,
    maxTokens:   1800,
    temperature: 0.2,
  }, env);
}
