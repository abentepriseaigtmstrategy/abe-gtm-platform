/**
 * enrichment-pipeline.js  —  Layer 3: Pre-Generation Research Pipeline
 * ABE GTM Platform  ·  Cloudflare Workers compatible
 *
 * Architecture role:
 *   Runs BEFORE any step prompt is built. Populates a structured
 *   EVIDENCE LAYER that is injected into every prompt as hard grounding
 *   context — replacing "NO VERIFIED COMPANY PROFILE AVAILABLE" with
 *   real, sourced signals.
 *
 * Source waterfall (tries in order, stops at first success):
 *   1. Brave Search API   (env: BRAVE_SEARCH_API_KEY)   — real-time web news
 *   2. Serper API         (env: SERPER_API_KEY)          — Google Search JSON
 *   3. AI Research Brief  (env: OPENAI_API_KEY, always available)
 *      → dedicated pre-flight prompt extracts structured signals from
 *        the AI's training knowledge + scraping signals from company_url
 *   4. Scraped profile    (existing scraped_profile field) — last resort
 *
 * Returns: EnrichmentResult
 *   {
 *     company:             string
 *     industry:            string | null
 *     signals:             SignalRecord[]     observable company signals
 *     funding:             FundingRecord      last known funding
 *     hiring:              HiringRecord       hiring velocity signals
 *     recentNews:          NewsItem[]         last 90d news
 *     competitiveLandscape: string[]          named competitors
 *     techStack:           string[]           detected tech
 *     marketContext:       string             1-2 sentence market framing
 *     sourceQuality:       'live'|'ai_research'|'scraped'|'none'
 *     sourcesUsed:         string[]
 *     enrichedAt:          string             ISO timestamp
 *     cacheKey:            string
 *   }
 *
 * Caching:
 *   Results are cached in the `company_enrichment` Supabase table for 24h.
 *   Cache key = sha256(company_name_lower + industry_lower).
 *   This prevents redundant enrichment calls on step retries.
 */

import { getMatchedBenchmarks, formatBenchmarkForPrompt } from './industry-benchmarks.js';

// ── Constants ─────────────────────────────────────────────────────
const BRAVE_ENDPOINT  = 'https://api.search.brave.com/res/v1/web/search';
const SERPER_ENDPOINT = 'https://google.serper.dev/search';
// ── AI Research provider endpoints (used by generateResearchBrief waterfall) ──
const OPENAI_ENDPOINT  = 'https://api.openai.com/v1/chat/completions';
const GEMINI_ENDPOINT  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
const GROQ_ENDPOINT    = 'https://api.groq.com/openai/v1/chat/completions';
const CACHE_TTL_HOURS  = 24;
const REQUEST_TIMEOUT  = 8_000; // ms — hard abort if external source hangs

// ── Fetch with timeout (Cloudflare Workers compatible) ────────────
async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Cache key ─────────────────────────────────────────────────────
export function buildEnrichmentCacheKey(company, industry) {
  const raw = `${(company || '').toLowerCase().trim()}::${(industry || '').toLowerCase().trim()}`;
  // Simple deterministic hash — no crypto needed for cache key
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return `enrich_${Math.abs(h).toString(36)}`;
}

// ── Empty result skeleton ─────────────────────────────────────────
function emptyResult(company, industry, sourceQuality = 'none') {
  return {
    company:              company || '',
    industry:             industry || null,
    signals:              [],
    funding:              null,
    hiring:               null,
    recentNews:           [],
    competitiveLandscape: [],
    techStack:            [],
    marketContext:        '',
    sourceQuality,
    sourcesUsed:          [],
    enrichedAt:           new Date().toISOString(),
    cacheKey:             buildEnrichmentCacheKey(company, industry),
  };
}

