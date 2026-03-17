/**
 * /api/analyze-website  (v2)
 * Cloudflare Pages Function
 *
 * Improvements over v1:
 *   - JWT auth
 *   - Structured extraction pipeline (title → meta → headings → body → lists → schema.org)
 *   - Entity extraction before AI (company name, founded year, tech keywords)
 *   - AI receives ONLY extracted text — never raw HTML
 *   - Explicit anti-hallucination system prompt
 *   - Result stored in company_enrichment table
 *   - Rate limited per user
 */

import { verifyAuth, corsHeaders, validate, rateLimit, sanitise, errRes, okRes, kv } from './_middleware.js';

// Keyword lists for tech stack and intent detection
const TECH_KEYWORDS = [
  'react','vue','angular','next.js','nuxt','svelte',
  'node.js','python','ruby','golang','rust','java','php',
  'postgres','mysql','mongodb','redis','elasticsearch',
  'aws','gcp','azure','cloudflare','vercel','netlify',
  'stripe','twilio','sendgrid','segment','mixpanel','amplitude',
  'hubspot','salesforce','marketo','intercom','zendesk',
  'kubernetes','docker','terraform','github actions',
  'graphql','rest api','websocket','grpc',
  'openai','langchain','pinecone','weaviate',
];

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // ── Auth ────────────────────────────────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  // ── Rate limit — website fetches are expensive ──────────────────
  if (!await rateLimit(`website:${user.id}`, env, 20, 60_000)) {
    return errRes('Too many website analysis requests. Please wait.', 429, cors);
  }

  const openaiKey   = env.OPENAI_API_KEY;
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY;
  if (!openaiKey) return errRes('OpenAI not configured', 503, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ website_url: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { website_url, company_name } = body;

  // ── Normalise URL ───────────────────────────────────────────────
  let url;
  try {
    const raw = website_url.trim();
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return errRes('Invalid URL format', 400, cors);
  }

  const hostname = url.hostname.replace(/^www\./, '');

  // ── Check KV cache first ────────────────────────────────────────
  const cacheKey = `website:${hostname}`;
  const cached   = await kv.get(env, cacheKey);
  if (cached) {
    return okRes({ ...cached, _cached: true, _cache_age_hours: Math.round((Date.now() - cached._cached_at) / 3_600_000) }, cors);
  }

  const t0 = Date.now();

  // ── STEP 1: Fetch homepage ──────────────────────────────────────
  let html = '';
  let fetchErr = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    const siteRes = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GTMBot/1.0)',
        'Accept':     'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);

    if (siteRes.ok) {
      html = await siteRes.text();
    } else {
      fetchErr = `HTTP ${siteRes.status}`;
    }
  } catch (e) {
    fetchErr = e.name === 'AbortError' ? 'Timeout after 12s' : e.message;
  }

  // ── STEP 2: Structured extraction pipeline ──────────────────────
  const extraction = extractAll(html, url, company_name);

  // ── STEP 3: Entity extraction (pre-AI, deterministic) ──────────
  const entities = extractEntities(extraction, html);

  // ── STEP 4: Build AI prompt with ONLY extracted content ─────────
  const hasContent = extraction.text.length > 100;

  const systemPrompt = `You are a company intelligence analyst. Your ONLY job is to extract and structure information that is EXPLICITLY present in the provided website text.

ABSOLUTE RULES:
1. NEVER invent or assume information not present in the text
2. NEVER use your training data about this company — only the provided text
3. If a field cannot be determined from the text, set it to null
4. Return ONLY valid JSON, no markdown, no prose`;

  const userPrompt = hasContent
    ? `Extract a structured company profile from this website content.

WEBSITE: ${url.toString()}
${company_name ? `COMPANY NAME (provided): ${company_name}` : ''}

PRE-EXTRACTED ENTITIES (use these as ground truth):
${JSON.stringify(entities, null, 2)}

WEBSITE TEXT (extracted, clean):
---
${extraction.text.slice(0, 5000)}
---

Return ONLY this JSON (null for anything not in the text):
{
  "company_name": "${company_name || 'extract from page title/headings'}",
  "company_overview": "2-3 sentences from the website text describing what they do",
  "services": ["service from site", "service from site"],
  "industry": "industry vertical based only on site content",
  "target_market": "who they sell to, from the website",
  "geography": "where they operate, from the website",
  "employee_range": null,
  "tech_stack_hints": ${JSON.stringify(entities.tech_stack)},
  "competitors_mentioned": ${JSON.stringify(entities.competitors)},
  "value_propositions": ["from their own words on the site"],
  "founded_year": ${entities.founded_year || null},
  "social_links": ${JSON.stringify(entities.social_links)},
  "extraction_confidence": "${hasContent ? 'HIGH' : 'LOW'}",
  "extraction_notes": "brief note on data quality"
}`
    : `Website content could not be extracted from ${url.toString()}.
${fetchErr ? `Error: ${fetchErr}` : ''}
${company_name ? `Company name provided: ${company_name}` : ''}

Return ONLY this JSON with nulls for unresolvable fields:
{
  "company_name": ${JSON.stringify(company_name || null)},
  "company_overview": null,
  "services": [],
  "industry": null,
  "target_market": null,
  "geography": null,
  "employee_range": null,
  "tech_stack_hints": [],
  "competitors_mentioned": [],
  "value_propositions": [],
  "founded_year": null,
  "social_links": {},
  "extraction_confidence": "LOW",
  "extraction_notes": "${fetchErr || 'No content extracted'}"
}`;

  // ── STEP 5: AI analysis ─────────────────────────────────────────
  let profile;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.05, max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      }),
    });
    if (!aiRes.ok) return errRes(`OpenAI error ${aiRes.status}`, aiRes.status, cors);
    const d     = await aiRes.json();
    const raw   = d.choices?.[0]?.message?.content || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const m     = clean.match(/\{[\s\S]*\}/);
    profile     = JSON.parse(m ? m[0] : clean);
  } catch (e) {
    return errRes('AI extraction failed: ' + e.message, 500, cors);
  }

  const result = {
    ...profile,
    _meta: {
      website_url:     url.toString(),
      hostname,
      fetch_success:   hasContent,
      fetch_error:     fetchErr,
      chars_extracted: extraction.text.length,
      duration_ms:     Date.now() - t0,
      _cached_at:      Date.now(),
    },
  };

  // ── STEP 6: Cache in KV (24h TTL) and Supabase ─────────────────
  await kv.put(env, cacheKey, result, 86400);

  // Save to company_enrichment table (non-blocking)
  if (supabaseUrl && supabaseKey) {
    saveEnrichment(user.id, company_name || profile.company_name, hostname, result, supabaseUrl, supabaseKey);
  }

  return okRes(result, cors);
}

