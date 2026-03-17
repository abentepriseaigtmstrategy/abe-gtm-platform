/**
 * /api/export-pdf  (v2)
 * Cloudflare Pages Function
 *
 * Generates a REAL binary PDF using pdf-lib (pure JS, no headless Chrome).
 * pdf-lib runs inside Cloudflare Workers with zero dependencies.
 *
 * DEPLOYMENT NOTE:
 *   npm install pdf-lib  in your functions directory
 *   OR use the CDN ESM build:
 *   import { PDFDocument, StandardFonts, rgb, degrees } from 'https://cdn.skypack.dev/pdf-lib@1.17.1';
 *
 * INPUT:  { strategy: { company_name, industry, step_1_market, ... } }
 * OUTPUT: Binary PDF (application/pdf) OR base64 JSON depending on Accept header
 *
 * For Cloudflare Pages Functions that cannot import npm packages yet,
 * this file also exports buildReportHTML() for the html2pdf.js fallback
 * (used by vault.html frontend).
 */

import { verifyAuth, corsHeaders, validate, errRes } from './_middleware.js';

// ── Try to import pdf-lib; fall back to HTML mode if unavailable ───
let PDFDocument, StandardFonts, rgb;
try {
  const pdfLib   = await import('pdf-lib');
  PDFDocument    = pdfLib.PDFDocument;
  StandardFonts  = pdfLib.StandardFonts;
  rgb            = pdfLib.rgb;
} catch {
  // pdf-lib not available in this Worker — HTML fallback will be used
}

const PDF_LIB_AVAILABLE = !!PDFDocument;