// ─────────────────────────────────────────────────────────────────
// SOURCE 1: Brave Search API
// ─────────────────────────────────────────────────────────────────
async function fetchBraveSignals(company, industry, apiKey) {
  const queries = [
    `"${company}" funding hiring expansion 2024 2025`,
    `"${company}" ${industry || ''} product launch partnership announcement`,
  ];

  const results = [];

  for (const q of queries) {
    try {
      const res = await fetchWithTimeout(BRAVE_ENDPOINT + '?' + new URLSearchParams({
        q,
        count: '5',
        freshness: 'py',   // past year
        text_decorations: '0',
        search_lang: 'en',
      }), {
        headers: {
          'Accept':              'application/json',
          'Accept-Encoding':     'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!res.ok) continue;
      const data = await res.json();
      const items = data?.web?.results || [];
      results.push(...items.map(r => ({
        title:       r.title       || '',
        description: r.description || '',
        url:         r.url         || '',
        age:         r.age         || null,
      })));
    } catch (e) {
      console.warn(`[enrichment] Brave query failed: ${e.message}`);
    }
  }

  return results;
}

function parseBraveResults(items, company) {
  const companyLower = company.toLowerCase();
  const signals = [];
  const news    = [];

  for (const item of items) {
    const text = `${item.title} ${item.description}`.toLowerCase();
    if (!text.includes(companyLower)) continue;

    news.push({ headline: item.title, summary: item.description, url: item.url, date: item.age });

    // Extract signal type
    if (/\$[\d.]+[mb]/i.test(text) || /funding|raised|series [a-e]|seed|round/i.test(text)) {
      signals.push({ signal: item.title, type: 'funding', strength: 'High', source: 'brave_search' });
    } else if (/hiring|engineer|head of|vp |director|seeking/i.test(text)) {
      signals.push({ signal: item.title, type: 'hiring', strength: 'Medium', source: 'brave_search' });
    } else if (/launch|partner|acqui|expansion|new market/i.test(text)) {
      signals.push({ signal: item.title, type: 'expansion', strength: 'High', source: 'brave_search' });
    }
  }

  return { signals: signals.slice(0, 6), recentNews: news.slice(0, 4) };
}

// ─────────────────────────────────────────────────────────────────
// SOURCE 2: Serper API (Google Search JSON)
// ─────────────────────────────────────────────────────────────────
async function fetchSerperSignals(company, industry, apiKey) {
  const query = `"${company}" ${industry || ''} funding OR hiring OR expansion OR product launch 2024 2025`;

  try {
    const res = await fetchWithTimeout(SERPER_ENDPOINT, {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: query, num: 8, tbs: 'qdr:y' }),
    });

    if (!res.ok) return [];
    const data  = await res.json();
    const items = [...(data.organic || []), ...(data.news || [])];
    return items.map(r => ({
      title:       r.title       || '',
      description: r.snippet     || '',
      url:         r.link        || '',
      age:         r.date        || null,
    }));
  } catch (e) {
    console.warn(`[enrichment] Serper query failed: ${e.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// SOURCE 3: AI Research Pre-flight (always available fallback)
// Uses a dedicated, tightly-scoped research prompt — NOT the main
// generation chain. Extracts structured intelligence from model
// training knowledge + any signals in the scraped profile.
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// SOURCE 3: AI Research Brief — provider waterfall
// OpenAI → Gemini → Groq → null (benchmark-only safe fallback)
//
// Uses fetchWithTimeout and AbortController from above — unchanged.
// Each provider attempt is fully isolated: a failure in one never
// affects the next. All parsing logic is shared via parseRawBrief().
// ─────────────────────────────────────────────────────────────────

/** Build the research prompt — identical for every provider */
function buildResearchPrompt(company, industry, companyUrl, scrapedProfile) {
  const profileSnippet = scrapedProfile?.company_overview
    ? `Known from website scrape: ${scrapedProfile.company_overview.slice(0, 400)}`
    : '';

  return `You are a B2B market research analyst. Extract ONLY factual, observable information about "${company}"${industry ? ` (${industry} sector)` : ''}.${companyUrl ? ` Company URL: ${companyUrl}` : ''}

${profileSnippet}

Return ONLY a valid JSON object with this exact structure. If you do not have factual knowledge of a field, use null — do NOT invent facts.

{
  "company_description": "1-2 sentence factual description of what the company does, or null",
  "founded_year": null or number,
  "employee_count_estimate": "e.g. 50-200, 500-1000, or null if unknown",
  "funding_status": "bootstrapped|seed|series_a|series_b|series_c_plus|public|acquired|unknown",
  "last_known_funding": "e.g. $12M Series A (2023) or null",
  "known_customers": ["customer1", "customer2"] or [],
  "key_products": ["product1", "product2"] or [],
  "detected_tech_stack": ["e.g. Stripe, AWS, React, Salesforce"] or [],
  "known_competitors": ["competitor1", "competitor2"] or [],
  "recent_signals": [
    {"signal": "observable fact e.g. opened London office Q1 2024", "type": "expansion|hiring|product_launch|partnership|funding", "confidence": "high|medium|low"}
  ],
  "market_context": "1 sentence on the specific market niche this company occupies, or null",
  "icp_hint": "who most likely buys from this company based on their product, or null",
  "knowledge_confidence": "high|medium|low",
  "knowledge_caveat": "brief note on what is unknown or uncertain"
}`;
}

/** Parse raw text from any provider into the brief JSON object */
function parseRawBrief(rawText) {
  if (!rawText) return null;
  const clean = rawText.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

/** Attempt OpenAI (gpt-4o-mini) */
async function tryOpenAIBrief(prompt, apiKey) {
  const res = await fetchWithTimeout(OPENAI_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       'gpt-4o-mini',
      max_tokens:  800,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a factual B2B research analyst. Return only valid JSON. No markdown. No prose.' },
        { role: 'user',   content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

/** Attempt Gemini (gemini-1.5-flash) */
async function tryGeminiBrief(prompt, apiKey) {
  const url = `${GEMINI_ENDPOINT}?key=${apiKey}`;
  const res = await fetchWithTimeout(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: `You are a factual B2B research analyst. Return only valid JSON. No markdown. No prose.\n\n${prompt}` }],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

/** Attempt Groq (llama3-8b-8192 — lightweight, fast) */
async function tryGroqBrief(prompt, apiKey) {
  const res = await fetchWithTimeout(GROQ_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       'llama3-8b-8192',
      max_tokens:  800,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a factual B2B research analyst. Return only valid JSON. No markdown. No prose.' },
        { role: 'user',   content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

/**
 * generateResearchBrief(company, industry, companyUrl, scrapedProfile, env)
 *
 * Provider waterfall: OpenAI → Gemini → Groq → null
 *
 * Rules:
 *   - Each provider is tried independently with full timeout isolation
 *   - A provider failure (HTTP error, timeout, parse error) silently
 *     advances to the next — it never stops report generation
 *   - If all three fail, returns null → enrichCompany degrades to
 *     benchmark-only mode, Step 2 remains grounded via industry benchmarks
 *   - providerUsed is attached to the result for telemetry
 */
async function generateResearchBrief(company, industry, companyUrl, scrapedProfile, env) {
  const prompt = buildResearchPrompt(company, industry, companyUrl, scrapedProfile);

  const providers = [
    {
      name:    'openai',
      key:     env?.OPENAI_API_KEY,
      attempt: (p, k) => tryOpenAIBrief(p, k),
    },
    {
      name:    'gemini',
      key:     env?.GEMINI_API_KEY,
      attempt: (p, k) => tryGeminiBrief(p, k),
    },
    {
      name:    'groq',
      key:     env?.GROQ_API_KEY,
      attempt: (p, k) => tryGroqBrief(p, k),
    },
  ];

  for (const provider of providers) {
    if (!provider.key) {
      console.info(`[enrichment] research brief: ${provider.name} skipped (no API key)`);
      continue;
    }

    try {
      const rawText = await provider.attempt(prompt, provider.key);
      const parsed  = parseRawBrief(rawText);

      if (parsed && typeof parsed === 'object') {
        console.info(`[enrichment] research brief: ${provider.name} succeeded`);
        parsed._research_provider = provider.name;
        return parsed;
      }

      console.warn(`[enrichment] research brief: ${provider.name} returned unparseable output`);
    } catch (e) {
      // Timeout (AbortError), HTTP error, or network failure — advance to next
      console.warn(`[enrichment] research brief: ${provider.name} failed — ${e.message}`);
    }
  }

  // All providers failed — return null, enrichCompany handles benchmark-only degradation
  console.warn('[enrichment] research brief: all providers failed — degrading to benchmark-only mode');
  return null;
}

function parseAIBrief(brief, company) {
  if (!brief) return { signals: [], recentNews: [] };

  const signals = (brief.recent_signals || [])
    .filter(s => s?.signal && s.confidence !== 'low')
    .map(s => ({ signal: s.signal, type: s.type || 'expansion', strength: s.confidence === 'high' ? 'High' : 'Medium', source: 'ai_research' }));

  return { signals: signals.slice(0, 5), recentNews: [] };
}

// ─────────────────────────────────────────────────────────────────
// SOURCE 4: Scraped Profile (existing scraped_profile field)
// ─────────────────────────────────────────────────────────────────
function parseScrapedProfile(scrapedProfile, company) {
  if (!scrapedProfile || typeof scrapedProfile !== 'object') return { signals: [], recentNews: [] };

  const signals = [];
  if (scrapedProfile.services?.length) {
    signals.push({ signal: `Known services: ${scrapedProfile.services.slice(0,3).join(', ')}`, type: 'product_launch', strength: 'Medium', source: 'scraped_profile' });
  }
  if (scrapedProfile.tech_stack_hints?.length) {
    signals.push({ signal: `Tech stack detected: ${scrapedProfile.tech_stack_hints.slice(0,3).join(', ')}`, type: 'expansion', strength: 'Low', source: 'scraped_profile' });
  }

  return { signals: signals.slice(0, 3), recentNews: [] };
}

// ─────────────────────────────────────────────────────────────────
// MAIN: enrichCompany
// ─────────────────────────────────────────────────────────────────
/**
 * enrichCompany({ company, industry, companyUrl, scrapedProfile, env })
 *
 * Runs the full enrichment waterfall and returns a structured
 * EnrichmentResult for injection into the prompt EVIDENCE LAYER.
 *
 * @returns {EnrichmentResult}
 */
export async function enrichCompany({ company, industry, companyUrl, scrapedProfile, env }) {
  const result    = emptyResult(company, industry);
  const benchmark = getMatchedBenchmarks(industry);

  // ── Try Source 1: Brave ────────────────────────────────────────
  if (env?.BRAVE_SEARCH_API_KEY) {
    try {
      const raw    = await fetchBraveSignals(company, industry, env.BRAVE_SEARCH_API_KEY);
      const parsed = parseBraveResults(raw, company);
      if (parsed.signals.length > 0 || parsed.recentNews.length > 0) {
        result.signals.push(...parsed.signals);
        result.recentNews.push(...parsed.recentNews);
        result.sourcesUsed.push('brave_search');
        result.sourceQuality = 'live';
      }
    } catch (e) {
      console.warn(`[enrichment] Brave source failed: ${e.message}`);
    }
  }

  // ── Try Source 2: Serper (if Brave didn't produce enough) ─────
  if (result.signals.length < 3 && env?.SERPER_API_KEY) {
    try {
      const raw    = await fetchSerperSignals(company, industry, env.SERPER_API_KEY);
      const parsed = parseBraveResults(raw, company); // same parser structure
      if (parsed.signals.length > 0) {
        result.signals.push(...parsed.signals);
        result.recentNews.push(...parsed.recentNews);
        result.sourcesUsed.push('serper');
        if (result.sourceQuality === 'none') result.sourceQuality = 'live';
      }
    } catch (e) {
      console.warn(`[enrichment] Serper source failed: ${e.message}`);
    }
  }

  // ── Try Source 3: AI Research Brief — provider waterfall ────────
  // Runs regardless of which live search sources succeeded.
  // OpenAI → Gemini → Groq → null (benchmark-only safe fallback).
  // At least one provider key must exist; if none configured, skips silently.
  const hasAnyProvider = !!(env?.OPENAI_API_KEY || env?.GEMINI_API_KEY || env?.GROQ_API_KEY);
  if (hasAnyProvider) {
    try {
      const brief  = await generateResearchBrief(company, industry, companyUrl, scrapedProfile, env);
      const parsed = parseAIBrief(brief, company);

      if (brief) {
        // Merge AI brief fields into result
        if (brief.company_description)      result.marketContext        = brief.market_context || brief.company_description;
        if (brief.detected_tech_stack?.length) result.techStack          = brief.detected_tech_stack.filter(Boolean);
        if (brief.known_competitors?.length)   result.competitiveLandscape = brief.known_competitors.filter(Boolean);
        if (brief.last_known_funding)          result.funding            = { summary: brief.last_known_funding, status: brief.funding_status };
        if (brief.employee_count_estimate)     result.hiring             = { size_estimate: brief.employee_count_estimate };
        if (brief.icp_hint)                    result.icpHint            = brief.icp_hint;
        if (brief.knowledge_confidence)        result.aiKnowledgeConfidence = brief.knowledge_confidence;
        if (brief.knowledge_caveat)            result.aiKnowledgeCaveat  = brief.knowledge_caveat;

        result.signals.push(...parsed.signals);
        result.sourcesUsed.push(`ai_research:${brief._research_provider || 'unknown'}`);
        if (result.sourceQuality === 'none') result.sourceQuality = 'ai_research';
      }
    } catch (e) {
      console.warn(`[enrichment] AI research brief failed: ${e.message}`);
    }
  }

  // ── Source 4: Scraped profile (always run as supplement) ──────
  if (scrapedProfile) {
    const parsed = parseScrapedProfile(scrapedProfile, company);
    result.signals.push(...parsed.signals);
    if (!result.sourcesUsed.includes('scraped_profile')) {
      result.sourcesUsed.push('scraped_profile');
      if (result.sourceQuality === 'none') result.sourceQuality = 'scraped';
    }
    // Supplement tech stack and market context from scraped profile
    if (!result.marketContext && scrapedProfile.company_overview) {
      result.marketContext = scrapedProfile.company_overview.slice(0, 200);
    }
    if (scrapedProfile.tech_stack_hints?.length && result.techStack.length === 0) {
      result.techStack = scrapedProfile.tech_stack_hints;
    }
  }

  // ── Deduplicate signals ───────────────────────────────────────
  const seen = new Set();
  result.signals = result.signals.filter(s => {
    const key = (s.signal || '').toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  // ── Attach benchmark ──────────────────────────────────────────
  result.benchmark       = benchmark.benchmark;
  result.benchmarkPrompt = formatBenchmarkForPrompt(benchmark);
  result.enrichedAt      = new Date().toISOString();

  return result;
}

// ─────────────────────────────────────────────────────────────────
// PROMPT FORMATTER
// Converts EnrichmentResult into a compact, prompt-injectable block
// ─────────────────────────────────────────────────────────────────

/**
 * formatEnrichmentForPrompt(enrichment)
 * Returns the EVIDENCE LAYER string injected into every step prompt.
 * This replaces the current "NO VERIFIED COMPANY PROFILE AVAILABLE" block.
 */
export function formatEnrichmentForPrompt(enrichment) {
  if (!enrichment || enrichment.sourceQuality === 'none') {
    return `EVIDENCE LAYER: No external enrichment data available. Output is AI estimation — mark all fields as requiring manual validation.`;
  }

  const lines = [];
  lines.push(`EVIDENCE LAYER (source: ${enrichment.sourcesUsed.join(', ')} · quality: ${enrichment.sourceQuality} · as of ${enrichment.enrichedAt?.slice(0,10) || 'unknown'})`);
  lines.push(`Company: ${enrichment.company}`);

  if (enrichment.marketContext) {
    lines.push(`Market context: ${enrichment.marketContext}`);
  }

  if (enrichment.funding?.summary) {
    lines.push(`Funding: ${enrichment.funding.summary} (status: ${enrichment.funding.status || 'unknown'})`);
  }

  if (enrichment.hiring?.size_estimate) {
    lines.push(`Team size: ~${enrichment.hiring.size_estimate} employees`);
  }

  if (enrichment.techStack?.length) {
    lines.push(`Tech stack signals: ${enrichment.techStack.slice(0,5).join(', ')}`);
  }

  if (enrichment.competitiveLandscape?.length) {
    lines.push(`Known competitors: ${enrichment.competitiveLandscape.slice(0,4).join(', ')}`);
  }

  if (enrichment.icpHint) {
    lines.push(`ICP hint: ${enrichment.icpHint}`);
  }

  if (enrichment.signals?.length) {
    lines.push(`Observable signals (${enrichment.signals.length}):`);
    enrichment.signals.slice(0, 5).forEach(s => {
      lines.push(`  · [${s.type}/${s.strength}] ${s.signal}`);
    });
  }

  if (enrichment.recentNews?.length) {
    lines.push(`Recent news:`);
    enrichment.recentNews.slice(0, 3).forEach(n => {
      lines.push(`  · ${n.headline}${n.date ? ` (${n.date})` : ''}`);
    });
  }

  if (enrichment.aiKnowledgeCaveat) {
    lines.push(`Research caveat: ${enrichment.aiKnowledgeCaveat}`);
  }

  // Always append benchmark reference for Step 2 grounding
  if (enrichment.benchmarkPrompt) {
    lines.push('');
    lines.push(enrichment.benchmarkPrompt);
  }

  lines.push(`\nRULE: Use the EVIDENCE LAYER above as ground truth. Do NOT invent facts not present above. Fields with no evidence must use "missing data" — not AI estimation.`);

  return lines.join('\n');
}

/**
 * formatBenchmarkOnlyPrompt(industry)
 * Lightweight version used when full enrichment is unavailable.
 * Injects only the benchmark reference for TAM grounding.
 */
export function formatBenchmarkOnlyPrompt(industry) {
  const benchmark = getMatchedBenchmarks(industry);
  return formatBenchmarkForPrompt(benchmark);
}
