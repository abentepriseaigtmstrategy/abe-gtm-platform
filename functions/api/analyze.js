/**
 * /api/analyze
 * Cloudflare Pages Function — Lead Analysis Proxy
 *
 * Security hardening:
 *   - OpenAI key server-side only (env var)
 *   - Per-IP rate limiting (10 req/min via CF KV or in-memory window)
 *   - Request size limit (32kb)
 *   - Input sanitisation
 *   - Error messages never leak internal details
 */

// Rate limit: max requests per IP per minute
const RATE_LIMIT_RPM = 10;

// In-memory rate limit map (resets on Worker cold start — acceptable for this use case)
// For persistent rate limiting, use Cloudflare KV: env.RATE_LIMIT_KV
const _ipWindows = new Map();

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ── 1. API key guard ───────────────────────────────────────────
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return errRes('Service temporarily unavailable.', 503, corsHeaders);
  }

  // ── 2. Request size limit (32kb) ───────────────────────────────
  const contentLength = parseInt(request.headers.get('content-length') || '0');
  if (contentLength > 32768) {
    return errRes('Request too large.', 413, corsHeaders);
  }

  // ── 3. Per-IP rate limiting ────────────────────────────────────
  const clientIP = request.headers.get('CF-Connecting-IP')
                || request.headers.get('X-Forwarded-For')?.split(',')[0]
                || 'unknown';

  if (!checkRateLimit(clientIP)) {
    return errRes('Too many requests. Please wait a moment.', 429, corsHeaders);
  }

  // ── 4. Parse body ──────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return errRes('Invalid request body.', 400, corsHeaders);
  }

  const { lead, customPrompt } = body;

  if (!lead || typeof lead.name !== 'string') {
    return errRes('Missing required field: lead.name', 400, corsHeaders);
  }

  // ── 5. Sanitise inputs ─────────────────────────────────────────
  const safeLead = {
    name:    sanitise(lead.name,    100),
    title:   sanitise(lead.title,   100),
    company: sanitise(lead.company, 100),
  };

  const safePrompt = customPrompt
    ? sanitise(String(customPrompt), 8000)
    : null;

  // ── 6. Build prompt ────────────────────────────────────────────
  const prompt = safePrompt || buildLeadPrompt(safeLead);

  // ── 7. Check Supabase cache (skip OpenAI if cached) ───────────
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY;
  if (!safePrompt && supabaseUrl && supabaseKey) {
    const cached = await getCachedAnalysis(safeLead.name, safeLead.company, supabaseUrl, supabaseKey);
    if (cached) {
      return new Response(JSON.stringify({ ...cached, _cached: true }), { status: 200, headers: corsHeaders });
    }
  }

  // ── 8. Call OpenAI ─────────────────────────────────────────────
  const t0 = Date.now();
  let openAIResponse;
  try {
    openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        temperature: 0.7,
        max_tokens:  safePrompt ? 2500 : 800,
        messages: [
          {
            role:    'system',
            content: 'You are a B2B GTM strategist. Respond with valid JSON only. No markdown, no code fences.',
          },
          {
            role:    'user',
            content: prompt,
          },
        ],
      }),
    });
  } catch (fetchErr) {
    // Never expose internal error details
    console.error('OpenAI fetch error:', fetchErr.message);
    return errRes('AI service temporarily unreachable. Please try again.', 502, corsHeaders);
  }

  // ── 9. Handle OpenAI error responses ──────────────────────────
  if (!openAIResponse.ok) {
    const status = openAIResponse.status;
    if (status === 429) return errRes('AI quota exceeded. Please try again shortly.', 429, corsHeaders);
    if (status === 401) return errRes('AI service configuration error.', 500, corsHeaders);
    console.error('OpenAI error status:', status);
    return errRes('AI service error. Please try again.', 502, corsHeaders);
  }

  // ── 10. Parse AI result ────────────────────────────────────────
  const aiData  = await openAIResponse.json();
  const rawText = aiData.choices?.[0]?.message?.content || '{}';
  const tokens  = aiData.usage?.total_tokens || 0;
  const duration = Date.now() - t0;

  let parsed;
  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    parsed        = JSON.parse(match ? match[0] : cleaned);
  } catch {
    return errRes('AI returned unexpected format. Please try again.', 422, corsHeaders);
  }

  // ── 11. Cache result in Supabase (non-blocking, lead analyses only) ──
  if (!safePrompt && supabaseUrl && supabaseKey) {
    cacheAnalysis(safeLead.name, safeLead.company, parsed, tokens, supabaseUrl, supabaseKey);
  }

  // ── 12. Log usage (non-blocking) ──────────────────────────────
  if (supabaseUrl && supabaseKey) {
    logUsage(null, 'lead_analysis', null, safeLead.company, tokens, duration, supabaseUrl, supabaseKey);
  }

  return new Response(JSON.stringify(parsed), { status: 200, headers: corsHeaders });
}

// ── PROMPT BUILDER ─────────────────────────────────────────────────
function buildLeadPrompt(lead) {
  return `Analyze the following B2B lead and generate GTM intelligence.

Name: ${lead.name}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}

Return ONLY a valid JSON object with exactly these keys:
"Pain Area", "Key Insight", "Proposed Solution", "Cold Outreach Message".
No markdown, no explanation. Just the raw JSON object.`;
}

// ── IN-MEMORY RATE LIMITER ─────────────────────────────────────────
function checkRateLimit(ip) {
  const now     = Date.now();
  const windowMs = 60_000;
  const entry   = _ipWindows.get(ip) || { count: 0, start: now };

  if (now - entry.start > windowMs) {
    _ipWindows.set(ip, { count: 1, start: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_RPM) return false;

  entry.count++;
  _ipWindows.set(ip, entry);
  return true;
}

// ── SUPABASE CACHE ─────────────────────────────────────────────────
async function getCachedAnalysis(name, company, url, key) {
  try {
    const cacheKey  = `${name.toLowerCase()}|${(company || '').toLowerCase()}`;
    const res = await fetch(
      `${url}/rest/v1/leads?name=ilike.${encodeURIComponent(name)}&company=ilike.${encodeURIComponent(company || '')}&gtm_analysis=not.is.null&limit=1&order=updated_at.desc`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.length > 0 && data[0].gtm_analysis && Object.keys(data[0].gtm_analysis).length > 0) {
      return data[0].gtm_analysis;
    }
    return null;
  } catch { return null; }
}

async function cacheAnalysis(name, company, analysis, tokens, url, key) {
  try {
    // Update matching leads with their analysis result (non-blocking)
    await fetch(
      `${url}/rest/v1/leads?name=ilike.${encodeURIComponent(name)}&company=ilike.${encodeURIComponent(company || '')}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ gtm_analysis: analysis, status: 'analyzed' }),
      }
    );
  } catch {}
}

async function logUsage(userId, runType, step, company, tokens, duration, url, key) {
  try {
    await fetch(`${url}/rest/v1/analysis_runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId, run_type: runType, step_number: step,
        company_name: company, tokens_used: tokens,
        cost_usd: tokens * 0.0000002, model: 'gpt-4o-mini',
        duration_ms: duration,
      }),
    });
  } catch {}
}

// ── INPUT SANITISER ────────────────────────────────────────────────
function sanitise(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')   // strip any HTML tags
    .replace(/[\x00-\x08\x0b\x0e-\x1f]/g, '')  // strip control chars
    .trim()
    .slice(0, maxLen);
}

function errRes(msg, status, headers) {
  return new Response(JSON.stringify({ error: msg }), { status, headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
