/**
 * /api/leads  (v2)
 * Cloudflare Pages Function — Lead Management Engine
 *
 * Improvements over v1:
 *   - JWT auth on every action
 *   - Deterministic ICP scoring (rule-based + AI explanation only)
 *   - Personalised outreach with lead-specific token replacement
 *   - CSV text parsing (no Papa dependency — pure Worker-compatible)
 *   - HubSpot + Apollo + generic CSV export formats
 *   - outreach_events tracking
 *   - Input validation on every action
 */

import { verifyAuth, corsHeaders, validate, rateLimit, sanitise, errRes, okRes } from './_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // ── Auth ────────────────────────────────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await rateLimit(`leads:${user.id}`, env, 30, 60_000)) {
    return errRes('Too many requests. Please wait.', 429, cors);
  }

  const openaiKey   = env.OPENAI_API_KEY;
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY;

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const { action } = body;
  if (!action) return errRes('Missing required field: action', 400, cors);

  switch (action) {
    case 'import':            return handleImport(body, user.id, openaiKey, supabaseUrl, supabaseKey, cors);
    case 'detect_schema':     return handleDetectSchema(body, user.id, openaiKey, cors);
    case 'score_batch':       return handleScoreBatch(body, user.id, openaiKey, supabaseUrl, supabaseKey, cors);
    case 'generate_outreach': return handleGenerateOutreach(body, user.id, openaiKey, supabaseUrl, supabaseKey, cors);
    case 'export_csv':        return handleExportCSV(body, user.id, supabaseUrl, supabaseKey, cors);
    case 'get_leads':         return handleGetLeads(body, user.id, supabaseUrl, supabaseKey, cors);
    case 'update_lead':       return handleUpdateLead(body, user.id, supabaseUrl, supabaseKey, cors);
    case 'track_outreach':    return handleTrackOutreach(body, user.id, supabaseUrl, supabaseKey, cors);
    case 'delete_leads':      return handleDeleteLeads(body, user.id, supabaseUrl, supabaseKey, cors);
    case 'delete_by_file':    return handleDeleteByFile(body, user.id, supabaseUrl, supabaseKey, cors);
    case 'ai_chat':           return handleAIChat(body, user.id, openaiKey, cors);
    default:                  return errRes(`Unknown action: ${action}`, 400, cors);
  }
}

// ══════════════════════════════════════════════════════════════════
// DETECT SCHEMA — AI infers field mapping from headers + sample rows
// Called once per upload before import. Returns mapping object.
// ══════════════════════════════════════════════════════════════════
async function handleDetectSchema(body, userId, openaiKey, cors) {
  const { headers, sample_rows } = body;
  if (!headers?.length) return errRes('headers required', 400, cors);

  // Target fields we need to map to
  const TARGET_FIELDS = {
    name:        'Full name of the contact person',
    first_name:  'First name only (used if no full name column)',
    last_name:   'Last name only (used if no full name column)',
    title:       'Job title / role / position of the person',
    company:     'Company or organization name the person works at',
    email:       'Email address of the contact',
    linkedin_url:'LinkedIn profile URL of the contact',
    website:     'Company website URL or domain',
    location:    'Location — city, country, or region',
    industry:    'Industry or department the person works in',
    phone:       'Phone number',
  };

  const prompt = `You are a data mapping expert. A user has uploaded a leads file with these column headers.
Map each target field to the most appropriate column header from their file.

TARGET FIELDS (map these):
${Object.entries(TARGET_FIELDS).map(([k,v]) => `- ${k}: ${v}`).join('\n')}

FILE HEADERS:
${headers.join(', ')}

SAMPLE DATA (first 3 rows):
${(sample_rows || []).slice(0,3).map((r,i) => `Row ${i+1}: ${JSON.stringify(r)}`).join('\n')}

Return ONLY valid JSON. For each target field, set the value to the EXACT header string from the file that best matches it, or null if no good match exists.
If two fields map to the same column (e.g. both "name" and "first_name" could match "Full Name"), prefer the more specific mapping.
Example format:
{
  "name": "Full Name",
  "first_name": null,
  "last_name": null,
  "title": "Job Title",
  "company": "Account",
  "email": "Email Address",
  "linkedin_url": null,
  "website": "Company URL",
  "location": "City",
  "industry": "Industry",
  "phone": null
}`;

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Return only valid JSON field mapping.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const d       = await aiRes.json();
    const raw     = d.choices?.[0]?.message?.content || '{}';
    const mapping = JSON.parse(raw);
    return okRes({ mapping, headers }, cors);
  } catch (e) {
    // Fallback: return empty mapping — frontend will show manual mapping UI
    return okRes({ mapping: {}, headers, error: e.message }, cors);
  }
}

