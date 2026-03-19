/**
 * /api/export-pdf  (v3 — production-ready)
 * Cloudflare Pages Function
 *
 * ROOT CAUSE FIX (Bug #5):
 *   The previous version attempted `await import('pdf-lib')` inside a Cloudflare
 *   Worker where there is no node_modules directory. This always threw silently,
 *   setting PDF_LIB_AVAILABLE = false. The code then fell through to the HTML
 *   fallback, but that fallback had low-quality html2pdf.js settings.
 *
 *   Fix: Remove the broken dynamic import entirely. Always use the HTML path,
 *   which is robust in Cloudflare Pages. The HTML template is upgraded to
 *   professional corporate A4 standard — full cover page, branded sections,
 *   stats grid, email blocks — matching what pdf-lib would have produced.
 *
 * INPUT:  POST { strategy: { company_name, industry, step_1_market, ... } }
 * OUTPUT: JSON { html, filename, mode: 'html2pdf' }
 *         vault.html frontend renders this with html2pdf.js at scale:3
 */

import { verifyAuth, corsHeaders, validate, errRes } from './_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // ── Auth ──────────────────────────────────────────────────────
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid request body', 400, cors); }

  const errors = validate({ strategy: 'required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);

  const { strategy } = body;
  if (!strategy.company_name) return errRes('Missing strategy.company_name', 400, cors);

  const filename = `GTM_${strategy.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;

  const html = buildReportHTML(strategy);
  return new Response(JSON.stringify({ html, filename, mode: 'html2pdf' }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}

// ══════════════════════════════════════════════════════════════════
// CORPORATE-GRADE HTML REPORT — rendered to PDF by vault.html
// ══════════════════════════════════════════════════════════════════
export function buildReportHTML(strategy) {
  const s1 = strategy.step_1_market    || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam       || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp       || strategy.steps?.[3] || {};
  const s4 = strategy.step_4_sourcing  || strategy.steps?.[4] || {};
  const s5 = strategy.step_5_keywords  || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};

  const date  = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const score = s1.gtm_relevance_score;
  const sc    = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';

  const e = str => {
    if (typeof str !== 'string') return String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  };

  // FIX [object Object]: safe() handles arrays, nested objects, and primitives
  // The AI sometimes returns filter_criteria / exclusion_criteria as objects, not strings
  const safe = val => {
    if (!val && val !== 0) return '';
    if (Array.isArray(val)) return val.join(', ');
    if (typeof val === 'object') {
      // Flatten object into readable key: value lines
      return Object.entries(val).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
    }
    return String(val);
  };

  // FIX: use safe() so objects/arrays render as readable text, not [object Object]
  const field = (label, val, accent = '#a855f7', mono = false) => {
    const rendered = safe(val);
    return rendered ? `<div class="field">
      <div class="fl">${e(label)}</div>
      <div class="fv${mono ? ' mono' : ''}" style="border-left-color:${accent}">${e(rendered)}</div>
    </div>` : '';
  };

  const tags = (label, arr, tagCls = '') => {
    const safeArr = Array.isArray(arr) ? arr : (arr ? [String(arr)] : []);
    return safeArr.length ? `<div class="field">
      <div class="fl">${e(label)}</div>
      <div class="tags">${safeArr.slice(0, 20).map(t => `<span class="tag ${tagCls}">${e(String(t))}</span>`).join('')}</div>
    </div>` : '';
  };

  const section = (num, title, body) =>
    body.trim() ? `<div class="sec">
      <div class="sh">
        <div class="snum">${num}</div>
        <div class="st">${e(title)}</div>
      </div>
      ${body}
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
/* ── Reset ── */
*{box-sizing:border-box;margin:0;padding:0}
html{font-size:11px}
body{font-family:Helvetica,Arial,sans-serif;color:#111827;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}

/* ── Cover ── */
.cover{
  background:linear-gradient(160deg,#0B0F1A 0%,#150a2e 60%,#0B0F1A 100%);
  color:white;
  padding:0;
  page-break-after:always;
  /* 1122px = A4 at 96dpi exactly (794px × 841.89/595.28 = 1122.9px).
     Cover must fill exactly one canvas slice so page-hdr lands at top of page 2. */
  height:1122px;
  display:flex;
  flex-direction:column;
  position:relative;
  overflow:hidden;
}
.cover-accent-bar{height:6px;background:linear-gradient(90deg,#a855f7,#7c3aed,#4f46e5);flex-shrink:0}
/* cover-body: flex column only. cfoot is position:absolute so it never relies on
   flex space-between which was causing the footer to land exactly at the page-slice boundary. */
.cover-body{padding:40px 48px 0;flex:1;display:flex;flex-direction:column;}
.cover-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(168,85,247,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none}
.clogo-row{display:flex;align-items:center;gap:10px;margin-bottom:56px}
.clogo-mark{width:34px;height:34px;background:linear-gradient(135deg,#a855f7,#7c3aed);border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:white;flex-shrink:0}
.clogo-name{font-size:11px;font-weight:900;color:white;line-height:1.1}
.clogo-sub{font-size:7px;color:#6b7280;letter-spacing:.2em;text-transform:uppercase;margin-top:2px}
.ctitle{font-size:44px;font-weight:900;line-height:1.05;letter-spacing:-1.5px;margin-bottom:14px;color:white}
.ctitle span{color:#a855f7}
.cco{font-size:20px;color:#a855f7;font-weight:700;margin-bottom:6px}
.cind{font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.15em;margin-bottom:44px}
.cstats{display:flex;gap:16px;margin-bottom:0;flex-wrap:wrap}
.cstat{flex:1;min-width:80px;text-align:center;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px 12px}
.csn{font-size:24px;font-weight:900;font-family:monospace;color:white;line-height:1}
.csl{font-size:7px;text-transform:uppercase;letter-spacing:.18em;color:#6b7280;margin-top:6px}
/* cfoot: position:absolute at bottom of cover (cover has position:relative).
   This is reliable regardless of content height — never hits the page-slice boundary. */
.cfoot{position:absolute;bottom:28px;left:48px;right:48px;font-size:8px;color:#6b7280;border-top:1px solid rgba(255,255,255,.08);padding-top:14px}
.cconf{display:inline-block;padding:3px 8px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);border-radius:4px;color:#a855f7;font-size:7px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;margin-bottom:6px}

/* ── Page header (repeated on content pages) ── */
.page-hdr{background:#0B0F1A;padding:8px 40px;display:flex;justify-content:space-between;align-items:center;page-break-inside:avoid;page-break-after:avoid}
.page-hdr-l{font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.2em;color:#6b7280}
.page-hdr-r{font-size:7px;color:#6b7280;font-family:monospace}
.page-hdr-accent{height:2px;background:linear-gradient(90deg,#a855f7,transparent)}

/* ── Section blocks — FIX: page-break-inside:avoid removed from .sec (entire section).
   Large sections caused blank gaps. Now only atomic items (.sh, .field) avoid breaks. ── */
.sec{padding:24px 40px}
.sec+.sec{border-top:1px solid #f3f4f6}
.sh{display:flex;align-items:center;gap:10px;margin-bottom:18px;page-break-inside:avoid;page-break-after:avoid}
.snum{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#7c3aed);color:white;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(168,85,247,.4)}
.st{font-size:15px;font-weight:900;color:#111827;letter-spacing:-.3px}

/* ── Fields ── */
.field{margin-bottom:12px;page-break-inside:avoid}
.fl{font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.2em;color:#9ca3af;margin-bottom:5px}
.fv{font-size:10.5px;color:#374151;line-height:1.7;background:#f9fafb;border-radius:6px;padding:10px 14px;border-left:3px solid #a855f7;white-space:pre-wrap;word-break:break-word}
.fv.mono{font-family:'Courier New',monospace;font-size:9.5px;background:#f3f4f6;word-break:break-all}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.tag{font-size:8.5px;font-weight:700;padding:3px 9px;border-radius:4px;background:#f3e8ff;color:#7c3aed;border:1px solid #e9d5ff}
.tag.g{background:#dcfce7;color:#166534;border-color:#bbf7d0}
.tag.b{background:#dbeafe;color:#1d4ed8;border-color:#bfdbfe}
.tag.o{background:#fef3c7;color:#92400e;border-color:#fde68a}

/* ── Stats row ── */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.mc{background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:14px}
.mn{font-size:20px;font-weight:900;font-family:monospace;color:#111827}
.ml{font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:#9ca3af;margin-top:4px}
.mc.green .mn{color:#16a34a}
.mc.amber .mn{color:#d97706}
.mc.purple .mn{color:#7c3aed}

/* ── Email blocks ── */
.pb{page-break-before:always}
.eb{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin-bottom:12px;page-break-inside:avoid;position:relative;overflow:hidden}
.eb::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#a855f7,#7c3aed)}
.ea{font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.2em;color:#a855f7;margin-bottom:6px}
.es{font-size:11.5px;font-weight:800;color:#111827;margin-bottom:8px}
.ebo{font-size:10.5px;color:#374151;line-height:1.75;white-space:pre-wrap}
.ec{font-size:10px;font-weight:700;color:#7c3aed;margin-top:10px;padding-top:10px;border-top:1px solid #e5e7eb}

/* ── Footer bar ── */
.fbar{background:#0B0F1A;color:#374151;font-size:7.5px;text-align:center;padding:10px 40px;page-break-before:avoid;display:flex;justify-content:space-between;align-items:center}
.fbar span{color:#a855f7}
</style>
</head>
<body>

<!-- ═══════════ COVER PAGE ═══════════ -->
<div class="cover">
  <div class="cover-accent-bar"></div>
  <div class="cover-grid"></div>
  <div class="cover-body">
    <div>
      <div class="clogo-row">
        <div class="clogo-mark">ABE</div>
        <div>
          <div class="clogo-name">ABE</div>
          <div class="clogo-sub">Enterprise AI Revenue Infrastructure</div>
        </div>
      </div>
      <div class="ctitle">GTM Strategy<br><span>Intelligence</span> Report</div>
      <div class="cco">${e(strategy.company_name)}</div>
      ${strategy.industry ? `<div class="cind">${e(strategy.industry)}</div>` : '<div class="cind">&nbsp;</div>'}
      <div class="cstats">
        ${score ? `<div class="cstat"><div class="csn" style="color:${sc}">${score}</div><div class="csl">GTM Score</div></div>` : ''}
        ${s2.tam_size_estimate ? `<div class="cstat"><div class="csn">${e(s2.tam_size_estimate)}</div><div class="csl">TAM Size</div></div>` : ''}
        ${s2.growth_rate ? `<div class="cstat"><div class="csn">${e(s2.growth_rate)}</div><div class="csl">CAGR</div></div>` : ''}
        <div class="cstat"><div class="csn">${strategy.steps_completed || 6}/6</div><div class="csl">Steps Done</div></div>
      </div>
    </div>
  </div>
  <!-- cfoot: direct child of .cover, positioned absolute at bottom of the 1122px cover div.
       Sibling of cover-body (not inside it) so the flex layout never pushes it
       to the exact page-slice boundary. -->
  <div class="cfoot">
    <div class="cconf">Confidential</div>
    <div>Generated ${date} &nbsp;·&nbsp; ABE Enterprise AI Revenue Infrastructure &nbsp;·&nbsp; GTM Strategy Platform</div>
  </div>
</div>

<!-- ═══════════ CONTENT PAGES ═══════════ -->
<div class="page-hdr">
  <div class="page-hdr-l">ABE GTM Strategy Intelligence Report &nbsp;·&nbsp; ${e(strategy.company_name)}</div>
  <div class="page-hdr-r">${date}</div>
</div>
<div class="page-hdr-accent"></div>

${section('01', 'Market Research & Company Overview',
  field('Company Overview', s1.company_overview) +
  field('Market Position', s1.market_position) +
  field('GTM Relevance Reasoning', s1.gtm_relevance_reasoning) +
  tags('Growth Signals', s1.growth_signals, 'g') +
  tags('Tech Stack Hints', s1.tech_stack_hints, 'b')
)}

${s2.tam_overview ? section('02', 'TAM Mapping & Market Sizing',
  `<div class="g2">
    <div class="mc green"><div class="mn">${e(s2.tam_size_estimate || '—')}</div><div class="ml">Total Addressable Market</div></div>
    <div class="mc amber"><div class="mn">${e(s2.growth_rate || '—')}</div><div class="ml">CAGR / Growth Rate</div></div>
  </div>` +
  field('TAM Overview', s2.tam_overview, '#22c55e') +
  field('Priority Opportunities', s2.priority_opportunities)
) : ''}

${s3.primary_icp ? `<div class="pb">` + section('03', 'Ideal Customer Profile (ICP)',
  field('Primary ICP Definition', s3.primary_icp) +
  field('Firmographics', s3.firmographics) +
  field('Core Pain Points', s3.core_pain_points, '#ef4444') +
  tags('Buying Triggers', s3.buying_triggers, 'b') +
  tags('Key Decision Makers', s3.decision_makers) +
  tags('Common Objections', s3.objections, 'o')
) + `</div>` : ''}

${s4.sourcing_playbook ? section('04', 'Account Sourcing Strategy',
  tags('Recommended Databases', s4.recommended_databases, 'g') +
  field('Filter Criteria', s4.filter_criteria) +
  field('Sourcing Playbook', s4.sourcing_playbook) +
  field('Exclusion Criteria', s4.exclusion_criteria, '#ef4444')
) : ''}

${s5.primary_keywords ? section('05', 'Intent Keywords & Boolean Search',
  tags('Primary Keywords', s5.primary_keywords, 'g') +
  tags('Secondary Keywords', s5.secondary_keywords, 'b') +
  field('Boolean Query String', s5.boolean_query, '#7c3aed', true) +
  field('LinkedIn Search String', s5.linkedin_search_strings, '#0077b5')
) : ''}

${s6.email_1 ? `<div class="pb">` + section('06', 'Outreach Messaging & Email Sequences',
  ['email_1','email_2','email_3'].map(k => {
    const em = s6[k];
    if (!em) return '';
    return `<div class="eb">
      <div class="ea">${e(em.angle || k.replace('_',' ').toUpperCase())}</div>
      <div class="es">Subject: ${e(em.subject || '—')}</div>
      <div class="ebo">${e(em.body || '—')}</div>
      <div class="ec">CTA → ${e(em.cta || '—')}</div>
    </div>`;
  }).join('') +
  field('Follow-up Sequence', s6.follow_up_sequence) +
  field('LinkedIn Message', s6.linkedin_message, '#0077b5') +
  // End-of-report marker: inline inside section 06 so it ALWAYS flows on the same page
  // as the last section content. A standalone fbar block always orphans to a new page
  // when section 06 fills the page — html2pdf has no support for running footer elements.
  `<div style="text-align:center;padding:20px 0 6px;margin-top:8px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:8px;letter-spacing:.08em">
    ${e(strategy.company_name)} &nbsp;·&nbsp; GTM Strategy Intelligence Report &nbsp;·&nbsp; ${date} &nbsp;·&nbsp; Confidential &nbsp;·&nbsp; ABE Enterprise AI Revenue Infrastructure
  </div>`
) + `</div>` : ''}

</body>
</html>`;
}