// ══════════════════════════════════════════════════════════════════
// EXTRACTION PIPELINE
// ══════════════════════════════════════════════════════════════════
function extractAll(html, url, companyName) {
  if (!html) return { text: '', sections: {} };

  const sections = {};

  // 1. Page title
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (titleMatch) sections.title = titleMatch[1].trim();

  // 2. Meta tags
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)
                || html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
  if (metaDesc) sections.metaDescription = metaDesc[1].trim();

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i);
  const ogDesc  = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,500})["']/i);
  if (ogTitle) sections.ogTitle = ogTitle[1].trim();
  if (ogDesc)  sections.ogDesc  = ogDesc[1].trim();

  // 3. Schema.org JSON-LD (structured data — highest confidence)
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const schemaOrg = [];
  for (const m of jsonLdMatches) {
    try {
      const d = JSON.parse(m[1].trim());
      schemaOrg.push(d);
    } catch {}
  }
  if (schemaOrg.length) sections.schemaOrg = schemaOrg;

  // 4. Strip noise and extract body text
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');

  // 5. Headings
  const headings = [];
  const hRe = /<h([1-4])[^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let hm;
  while ((hm = hRe.exec(stripped)) !== null) {
    const t = stripTags(hm[2]).trim();
    if (t.length > 2 && t.length < 200) headings.push(`H${hm[1]}: ${t}`);
  }
  sections.headings = headings.slice(0, 30);

  // 6. Paragraphs
  const paragraphs = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(stripped)) !== null) {
    const t = stripTags(pm[1]).trim();
    if (t.length > 30 && t.length < 1000) paragraphs.push(t);
  }
  sections.paragraphs = paragraphs.slice(0, 25);

  // 7. List items (features, services)
  const listItems = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let lm;
  while ((lm = liRe.exec(stripped)) !== null) {
    const t = stripTags(lm[1]).trim();
    if (t.length > 5 && t.length < 200) listItems.push(t);
  }
  sections.listItems = listItems.slice(0, 40);

  // Assemble full text in priority order
  const parts = [];
  if (sections.title)          parts.push(`PAGE TITLE: ${sections.title}`);
  if (sections.metaDescription) parts.push(`META: ${sections.metaDescription}`);
  if (sections.ogDesc)          parts.push(`OG DESC: ${sections.ogDesc}`);
  if (sections.schemaOrg?.length) {
    const orgs = sections.schemaOrg.filter(s => s['@type'] === 'Organization' || s['@type'] === 'WebSite');
    if (orgs.length) parts.push(`STRUCTURED DATA: ${JSON.stringify(orgs[0]).slice(0, 500)}`);
  }
  if (sections.headings?.length) parts.push(`HEADINGS:\n${sections.headings.join('\n')}`);
  if (sections.paragraphs?.length) parts.push(`CONTENT:\n${sections.paragraphs.join('\n')}`);
  if (sections.listItems?.length)  parts.push(`FEATURES/SERVICES:\n${sections.listItems.join('\n')}`);

  return { text: parts.join('\n\n'), sections };
}