// ══════════════════════════════════════════════════════════════════
// IMPORT — accepts confirmed field mapping from frontend schema step
// ══════════════════════════════════════════════════════════════════
async function handleImport(body, userId, openaiKey, url, key, cors) {
  const { csv_text, leads: rawLeads, source_type = 'csv', source_file, field_mapping } = body;

  let leads = rawLeads || [];
  if (csv_text && typeof csv_text === 'string') {
    leads = parseCSV(csv_text);
  }
  if (!leads.length) return errRes('No leads to import', 400, cors);

  // ── Resolve field mapping ─────────────────────────────────────────
  // Priority 1: confirmed mapping from frontend (if provided)
  // Priority 2: AI auto-detect from headers + sample rows (silent, no user interaction)
  // Priority 3: intelligent fuzzy fallback (never blocks import)
  let resolvedMapping = field_mapping || null;

  if (!resolvedMapping && openaiKey && leads.length > 0) {
    try {
      const headers = Object.keys(leads[0]);
      const samples = leads.slice(0, 3);
      const aiRes   = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini', temperature: 0, max_tokens: 300,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: `Map these file headers to standard contact fields. Headers: ${JSON.stringify(headers)}. Sample row: ${JSON.stringify(samples[0])}. Return JSON with keys: name, first_name, last_name, title, company, email, linkedin_url, website, location, industry, phone. Set each value to the EXACT matching header string, or null if no match.`,
          }],
        }),
      });
      const d = await aiRes.json();
      resolvedMapping = JSON.parse(d.choices?.[0]?.message?.content || '{}');
    } catch (_) {
      resolvedMapping = null; // Fall through to fuzzy
    }
  }

  const ts = new Date().toISOString();

  const payload = leads.slice(0, 5000).map(l => {
    // Get a field value using resolved mapping or fuzzy fallback
    const get = (targetField, fuzzyAliases = []) => {
      // Try AI mapping first
      if (resolvedMapping?.[targetField]) {
        const col = resolvedMapping[targetField];
        const key = Object.keys(l).find(k => k.toLowerCase() === col.toLowerCase());
        const val = key ? (l[key] || '').toString().trim() : '';
        if (val && val !== 'None' && val !== 'null') return val;
      }
      // Fuzzy fallback — try all aliases
      for (const alias of fuzzyAliases) {
        const key = Object.keys(l).find(k => k.toLowerCase() === alias.toLowerCase());
        const val = key ? (l[key] || '').toString().trim() : '';
        if (val && val !== 'None' && val !== 'null') return val;
      }
      return '';
    };

    const fullName = get('name', ['name','full name','full_name','contact name']) ||
      [get('first_name', ['first_name','first name','firstname']),
       get('last_name',  ['last_name','last name','lastname'])].filter(Boolean).join(' ');

    const company = get('company', [
      'company','company name','company_name','organization','organization name',
      'organization.name','account','account name','employer',
      'employment_history.0.organization_name',
    ]);

    const website = get('website', [
      'website','company website','organization.website_url','organization.primary_domain',
      'domain','web','url','company url','company_url',
    ]);

    return {
      user_id:      userId,
      name:         sanitise(fullName, 120),
      title:        sanitise(get('title', ['title','job title','role','position','headline']), 120),
      company:      sanitise(company, 120),
      email:        sanitise(get('email', ['email','email address','work email','email_address']), 200),
      linkedin_url: sanitise(get('linkedin_url', ['linkedin_url','linkedin','linkedin url','profile url']), 300),
      website:      sanitise(website, 300),
      location:     sanitise(get('location', ['location','city','country','formatted_address','state']), 200),
      industry:     sanitise(get('industry', ['industry','organization.industry','departments.0','department']), 120),
      source_file:  source_file || null,
      source_type,
      status:       'unprocessed',
      tags:         JSON.stringify(['Imported']),
      activity_log: JSON.stringify([{
        action: 'imported', timestamp: ts,
        note: `Imported via ${source_type}${source_file ? ' — ' + source_file : ''}`,
      }]),
    };
  }).filter(l => l.name && l.name !== '');

  if (!payload.length) return errRes('No valid leads after parsing (name field required)', 400, cors);

  // Insert in chunks. No on_conflict blocking — dedup is handled by the user
  // via the File Manager (delete file then re-import). The previous on_conflict
  // on user_id+name+company was blocking ALL leads when company was blank,
  // since blank company made every "David G" look identical.
  const CHUNK = 200;
  let inserted = 0;

  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const res = await sb(url, key, 'leads', 'POST', JSON.stringify(chunk), '');
    if (res.ok) {
      const saved = await res.json();
      inserted += Array.isArray(saved) ? saved.length : chunk.length;
    }
  }

  return okRes({ imported: inserted, total: payload.length }, cors);
}

