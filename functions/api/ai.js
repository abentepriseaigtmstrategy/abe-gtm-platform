/**
 * ai.js — Shared OpenAI wrapper for all Workers
 *
 * Single point of control for:
 *   - all OpenAI API calls (key stays server-side)
 *   - retry logic
 *   - JSON extraction
 *   - token tracking
 *   - cost calculation
 */

const COST_PER_TOKEN = 0.0000002; // gpt-4o-mini blended

/**
 * Call OpenAI and return { data, tokens, cost }.
 * Always parses JSON from the response.
 *
 * @param {string}   apiKey   — from env.OPENAI_API_KEY
 * @param {string}   prompt   — user prompt
 * @param {object}   options  — { system, temperature, max_tokens, model }
 * @param {number}   retries  — auto-retry on parse failure (default 1)
 */
export async function callAI(apiKey, prompt, options = {}, retries = 1) {
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const {
    system      = 'You are a B2B GTM analyst. Return ONLY valid JSON. No markdown, no prose.',
    temperature = 0.3,
    max_tokens  = 1000,
    model       = 'gpt-4o-mini',
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error('OpenAI rate limit reached. Please wait.');
      if (res.status === 401) throw new Error('OpenAI API key invalid.');
      if (attempt < retries) { await sleep(1500); continue; }
      throw new Error(`OpenAI error ${res.status}: ${e?.error?.message || 'unknown'}`);
    }

    const d       = await res.json();
    const rawText = d.choices?.[0]?.message?.content || '{}';
    const tokens  = d.usage?.total_tokens || 0;
    const cost    = tokens * COST_PER_TOKEN;

    const parsed = extractJSON(rawText);
    if (!parsed && attempt < retries) { await sleep(1500); continue; }
    if (!parsed) throw new Error('AI returned unparseable response after retries');

    return { data: parsed, tokens, cost, raw: rawText };
  }
}

/**
 * Call OpenAI for a free-text (non-JSON) response.
 */
export async function callAIText(apiKey, prompt, options = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const {
    system      = 'You are a B2B GTM analyst.',
    temperature = 0.5,
    max_tokens  = 500,
    model       = 'gpt-4o-mini',
  } = options;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model, temperature, max_tokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`OpenAI error ${res.status}: ${e?.error?.message || 'unknown'}`);
  }

  const d      = await res.json();
  const text   = d.choices?.[0]?.message?.content || '';
  const tokens = d.usage?.total_tokens || 0;
  return { text, tokens, cost: tokens * COST_PER_TOKEN };
}

/**
 * Extract a JSON object or array from a string that may contain prose or markdown.
 */
export function extractJSON(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, '').trim();

  // Try direct parse first
  try { return JSON.parse(clean); } catch {}

  // Try extracting first JSON object
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }

  // Try extracting first JSON array
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }

  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