// ── Brand colours ──────────────────────────────────────────────────
const C = {
  bg:      rgb ? rgb(0.043, 0.059, 0.102) : null,   // #0B0F1A
  accent:  rgb ? rgb(0.659, 0.333, 0.969) : null,   // #a855f7
  white:   rgb ? rgb(1, 1, 1) : null,
  text:    rgb ? rgb(0.898, 0.906, 0.922) : null,   // #E5E7EB
  muted:   rgb ? rgb(0.420, 0.447, 0.502) : null,   // #6B7280
  green:   rgb ? rgb(0.133, 0.773, 0.369) : null,   // #22c55e
  amber:   rgb ? rgb(0.961, 0.620, 0.043) : null,   // #f59e0b
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // ── Auth ────────────────────────────────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ strategy: 'required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { strategy, format = 'auto' } = body;
  if (!strategy.company_name) return errRes('Missing strategy.company_name', 400, cors);

  const filename = `GTM_${strategy.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0,10)}`;

  // ── Route to pdf-lib or HTML fallback ──────────────────────────
  if (PDF_LIB_AVAILABLE && format !== 'html') {
    try {
      const pdfBytes = await generatePDF(strategy);
      const b64      = arrayBufferToBase64(pdfBytes);
      return new Response(JSON.stringify({ pdf_base64: b64, filename: filename + '.pdf' }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('pdf-lib error:', e);
      // Fall through to HTML fallback
    }
  }

  // ── HTML fallback (used by frontend html2pdf.js) ───────────────
  const html = buildReportHTML(strategy);
  return new Response(JSON.stringify({ html, filename: filename + '.pdf', mode: 'html2pdf' }), {
    status: 200,
    headers: cors,
  });
}

// ══════════════════════════════════════════════════════════════════
// PDF-LIB GENERATION — true binary PDF
// ══════════════════════════════════════════════════════════════════
async function generatePDF(strategy) {
  const pdfDoc   = await PDFDocument.create();
  const helvetica      = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const s1 = strategy.step_1_market    || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam       || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp       || strategy.steps?.[3] || {};
  const s5 = strategy.step_5_keywords  || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};

  pdfDoc.setTitle(`GTM Strategy — ${strategy.company_name}`);
  pdfDoc.setAuthor('AB Enterprise AI Revenue Infrastructure');
  pdfDoc.setCreator('AB GTM Platform');

  // ── COVER PAGE ────────────────────────────────────────────────
  const cover = pdfDoc.addPage([595, 842]); // A4

  // Dark background
  cover.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: C.bg });

  // Purple accent bar top
  cover.drawRectangle({ x: 0, y: 820, width: 595, height: 22, color: C.accent });

  // Logo text
  cover.drawText('AB', { x: 48, y: 780, size: 14, font: helveticaBold, color: C.accent });
  cover.drawText('ENTERPRISE AI REVENUE INFRASTRUCTURE', { x: 48, y: 764, size: 7, font: helvetica, color: C.muted });

  // Title
  cover.drawText('GTM Strategy', { x: 48, y: 680, size: 36, font: helveticaBold, color: C.white });
  cover.drawText('Intelligence Report', { x: 48, y: 638, size: 36, font: helveticaBold, color: C.white });

  // Company name
  cover.drawText(strategy.company_name, { x: 48, y: 590, size: 18, font: helveticaBold, color: C.accent });
  if (strategy.industry) {
    cover.drawText(strategy.industry, { x: 48, y: 570, size: 11, font: helvetica, color: C.muted });
  }

  // Score boxes
  const scoreBoxes = [
    { label: 'GTM SCORE', value: s1.gtm_relevance_score ? String(s1.gtm_relevance_score) : '—', color: C.green },
    { label: 'TAM SIZE',  value: s2.tam_size_estimate || '—', color: C.accent },
    { label: 'CAGR',      value: s2.growth_rate || '—', color: C.amber },
    { label: 'STEPS',     value: `${strategy.steps_completed || 6}/6`, color: C.white },
  ];

  scoreBoxes.forEach((box, i) => {
    const x = 48 + i * 130;
    cover.drawRectangle({ x, y: 480, width: 118, height: 66, color: rgb(1,1,1), opacity: 0.05, borderColor: rgb(1,1,1), borderOpacity: 0.1, borderWidth: 1 });
    cover.drawText(box.value.slice(0, 12), { x: x + 10, y: 520, size: 16, font: helveticaBold, color: box.color });
    cover.drawText(box.label, { x: x + 10, y: 494, size: 7, font: helvetica, color: C.muted });
  });

  // Date footer
  const dateStr = new Date().toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' });
  cover.drawText(`Generated ${dateStr} · Confidential`, { x: 48, y: 48, size: 8, font: helvetica, color: C.muted });

  // ── CONTENT PAGES ────────────────────────────────────────────
  const sections = [
    { title: '01 — Market Research',   data: s1, renderer: renderStep1 },
    { title: '02 — TAM Mapping',       data: s2, renderer: renderStep2 },
    { title: '03 — ICP Profile',       data: s3, renderer: renderStep3 },
    { title: '05 — Keywords',          data: s5, renderer: renderStep5 },
    { title: '06 — Outreach Messaging',data: s6, renderer: renderStep6 },
  ];

  for (const section of sections) {
    if (!section.data || !Object.keys(section.data).length) continue;

    const page = pdfDoc.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(1,1,1) });

    // Section header bar
    page.drawRectangle({ x: 0, y: 800, width: 595, height: 42, color: C.bg });
    page.drawText('AB GTM STRATEGY', { x: 48, y: 820, size: 7, font: helvetica, color: C.muted });
    page.drawText(strategy.company_name.toUpperCase(), { x: 400, y: 820, size: 7, font: helvetica, color: C.muted });

    // Section title
    page.drawRectangle({ x: 0, y: 756, width: 595, height: 44, color: C.bg });
    page.drawText(section.title, { x: 48, y: 774, size: 14, font: helveticaBold, color: C.white });

    // Content
    await section.renderer(page, section.data, helvetica, helveticaBold, 730);
  }

  return await pdfDoc.save();
}

// Section renderers — each receives (page, data, font, boldFont, startY)
async function renderStep1(page, d, font, bold, y) {
  y = drawField(page, 'Company Overview',    d.company_overview,       font, bold, y, 48);
  y = drawField(page, 'Market Position',     d.market_position,        font, bold, y, 48);
  y = drawField(page, 'GTM Reasoning',       d.gtm_relevance_reasoning,font, bold, y, 48);
  y = drawTagRow(page, 'Growth Signals',     d.growth_signals || [],   font, bold, y, 48, C.green);
  y = drawTagRow(page, 'Tech Stack',         d.tech_stack_hints || [], font, bold, y, 48, C.accent);
  return y;
}