// ══════════════════════════════════════════════════════════════════
// SCORE BATCH — deterministic scoring + AI explanation
// ══════════════════════════════════════════════════════════════════
async function handleScoreBatch(body, userId, openaiKey, url, key, cors) {
  const errors = validate({ lead_ids: 'array|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { lead_ids, icp_criteria } = body;
  if (lead_ids.length > 100) return errRes('Max 100 leads per batch', 400, cors);

  // Fetch leads
  const ids  = lead_ids.slice(0, 100).map(id => `"${sanitise(id, 36)}"`).join(',');
  const res  = await sb(url, key, 'leads', 'GET', null, `?user_id=eq.${userId}&id=in.(${ids})`);
  if (!res.ok) return errRes('Failed to fetch leads', 500, cors);
  const leads = await res.json();
  if (!leads.length) return okRes({ scored: 0 }, cors);

  // ── ICP resolution (priority order) ──────────────────────────────
  // 1. Explicit icp_criteria passed from frontend (future manual config)
  // 2. Auto-fetch user's latest icp_profiles row saved from GTM Step 3
  // 3. Empty object → neutral scoring (all sub-scores at midpoint)
  let icp = icp_criteria || {};
  if (!Object.keys(icp).length) {
    try {
      const icpRes = await fetch(
        `${url}/rest/v1/icp_profiles?user_id=eq.${userId}&order=created_at.desc&limit=1`,
        {
          headers: {
            'Content-Type':  'application/json',
            'apikey':        key,
            'Authorization': `Bearer ${key}`,
            'Prefer':        'return=representation',
          },
        }
      );
      if (icpRes.ok) {
        const profiles = await icpRes.json();
        if (Array.isArray(profiles) && profiles.length) {
          const p = profiles[0];
          // decision_makers: ["VP Sales","CMO"] → target_titles for scoring
          const dm = Array.isArray(p.decision_makers)
            ? p.decision_makers
            : (typeof p.decision_makers === 'string'
                ? JSON.parse(p.decision_makers || '[]')
                : []);
          // firmographics text: "ARR: $1M-$10M, size: 100-500, industry: SaaS, B2B"
          const firm = (p.firmographics || '').toLowerCase();
          const industries = [];
          const indMatch = firm.match(/industry[:\s]+([^,\n]+)/i);
          if (indMatch) {
            indMatch[1].split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(i => industries.push(i));
          }
          let minSize = 0, maxSize = Infinity;
          const sizeMatch = firm.match(/(\d+)\s*[-–]\s*(\d+)\s*(employees?|emp|staff|people)?/i);
          if (sizeMatch) { minSize = parseInt(sizeMatch[1]); maxSize = parseInt(sizeMatch[2]); }
          icp = {
            target_titles:     dm,
            target_industries: industries,
            min_company_size:  minSize || undefined,
            max_company_size:  maxSize === Infinity ? undefined : maxSize,
            primary_icp:       p.primary_icp || '',
          };
        }
      }
    } catch (_) {
      // ICP fetch failed — fall through to neutral scoring, never block
    }
  }

  // Score each lead deterministically against resolved ICP
  const scored = leads.map(l => ({
    ...l,
    ...deterministicScore(l, icp),
  }));

  // Optionally enrich explanation via AI (batched, non-blocking)
  if (openaiKey && scored.length <= 20) {
    await enrichScoreExplanations(scored, icp, openaiKey);
  }

  // Persist scores
  await Promise.allSettled(scored.map(l =>
    sb(url, key, 'leads', 'PATCH', JSON.stringify({
      icp_score:    l.icp_score,
      priority:     l.priority,
      score_reason: l.score_reason,
      score_details: JSON.stringify(l.score_details),
      status: l.status === 'unprocessed' ? 'analyzed' : l.status,
    }), `?id=eq.${l.id}&user_id=eq.${userId}`)
  ));

  return okRes({ scored: scored.length, leads: scored.map(l => ({
    id: l.id, name: l.name, company: l.company,
    icp_score: l.icp_score, priority: l.priority, score_reason: l.score_reason,
  }))}, cors);
}

/**
 * Deterministic ICP scoring.
 * Score breakdown: Role Seniority(25) + ICP Match(25) + Company Size(20) + Industry(20) + Intent(10)
 * AI only provides the explanation sentence — it cannot change the numeric score.
 */
function deterministicScore(lead, icp) {
  const details = {
    role_seniority:  0,   // 0–25
    icp_match:       0,   // 0–25
    company_size:    0,   // 0–20
    industry_match:  0,   // 0–20
    intent_signals:  0,   // 0–10
  };

  const title   = (lead.title   || '').toLowerCase();
  const company = (lead.company || '').toLowerCase();

  // 1. Role Seniority (25 pts)
  if (/\b(ceo|cto|coo|cmo|cpo|founder|co-founder|president|owner)\b/.test(title))       details.role_seniority = 25;
  else if (/\b(vp|vice president|svp|evp|gm|general manager|md|managing director)\b/.test(title)) details.role_seniority = 22;
  else if (/\b(director|head of|chief)\b/.test(title))                                  details.role_seniority = 18;
  else if (/\b(senior|sr\.?|lead|principal|staff)\b/.test(title))                       details.role_seniority = 12;
  else if (/\b(manager|manager)\b/.test(title))                                          details.role_seniority = 8;
  else if (title)                                                                         details.role_seniority = 4;

  // 2. ICP Title Match (25 pts)
  if (icp.target_titles?.length) {
    const match = icp.target_titles.some(t => title.includes(t.toLowerCase()));
    if (match) details.icp_match = 25;
    else {
      const partial = icp.target_titles.some(t => {
        const words = t.toLowerCase().split(/\s+/);
        return words.some(w => w.length > 3 && title.includes(w));
      });
      details.icp_match = partial ? 12 : 0;
    }
  } else {
    // No ICP defined — give neutral score
    details.icp_match = 12;
  }

  // 3. Company Size (20 pts) — infer from title context or explicit field
  if (icp.min_company_size || icp.max_company_size) {
    const size = lead.employee_count || inferCompanySize(company);
    const min  = icp.min_company_size || 0;
    const max  = icp.max_company_size || Infinity;
    if (size >= min && size <= max)       details.company_size = 20;
    else if (size >= min * 0.5)           details.company_size = 10;
  } else {
    details.company_size = 10; // neutral
  }

  // 4. Industry Match (20 pts)
  if (icp.target_industries?.length) {
    const leadIndustry = (lead.industry || '').toLowerCase();
    const exactMatch   = icp.target_industries.some(i => leadIndustry.includes(i.toLowerCase()));
    details.industry_match = exactMatch ? 20 : 0;
  } else {
    details.industry_match = 10; // neutral
  }

  // 5. Intent Signals (10 pts)
  if (lead.intent_signals || lead.tags) {
    const tags = (typeof lead.tags === 'string' ? JSON.parse(lead.tags) : lead.tags) || [];
    const signals = tags.filter(t =>
      ['hiring', 'funding', 'expansion', 'new-product', 'press', 'award'].includes(t.toLowerCase())
    );
    details.intent_signals = Math.min(signals.length * 3, 10);
  }

  const total    = Object.values(details).reduce((s, v) => s + v, 0);
  const priority = total >= 75 ? 'HIGH' : total >= 50 ? 'MEDIUM' : 'LOW';

  return {
    icp_score:    total,
    priority,
    score_reason: `Score ${total}/100 — Seniority:${details.role_seniority} ICP:${details.icp_match} Size:${details.company_size} Industry:${details.industry_match} Intent:${details.intent_signals}`,
    score_details: details,
  };
}

function inferCompanySize(company) {
  // Very rough heuristic based on known company patterns
  const enterprise = ['microsoft','google','apple','amazon','meta','salesforce','oracle','sap','ibm','accenture'];
  const mid        = ['hubspot','zendesk','freshworks','intercom','segment','twilio'];
  const lc         = company.toLowerCase();
  if (enterprise.some(e => lc.includes(e))) return 10000;
  if (mid.some(m => lc.includes(m)))        return 1000;
  return 100; // default to SMB
}

async function enrichScoreExplanations(leads, icp, openaiKey) {
  const prompt = `You are a B2B sales expert. For each scored lead below, write a ONE sentence explanation of why the score is correct based on their role and company. Be specific and concise.

ICP Context: ${JSON.stringify(icp)}

Leads (already scored):
${leads.map((l, i) => `${i}: ${l.name} | ${l.title} | ${l.company} | Score: ${l.icp_score}`).join('\n')}

Return ONLY a JSON array with exactly ${leads.length} objects:
[{"index":0,"reason":"One sentence explanation"}, ...]`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 500,
        messages: [{ role: 'system', content: 'Return ONLY valid JSON array.' }, { role: 'user', content: prompt }] }),
    });
    const d      = await res.json();
    const raw    = d.choices?.[0]?.message?.content || '[]';
    const clean  = raw.replace(/```json|```/g, '').trim();
    const m      = clean.match(/\[[\s\S]*\]/);
    const reasons = JSON.parse(m ? m[0] : clean);
    for (const r of reasons) {
      if (leads[r.index] && r.reason) leads[r.index].score_reason = r.reason;
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════
// GENERATE OUTREACH — personalised per lead with token replacement
// ══════════════════════════════════════════════════════════════════
async function handleGenerateOutreach(body, userId, openaiKey, url, key, cors) {
  if (!openaiKey) return errRes('OpenAI not configured', 503, cors);

  const errors = validate({ lead_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { lead_id, gtm_context, sequence_template } = body;

  // Fetch lead
  const res = await sb(url, key, 'leads', 'GET', null,
    `?id=eq.${sanitise(lead_id, 36)}&user_id=eq.${userId}&limit=1`);
  if (!res.ok) return errRes('Failed to fetch lead', 500, cors);
  const leads = await res.json();
  if (!leads.length) return errRes('Lead not found', 404, cors);
  const lead = leads[0];

  // If we have a template from GTM Step 6, personalise it first
  let emailTemplate = null;
  if (sequence_template?.email_1) {
    emailTemplate = personaliseTemplate(sequence_template.email_1, lead);
  }

  const prompt = `You are a B2B outreach expert. Write hyper-personalised cold outreach for this prospect.

PROSPECT:
Name: ${lead.name}
First Name: ${(lead.name || '').split(' ')[0]}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}
Location: ${lead.location || 'Unknown'}
ICP Score: ${lead.icp_score || 'N/A'}/100
Score Reason: ${lead.score_reason || 'N/A'}

${gtm_context ? `COMPANY GTM CONTEXT (use this for personalisation):\n${gtm_context}\n` : ''}
${emailTemplate ? `BASE TEMPLATE TO PERSONALISE:\nSubject: ${emailTemplate.subject}\nBody: ${emailTemplate.body}\n` : ''}

Write a complete outreach sequence. Return ONLY this exact JSON:
{
  "email": {
    "subject": "Subject line under 50 chars — mention their company or role",
    "body": "3 short paragraphs. Hyper-relevant to ${lead.company || 'their company'}. Conversational, no buzzwords. First line must reference something specific about them.",
    "cta": "Specific, low-friction CTA — e.g. '15-min call Thursday?' not 'Would you be open to a meeting?'"
  },
  "linkedin": {
    "connection_note": "Under 300 chars. Reference their work. No pitch.",
    "follow_up_day3": "Under 200 chars. Value-first, no ask.",
    "follow_up_day7": "Under 200 chars. Soft ask."
  },
  "follow_up_email": {
    "subject": "Brief reply-thread subject",
    "body": "2 short paragraphs. Different angle from email 1."
  },
  "personalisation_notes": "What specific details made this personal"
}`;

  let outreach;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a B2B outreach expert. Return ONLY valid JSON, no extra text.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const d   = await aiRes.json();
    const raw = d.choices?.[0]?.message?.content || '{}';
    try {
      outreach = JSON.parse(raw);
    } catch {
      const clean = raw.replace(/```json|```/g, '').trim();
      const m     = clean.match(/\{[\s\S]*\}/);
      outreach    = JSON.parse(m ? m[0] : clean);
    }
  } catch (e) {
    return errRes('Outreach generation failed: ' + e.message, 500, cors);
  }

  // Save to lead record
  await sb(url, key, 'leads', 'PATCH', JSON.stringify({
    outreach_email:    outreach.email?.body,
    outreach_linkedin: outreach.linkedin?.connection_note,
    gtm_analysis:      outreach,
    status:            'analyzed',
  }), `?id=eq.${lead_id}&user_id=eq.${userId}`);

  return okRes({ outreach, lead_id, lead_name: lead.name }, cors);
}

/**
 * Replace template tokens with real lead data.
 * Supports {{name}}, {{first_name}}, {{company}}, {{title}}, {{location}}.
 */
function personaliseTemplate(template, lead) {
  const firstName = (lead.name || '').split(' ')[0];
  const replace   = (str) => (str || '')
    .replace(/\{\{name\}\}/gi,       lead.name || '')
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{company\}\}/gi,    lead.company || '')
    .replace(/\{\{title\}\}/gi,      lead.title || '')
    .replace(/\{\{location\}\}/gi,   lead.location || '');

  return {
    subject: replace(template.subject),
    body:    replace(template.body),
    cta:     replace(template.cta),
    angle:   template.angle,
  };
}