function extractEntities(extraction, html) {
  const text = extraction.text.toLowerCase();

  // Tech stack detection
  const tech_stack = TECH_KEYWORDS.filter(kw => {
    const re = new RegExp(`\\b${kw.replace(/\./g, '\\.')}\\b`, 'i');
    return re.test(text) || re.test(html);
  });

  // Founded year detection
  const yearMatch = html.match(/founded\s+(?:in\s+)?(\d{4})|est\.?\s+(\d{4})|since\s+(\d{4})|(\d{4})\s+–\s+(?:present|today)/i);
  const founded_year = yearMatch
    ? parseInt(yearMatch[1] || yearMatch[2] || yearMatch[3] || yearMatch[4])
    : null;

  // Social links
  const social_links = {};
  const linkedinMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/([^"'\s>]+)/);
  const twitterMatch  = html.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([^"'\s>/?]+)/);
  const githubMatch   = html.match(/https?:\/\/(?:www\.)?github\.com\/([^"'\s>/?]+)/);
  if (linkedinMatch) social_links.linkedin = linkedinMatch[0];
  if (twitterMatch)  social_links.twitter  = twitterMatch[0];
  if (githubMatch)   social_links.github   = githubMatch[0];

  // Competitor mentions (look for vs / compared to / alternatives to)
  const competitorRe = /(?:vs\.?|versus|compared to|alternative to|competitor)\s+([A-Z][a-zA-Z0-9]+(?:\.[a-z]{2,4})?)/g;
  const competitors  = [];
  let cm;
  while ((cm = competitorRe.exec(extraction.text)) !== null) {
    if (cm[1].length > 2 && cm[1].length < 30) competitors.push(cm[1]);
  }

  return { tech_stack, founded_year, social_links, competitors: [...new Set(competitors)].slice(0, 5) };
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function saveEnrichment(userId, companyName, source, payload, url, key) {
  if (!companyName) return;
  try {
    await fetch(`${url}/rest/v1/company_enrichment?on_conflict=company_name,source,user_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId, company_name: companyName, source: 'website',
        payload: payload, tech_stack: payload.tech_stack_hints || [],
        enriched_at: new Date().toISOString(),
      }),
    });
  } catch {}
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