async function renderStep2(page, d, font, bold, y) {
  // TAM stat boxes
  if (d.tam_size_estimate || d.growth_rate) {
    page.drawRectangle({ x: 48, y: y - 54, width: 200, height: 50, color: rgb(0.96,0.99,0.96), borderColor: C.green, borderWidth: 1 });
    page.drawText(d.tam_size_estimate || '—', { x: 58, y: y - 30, size: 16, font: bold, color: C.green });
    page.drawText('TOTAL ADDRESSABLE MARKET', { x: 58, y: y - 50, size: 6, font, color: C.muted });

    page.drawRectangle({ x: 268, y: y - 54, width: 200, height: 50, color: rgb(1,0.99,0.95), borderColor: C.amber, borderWidth: 1 });
    page.drawText(d.growth_rate || '—', { x: 278, y: y - 30, size: 16, font: bold, color: C.amber });
    page.drawText('CAGR', { x: 278, y: y - 50, size: 6, font, color: C.muted });
    y -= 66;
  }
  y = drawField(page, 'TAM Overview',          d.tam_overview,         font, bold, y, 48);
  y = drawField(page, 'Priority Opportunities', d.priority_opportunities, font, bold, y, 48);
  return y;
}

async function renderStep3(page, d, font, bold, y) {
  y = drawField(page, 'Primary ICP',     d.primary_icp,     font, bold, y, 48);
  y = drawField(page, 'Firmographics',   d.firmographics,   font, bold, y, 48);
  y = drawField(page, 'Core Pain Points',d.core_pain_points,font, bold, y, 48);
  y = drawTagRow(page, 'Buying Triggers',d.buying_triggers || [], font, bold, y, 48, C.accent);
  y = drawTagRow(page, 'Decision Makers',d.decision_makers || [], font, bold, y, 48, C.muted);
  return y;
}

async function renderStep5(page, d, font, bold, y) {
  y = drawTagRow(page, 'Primary Keywords',  d.primary_keywords   || [], font, bold, y, 48, C.green);
  y = drawTagRow(page, 'Secondary Keywords',d.secondary_keywords || [], font, bold, y, 48, C.muted);
  y = drawField(page, 'Boolean Query', d.boolean_query, font, bold, y, 48, true);
  y = drawField(page, 'LinkedIn String',d.linkedin_search_strings, font, bold, y, 48);
  return y;
}

async function renderStep6(page, d, font, bold, y) {
  for (const [key, label] of [['email_1','Email A'],['email_2','Email B'],['email_3','Email C']]) {
    const e = d[key];
    if (!e || y < 120) continue;
    page.drawRectangle({ x: 48, y: y - 88, width: 499, height: 84, color: rgb(0.98,0.97,1), borderColor: C.accent, borderWidth: 0.5 });
    page.drawText(label + (e.angle ? ` — ${e.angle}` : ''), { x: 56, y: y - 14, size: 8, font: bold, color: C.accent });
    const subj = (e.subject || '').slice(0, 70);
    page.drawText(`Subject: ${subj}`, { x: 56, y: y - 30, size: 9, font: bold, color: rgb(0.1,0.1,0.1) });
    const bodyLine = (e.body || '').replace(/<br>/g, ' ').slice(0, 130);
    drawWrappedText(page, bodyLine + '…', { x: 56, y: y - 46, width: 480, fontSize: 8, font, color: rgb(0.3,0.3,0.3), maxLines: 3 });
    y -= 98;
  }
  return y;
}

// ── Drawing helpers ──────────────────────────────────────────────
function drawField(page, label, value, font, bold, y, x = 48, mono = false) {
  if (!value || y < 80) return y;
  const str = String(value).replace(/\n/g, ' ').replace(/<br>/g, ' ');

  page.drawText(label.toUpperCase(), { x, y, size: 7, font: bold, color: C.muted });
  y -= 14;

  page.drawRectangle({ x, y: y - 26, width: 499, height: Math.min(str.length / 2, 36) + 12, color: rgb(0.98,0.98,0.99), borderColor: rgb(0.9,0.9,0.9), borderWidth: 0.5 });
  drawWrappedText(page, str, { x: x + 6, y: y - 8, width: 486, fontSize: mono ? 8 : 9, font: mono ? font : font, color: rgb(0.2,0.2,0.2), maxLines: 4 });

  y -= Math.min(str.length / 2, 36) + 20;
  return y;
}

function drawTagRow(page, label, tags, font, bold, y, x, tagColor) {
  if (!tags?.length || y < 60) return y;
  page.drawText(label.toUpperCase(), { x, y, size: 7, font: bold, color: C.muted });
  y -= 14;

  let tx = x;
  for (const tag of tags.slice(0, 12)) {
    const str   = String(tag).slice(0, 24);
    const width = str.length * 5.5 + 12;
    if (tx + width > 540) { tx = x; y -= 20; }
    if (y < 60) break;
    page.drawRectangle({ x: tx, y: y - 14, width, height: 16, color: tagColor ? { ...tagColor, opacity: 0.08 } : rgb(0.96,0.94,1), borderColor: tagColor || C.accent, borderWidth: 0.5 });
    page.drawText(str, { x: tx + 6, y: y - 9, size: 7, font, color: tagColor || C.accent });
    tx += width + 6;
  }
  y -= 26;
  return y;
}