// ══════════════════════════════════════════════════════════════════
// EXPORT CSV — HubSpot / Apollo / generic
// ══════════════════════════════════════════════════════════════════
async function handleExportCSV(body, userId, url, key, cors) {
  const { lead_ids, format = 'generic', filters } = body;

  let query = `?user_id=eq.${userId}&order=icp_score.desc.nullslast&limit=5000`;
  if (lead_ids?.length) query += `&id=in.(${lead_ids.map(id => `"${sanitise(id,36)}"`).join(',')})`;
  if (filters?.priority) query += `&priority=eq.${sanitise(filters.priority, 10)}`;
  if (filters?.status)   query += `&status=eq.${sanitise(filters.status, 20)}`;

  const res = await sb(url, key, 'leads', 'GET', null, query);
  if (!res.ok) return errRes('Failed to fetch leads', 500, cors);
  const leads = await res.json();
  if (!leads.length) return errRes('No leads to export', 400, cors);

  const csv      = buildCSV(leads, format);
  const filename = `leads_${format}_${new Date().toISOString().slice(0,10)}.csv`;

  return okRes({ csv, filename, count: leads.length, format }, cors);
}

function buildCSV(leads, format) {
  const COLS = {
    generic: [
      'First Name','Last Name','Company','Title','Email','LinkedIn URL','Website',
      'Location','ICP Score','Priority','Score Reason','Status','Outreach Status','Notes'
    ],
    hubspot: [
      'First Name','Last Name','Company Name','Job Title','Email Address',
      'LinkedIn Bio','Website URL','City','Lead Score','Lifecycle Stage'
    ],
    apollo: [
      'First Name','Last Name','Company','Title','Email','LinkedIn URL',
      'Website','Location','Score','Stage'
    ],
  };

  const cols = COLS[format] || COLS.generic;

  const MAP = {
    'First Name':       l => (l.name || '').split(' ')[0],
    'Last Name':        l => (l.name || '').split(' ').slice(1).join(' '),
    'Company':          l => l.company || '',
    'Company Name':     l => l.company || '',
    'Title':            l => l.title || '',
    'Job Title':        l => l.title || '',
    'Email':            l => l.email || '',
    'Email Address':    l => l.email || '',
    'LinkedIn URL':     l => l.linkedin_url || '',
    'LinkedIn Bio':     l => l.linkedin_url || '',
    'Website':          l => l.website || '',
    'Website URL':      l => l.website || '',
    'Location':         l => l.location || '',
    'City':             l => l.location || '',
    'ICP Score':        l => l.icp_score ?? '',
    'Lead Score':       l => l.icp_score ?? '',
    'Score':            l => l.icp_score ?? '',
    'Priority':         l => l.priority || '',
    'Score Reason':     l => l.score_reason || '',
    'Status':           l => l.status || '',
    'Outreach Status':  l => l.outreach_status || '',
    'Lifecycle Stage':  l => hubspotStage(l.status),
    'Stage':            l => l.status || '',
    'Notes':            l => l.notes || '',
  };

  const rows = leads.map(l => cols.map(col => csvCell((MAP[col]?.(l) ?? ''))));
  return [cols.map(csvCell), ...rows].map(r => r.join(',')).join('\r\n');
}

function hubspotStage(status) {
  const map = { unprocessed: 'Lead', analyzed: 'Marketing Qualified Lead',
    mapped: 'Sales Qualified Lead', archived: 'Unqualified' };
  return map[status] || 'Lead';
}
function csvCell(val) {
  const s = String(val ?? '').replace(/"/g, '""');
  return /[,"\r\n]/.test(s) ? `"${s}"` : s;
}

// ══════════════════════════════════════════════════════════════════
// GET LEADS — paginated + filtered
// FIX Bug 4: Added outreach_status filter (was captured in UI but never applied)
// FIX Bug 5: Returns real DB total count via separate count query, not just page length
// ══════════════════════════════════════════════════════════════════
async function handleGetLeads(body, userId, url, key, cors) {
  const { status, priority, outreach_status, search, source_file, limit = 100, offset = 0 } = body;

  // Base filter (same for both data + count queries)
  let baseFilter = `?user_id=eq.${userId}`;
  if (status)          baseFilter += `&status=eq.${sanitise(status, 20)}`;
  if (priority)        baseFilter += `&priority=eq.${sanitise(priority, 10)}`;
  if (outreach_status) baseFilter += `&outreach_status=eq.${sanitise(outreach_status, 20)}`; // ← FIX Bug 4
  if (source_file)     baseFilter += `&source_file=eq.${encodeURIComponent(sanitise(source_file, 200))}`;
  if (search)          baseFilter += `&or=(name.ilike.*${encodeURIComponent(sanitise(search, 100))}*,company.ilike.*${encodeURIComponent(sanitise(search, 100))}*,email.ilike.*${encodeURIComponent(sanitise(search, 100))}*)`;

  // Data query — paginated. Order by icp_score if available, else created_at
  const dataQuery = baseFilter + `&order=created_at.desc&limit=${limit}&offset=${offset}`;
  const res = await sb(url, key, 'leads', 'GET', null, dataQuery);
  if (!res.ok) return errRes('Failed to fetch leads', 500, cors);
  const leads = await res.json();

  // ── FIX Bug 5: Accurate total count via Supabase count header ──────
  // We fetch count=exact in a HEAD-style GET — no data returned, just count in header
  let total = leads.length + offset; // safe fallback if count query fails
  try {
    const countRes = await fetch(`${url}/rest/v1/leads${baseFilter}&select=id`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'count=exact',
        'Range-Unit': 'items',
        Range: '0-0',   // Only fetch 1 row — we only need the count header
      },
    });
    const contentRange = countRes.headers.get('Content-Range'); // e.g. "0-0/1247"
    if (contentRange) {
      const parts = contentRange.split('/');
      if (parts[1] && parts[1] !== '*') total = parseInt(parts[1], 10) || total;
    }
  } catch (_) { /* fallback total already set above */ }

  // ── Server-side aggregate counts for stats (across full dataset) ───
  // These power the 5 stat cards at the top — always accurate regardless of pagination
  let counts = {};
  try {
    const allRes = await sb(url, key, 'leads', 'GET', null,
      `?user_id=eq.${userId}&select=priority,status,outreach_status&limit=5000`);
    if (allRes.ok) {
      const all = await allRes.json();
      counts = {
        high:     all.filter(l => l.priority === 'HIGH').length,
        analyzed: all.filter(l => l.status === 'analyzed' || l.status === 'mapped').length,
        outreach: all.filter(l => l.outreach_status === 'sent' || l.outreach_status === 'replied').length,
        replied:  all.filter(l => l.outreach_status === 'replied').length,
      };
    }
  } catch (_) {}

  return okRes({ leads, total, offset, limit, counts }, cors);
}