function drawWrappedText(page, text, { x, y, width, fontSize, font, color, maxLines = 5 }) {
  if (!text) return;
  const words   = text.split(' ');
  const lines   = [];
  let current   = '';
  const charPx  = fontSize * 0.52;

  for (const word of words) {
    if ((current + ' ' + word).length * charPx > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current.trim());

  lines.slice(0, maxLines).forEach((line, i) => {
    page.drawText(line, { x, y: y - i * (fontSize + 2), size: fontSize, font, color });
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary  = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ══════════════════════════════════════════════════════════════════
// HTML FALLBACK — for when pdf-lib is unavailable
// (also used by vault.html frontend with html2pdf.js)
// ══════════════════════════════════════════════════════════════════
export function buildReportHTML(strategy) {
  const s1 = strategy.step_1_market    || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam       || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp       || strategy.steps?.[3] || {};
  const s4 = strategy.step_4_sourcing  || strategy.steps?.[4] || {};
  const s5 = strategy.step_5_keywords  || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};
  const date = new Date().toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' });
  const score = s1.gtm_relevance_score;
  const sc    = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';

  const field = (label, val) => val ? `<div class="field"><div class="fl">${e(label)}</div><div class="fv">${e(String(val))}</div></div>` : '';
  const tags  = (label, arr, cls='') => arr?.length ? `<div class="field"><div class="fl">${e(label)}</div><div class="tags">${arr.map(t=>`<span class="tag ${cls}">${e(String(t))}</span>`).join('')}</div></div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#111827;background:#fff}
.cover{background:linear-gradient(135deg,#0B0F1A,#1a0533);color:white;padding:60px 48px;page-break-after:always;min-height:297mm;display:flex;flex-direction:column;justify-content:space-between}
.clogo{font-size:9px;font-weight:900;letter-spacing:.3em;text-transform:uppercase;color:#a855f7;margin-bottom:60px}
.ctitle{font-size:36px;font-weight:900;line-height:1.1;letter-spacing:-1px;margin-bottom:16px}
.cco{font-size:18px;color:#a855f7;font-weight:700;margin-bottom:40px}
.cstats{display:flex;gap:24px;margin-bottom:40px}
.cstat{text-align:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:16px 22px}
.csn{font-size:22px;font-weight:900;color:white}
.csl{font-size:8px;text-transform:uppercase;letter-spacing:.15em;color:#6b7280;margin-top:4px}
.cfoot{font-size:9px;color:#374151}
.sec{padding:28px 40px;page-break-inside:avoid}
.sec+.sec{border-top:1px solid #f3f4f6}
.sh{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.snum{width:26px;height:26px;border-radius:50%;background:#a855f7;color:white;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.st{font-size:14px;font-weight:800;color:#111827}
.field{margin-bottom:10px}
.fl{font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.18em;color:#9ca3af;margin-bottom:4px}
.fv{font-size:11px;color:#374151;line-height:1.6;background:#f9fafb;border-radius:6px;padding:10px 12px;border-left:3px solid #a855f7}
.fv.g{border-color:#22c55e}.fv.a{border-color:#f59e0b}.fv.mono{font-family:monospace;font-size:10px}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.tag{font-size:9px;font-weight:600;padding:3px 8px;border-radius:5px;background:#f3e8ff;color:#7c3aed;border:1px solid #e9d5ff}
.tag.g{background:#dcfce7;color:#166534;border-color:#bbf7d0}
.tag.b{background:#dbeafe;color:#1d4ed8;border-color:#bfdbfe}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px}
.mc{background:#f9fafb;border:1px solid #f3f4f6;border-radius:8px;padding:12px}
.mn{font-size:20px;font-weight:900;font-family:monospace}
.ml{font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:#9ca3af;margin-top:2px}
.eb{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin-bottom:8px;page-break-inside:avoid}
.ea{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.15em;color:#a855f7;margin-bottom:4px}
.es{font-size:11px;font-weight:800;color:#111827;margin-bottom:6px}
.ebo{font-size:11px;color:#374151;line-height:1.6;white-space:pre-wrap}
.ec{font-size:10px;font-weight:700;color:#7c3aed;margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb}
.pb{page-break-before:always}
.fbar{background:#0B0F1A;color:#6b7280;font-size:8px;text-align:center;padding:10px;margin-top:auto}
</style></head><body>

<div class="cover">
<div>
<div class="clogo">AB · Enterprise AI Revenue Infrastructure</div>
<div class="ctitle">GTM Strategy<br>Intelligence Report</div>
<div class="cco">${e(strategy.company_name)}${strategy.industry?' · '+e(strategy.industry):''}</div>
<div class="cstats">
${score?`<div class="cstat"><div class="csn" style="color:${sc}">${score}</div><div class="csl">GTM Score</div></div>`:''}
${s2.tam_size_estimate?`<div class="cstat"><div class="csn">${e(s2.tam_size_estimate)}</div><div class="csl">TAM</div></div>`:''}
${s2.growth_rate?`<div class="cstat"><div class="csn">${e(s2.growth_rate)}</div><div class="csl">CAGR</div></div>`:''}
<div class="cstat"><div class="csn">${strategy.steps_completed||6}/6</div><div class="csl">Steps</div></div>
</div></div>
<div class="cfoot">Generated ${date} · Confidential · AB Enterprise AI Revenue Infrastructure</div>
</div>

${s1.company_overview?`<div class="sec">
<div class="sh"><div class="snum">1</div><div class="st">Market Research</div></div>
${field('Company Overview',s1.company_overview)}
${field('Market Position',s1.market_position)}
${field('GTM Reasoning',s1.gtm_relevance_reasoning)}
${tags('Growth Signals',s1.growth_signals,'g')}
${tags('Tech Stack',s1.tech_stack_hints,'b')}
</div>`:''}

${s2.tam_overview?`<div class="sec">
<div class="sh"><div class="snum">2</div><div class="st">TAM Mapping</div></div>
<div class="g2">
<div class="mc"><div class="mn">${e(s2.tam_size_estimate||'—')}</div><div class="ml">Total Addressable Market</div></div>
<div class="mc"><div class="mn">${e(s2.growth_rate||'—')}</div><div class="ml">Growth Rate</div></div>
</div>
${field('TAM Overview',s2.tam_overview)}
${field('Priority Opportunities',s2.priority_opportunities)}
</div>`:''}

${s3.primary_icp?`<div class="sec pb">
<div class="sh"><div class="snum">3</div><div class="st">ICP Profile</div></div>
${field('Primary ICP',s3.primary_icp)}
${field('Firmographics',s3.firmographics)}
${field('Core Pain Points',s3.core_pain_points)}
${tags('Buying Triggers',s3.buying_triggers,'b')}
${tags('Decision Makers',s3.decision_makers)}
${tags('Objections',s3.objections)}
</div>`:''}

${s4.sourcing_playbook?`<div class="sec">
<div class="sh"><div class="snum">4</div><div class="st">Account Sourcing</div></div>
${tags('Databases',s4.recommended_databases,'g')}
${field('Filter Criteria',s4.filter_criteria)}
${field('Sourcing Playbook',s4.sourcing_playbook)}
${field('Exclusion Criteria',s4.exclusion_criteria)}
</div>`:''}

${s5.primary_keywords?`<div class="sec pb">
<div class="sh"><div class="snum">5</div><div class="st">Keywords</div></div>
${tags('Primary Keywords',s5.primary_keywords,'g')}
${tags('Secondary Keywords',s5.secondary_keywords)}
${field('Boolean Query',s5.boolean_query)}
${field('LinkedIn String',s5.linkedin_search_strings)}
</div>`:''}

${s6.email_1?`<div class="sec pb">
<div class="sh"><div class="snum">6</div><div class="st">Outreach Messaging</div></div>
${['email_1','email_2','email_3'].map(k=>{const em=s6[k];if(!em)return'';return`<div class="eb"><div class="ea">${e(em.angle||k)}</div><div class="es">Subject: ${e(em.subject||'—')}</div><div class="ebo">${e(em.body||'—')}</div><div class="ec">→ ${e(em.cta||'—')}</div></div>`;}).join('')}
${field('Follow-up Sequence',s6.follow_up_sequence)}
${field('LinkedIn Message',s6.linkedin_message)}
</div>`:''}

<div class="fbar">${e(strategy.company_name)} GTM Strategy · ${date} · Confidential · AB Enterprise AI Revenue Infrastructure</div>
</body></html>`;
}

function e(str) {
  if (typeof str !== 'string') return String(str||'');
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}