// ══════════════════════════════════════════════════════════════════
// UPDATE LEAD
// ══════════════════════════════════════════════════════════════════
async function handleUpdateLead(body, userId, url, key, cors) {
  const errors = validate({ lead_id: 'string|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const ALLOWED = ['status','notes','outreach_status','tags','icp_score','priority','score_reason','last_contacted_at'];
  const safe = {};
  for (const k of ALLOWED) {
    if (k in body.updates) safe[k] = body.updates[k];
  }
  if (!Object.keys(safe).length) return errRes('No valid update fields provided', 400, cors);

  const res = await sb(url, key, 'leads', 'PATCH', JSON.stringify(safe),
    `?id=eq.${sanitise(body.lead_id, 36)}&user_id=eq.${userId}`);
  if (!res.ok) return errRes('Failed to update lead', 500, cors);
  return okRes({ updated: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// TRACK OUTREACH EVENT
// ══════════════════════════════════════════════════════════════════
async function handleTrackOutreach(body, userId, url, key, cors) {
  const errors = validate({
    lead_id:    'string|required',
    channel:    'string|required',
    event_type: 'string|required',
  }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { lead_id, channel, event_type, subject, body: bodyText, sequence_step = 1 } = body;

  const validChannels = ['email','linkedin','call','other'];
  const validEvents   = ['sent','opened','replied','bounced','meeting_booked'];
  if (!validChannels.includes(channel))   return errRes(`Invalid channel: ${channel}`, 400, cors);
  if (!validEvents.includes(event_type))  return errRes(`Invalid event_type: ${event_type}`, 400, cors);

  const res = await sb(url, key, 'outreach_events', 'POST', JSON.stringify({
    lead_id:       sanitise(lead_id, 36),
    user_id:       userId,
    channel,
    event_type,
    subject:       sanitise(subject || '', 300),
    body_snippet:  sanitise(bodyText || '', 500),
    sequence_step,
  }));

  // Also update lead outreach_status
  const statusMap = { sent: 'sent', replied: 'replied', bounced: 'bounced',
    meeting_booked: 'replied', opened: 'sent' };
  if (statusMap[event_type]) {
    await sb(url, key, 'leads', 'PATCH',
      JSON.stringify({ outreach_status: statusMap[event_type], last_contacted_at: new Date().toISOString() }),
      `?id=eq.${sanitise(lead_id, 36)}&user_id=eq.${userId}`);
  }

  return okRes({ tracked: true }, cors);
}

// ══════════════════════════════════════════════════════════════════
// DELETE LEADS (bulk)
// ══════════════════════════════════════════════════════════════════
async function handleDeleteLeads(body, userId, url, key, cors) {
  const errors = validate({ lead_ids: 'array|required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const ids = body.lead_ids.slice(0, 500).map(id => `"${sanitise(id, 36)}"`).join(',');
  const res = await sb(url, key, 'leads', 'DELETE', null,
    `?id=in.(${ids})&user_id=eq.${userId}`);
  if (!res.ok) return errRes('Failed to delete leads', 500, cors);
  return okRes({ deleted: body.lead_ids.length }, cors);
}

// Delete all leads belonging to a specific source_file upload
async function handleDeleteByFile(body, userId, url, key, cors) {
  const { source_file } = body;
  if (!source_file) return errRes('source_file required', 400, cors);
  const res = await sb(url, key, 'leads', 'DELETE', null,
    `?user_id=eq.${userId}&source_file=eq.${encodeURIComponent(sanitise(source_file, 200))}`);
  if (!res.ok) return errRes('Failed to delete file leads', 500, cors);
  return okRes({ deleted: true, source_file }, cors);
}

// ══════════════════════════════════════════════════════════════════
// AI CHAT — per-lead intelligence chat (powers the drawer AI tab)
// ══════════════════════════════════════════════════════════════════
async function handleAIChat(body, userId, openaiKey, cors) {
  if (!openaiKey) return errRes('AI not configured', 503, cors);
  const { message, history = [], lead_context = {} } = body;
  if (!message) return errRes('message required', 400, cors);

  const { name, title, company, icp_score, priority, score_reason, industry } = lead_context;

  const system = `You are an expert B2B sales intelligence assistant embedded in an enterprise GTM platform.
You have full context on this specific lead:

Name: ${name || '—'}
Title: ${title || '—'}
Company: ${company || '—'}
Industry: ${industry || '—'}
ICP Score: ${icp_score != null ? icp_score + '/100' : 'not scored'}
Priority: ${priority || '—'}
Score Breakdown: ${score_reason || 'not available'}

Your role: help the user understand this lead, suggest outreach angles, identify pain points, recommend next actions, and answer any sales intelligence questions.
Be concise (max 3 short paragraphs), specific to this person, and always actionable.
Never invent facts not provided. If you don't know something, say so.`;

  const messages = [
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: sanitise(message, 1000) },
  ];

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 500,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    const d     = await aiRes.json();
    const reply = d.choices?.[0]?.message?.content || 'No response from AI.';
    return okRes({ reply }, cors);
  } catch(e) {
    return errRes('AI chat failed: ' + e.message, 500, cors);
  }
}

// ── Pure CSV parser (no external deps — Worker compatible) ─────────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows    = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCSVLine(line);
    const row    = {};
    headers.forEach((h, j) => { row[h] = (values[j] || '').trim(); });
    rows.push(row);
  }

  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

function findField(obj, keys) {
  for (const k of keys) {
    for (const [key, val] of Object.entries(obj)) {
      if (key.toLowerCase().trim() === k.toLowerCase()) return String(val || '');
    }
  }
  return '';
}

// ── Supabase helper ───────────────────────────────────────────────
const sb = (url, key, table, method, body, qs = '') =>
  fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      apikey:          key,
      Authorization:   `Bearer ${key}`,
      Prefer:          method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body || undefined,
  });

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
