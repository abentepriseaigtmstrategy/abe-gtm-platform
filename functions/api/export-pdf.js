/**
 * /api/export-pdf  (v4 — enterprise-grade with Decision Engine)
 * Cloudflare Pages Function
 *
 * Generates a full enterprise HTML report rendered to PDF via html2canvas + jsPDF
 * on the frontend. Includes SWOT, TAM waterfall, ICP pain map, intent taxonomy,
 * analyst insights, and Step 7 Decision Engine.
 *
 * INPUT:  POST { strategy: { company_name, industry, step_1_market, ... } }
 * OUTPUT: JSON { html, filename, mode: 'html2pdf' }
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
// ENTERPRISE-GRADE HTML REPORT — rendered to PDF by report.html
// ══════════════════════════════════════════════════════════════════
export function buildReportHTML(strategy) {
  const s1 = strategy.step_1_market    || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam       || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp       || strategy.steps?.[3] || {};
  const s4 = strategy.step_4_sourcing  || strategy.steps?.[4] || {};
  const s5 = strategy.step_5_keywords  || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};
  const s7 = strategy.step_7_intelligence || {};

  const date  = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const score = s1.gtm_relevance_score;
  const sc    = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';

  const e = str => {
    if (typeof str !== 'string') return String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  };

  const safe = val => {
    if (!val && val !== 0) return '';
    if (Array.isArray(val)) return val.join(', ');
    if (typeof val === 'object') {
      return Object.entries(val).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
    }
    return String(val);
  };

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

  const callout = (text, color = '#a855f7') => {
    if (!text) return '';
    return `<div class="callout" style="border-left-color:${color}"><strong>👉 Analyst Insight:</strong> ${e(text)}</div>`;
  };

  const secContext = (text) => {
    if (!text) return '';
    return `<div class="sec-ctx">${e(text)}</div>`;
  };

  const section = (num, title, contextText, body) =>
    body.trim() ? `<div class="sec">
      <div class="sh">
        <div class="snum">${num}</div>
        <div class="st">${e(title)}</div>
      </div>
      ${secContext(contextText)}
      ${body}
    </div>` : '';

  // ── SWOT Grid Builder ──
  const buildSWOT = () => {
    const swot = s1.swot;
    if (!swot || typeof swot !== 'object') return '';
    const cell = (label, items, color) => {
      const arr = Array.isArray(items) ? items : [];
      if (!arr.length) return '';
      return `<div class="swot-cell" style="border-top:3px solid ${color}">
        <div class="swot-label" style="color:${color}">${label}</div>
        <ul>${arr.slice(0,4).map(i => `<li>${e(String(i))}</li>`).join('')}</ul>
      </div>`;
    };
    const html = cell('STRENGTHS', swot.strengths, '#22c55e') +
                 cell('WEAKNESSES', swot.weaknesses, '#ef4444') +
                 cell('OPPORTUNITIES', swot.opportunities, '#3b82f6') +
                 cell('THREATS', swot.threats, '#f59e0b');
    return html ? `<div class="swot-grid">${html}</div>` : '';
  };

  // ── TAM Waterfall Builder ──
  const buildWaterfall = () => {
    const wf = s2.waterfall;
    const tam = safe(s2.tam_size_estimate);
    if (!tam && (!wf || typeof wf !== 'object')) return '';
    const bar = (label, value, width, color) => value ? `<div class="wf-row">
      <div class="wf-label">${label}</div>
      <div class="wf-val">${e(value)}</div>
      <div class="wf-bar-wrap"><div class="wf-bar" style="width:${width};background:${color}"></div></div>
    </div>` : '';
    return `<div class="waterfall">
      ${bar('TAM', wf?.tam_value || tam, '90%', '#3b82f6')}
      ${bar('SAM', wf?.sam_value || safe(s2.sam_estimate), '60%', '#7c3aed')}
      ${bar('CAGR', safe(s2.growth_rate), '35%', '#f59e0b')}
      ${bar('SOM', wf?.som_value || '5–10%', '12%', '#22c55e')}
    </div>`;
  };

  // ── Market Segments Table ──
  const buildSegments = () => {
    const segs = s2.market_segments;
    if (!Array.isArray(segs) || !segs.length) return '';
    const rows = segs.slice(0, 8).map(sg => {
      return `<tr>
        <td>${e(safe(sg.name || sg.segment_name || '—'))}</td>
        <td style="text-align:right;font-family:monospace">${e(safe(sg.size || sg.market_size || '—'))}</td>
        <td>${e(safe(sg.priority || '—'))}</td>
        <td style="font-family:monospace">${e(safe(sg.growth_rate || '—'))}</td>
      </tr>`;
    }).join('');
    return `<div class="field"><div class="fl">Market Segments</div>
      <table class="dtable"><thead><tr><th>Segment</th><th style="text-align:right">Est. Size</th><th>Priority</th><th>Growth</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  // ── Pain-Solution Map ──
  const buildPainMap = () => {
    const map = s3.pain_solution_map;
    if (!Array.isArray(map) || !map.length) return '';
    const rows = map.slice(0, 5).map(p => `<tr>
      <td>${e(safe(p.operational_friction || '—'))}</td>
      <td style="color:#d97706">${e(safe(p.business_impact || '—'))}</td>
      <td style="color:#16a34a">${e(safe(p.recommended_intervention || '—'))}</td>
    </tr>`).join('');
    return `<div class="field"><div class="fl">Pain → Impact → Intervention</div>
      <table class="dtable"><thead><tr><th>Operational Friction</th><th>Business Impact</th><th>Recommended Intervention</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  // ── Account Targets Table ──
  const buildTargets = () => {
    const targets = s4.account_targets;
    if (!Array.isArray(targets) || !targets.length) return '';
    const rows = targets.slice(0, 5).map(t => `<tr>
      <td>${e(safe(t.account_name || '—'))}</td>
      <td style="text-align:center;font-weight:900;color:${(t.fit_score||0) >= 80 ? '#16a34a' : '#d97706'}">${t.fit_score || '—'}</td>
      <td>${e(safe(t.actionable_trigger || '—'))}</td>
    </tr>`).join('');
    return `<div class="field"><div class="fl">High-Fit Sample Accounts</div>
      <table class="dtable"><thead><tr><th>Account</th><th style="text-align:center">Fit Score</th><th>Actionable Trigger</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  // ── Keyword Taxonomy ──
  const buildKeywordTaxonomy = () => {
    const kt = s5.keyword_taxonomy;
    if (!kt || typeof kt !== 'object') return '';
    const early = Array.isArray(kt.early_funnel) ? kt.early_funnel : [];
    const late  = Array.isArray(kt.late_funnel)  ? kt.late_funnel  : [];
    if (!early.length && !late.length) return '';
    return `<div class="g2">
      <div><div class="fl">Early Funnel (Problem-Aware)</div><div class="tags">${early.map(k => `<span class="tag b">${e(k)}</span>`).join('')}</div></div>
      <div><div class="fl">Late Funnel (Solution-Aware)</div><div class="tags">${late.map(k => `<span class="tag g">${e(k)}</span>`).join('')}</div></div>
    </div>`;
  };

  // ── Step 7 Decision Engine ──
  const buildDecisionEngine = () => {
    if (!score) return '';

    // Derive from existing data if step_7_intelligence is not present
    const hasS7 = s7 && Object.keys(s7).length > 1;

    let verdict, verdictColor, reason, confidence;
    if (hasS7 && s7.go_no_go) {
      const rec = s7.go_no_go.recommendation || 'Watch';
      verdict = rec;
      verdictColor = rec === 'Go' ? '#22c55e' : rec === 'No-Go' ? '#ef4444' : '#f59e0b';
      reason = s7.go_no_go.reason || '';
      confidence = s7.confidence_score || score;
    } else if (score >= 75) {
      verdict = 'GO'; verdictColor = '#22c55e'; confidence = Math.min(score + 7, 97);
      reason = `GTM score of ${score} indicates strong product-market alignment. Initiate outbound immediately.`;
    } else if (score >= 50) {
      verdict = 'WATCH'; verdictColor = '#f59e0b'; confidence = score - 5;
      reason = `GTM score of ${score} reflects moderate alignment. Monitor for trigger events before committing resources.`;
    } else {
      verdict = 'NO-GO'; verdictColor = '#ef4444'; confidence = Math.max(score - 10, 15);
      reason = `GTM score of ${score} indicates limited product-market fit. Re-evaluate in 90 days.`;
    }

    const triggers = Array.isArray(s3.buying_triggers) ? s3.buying_triggers : [];
    const primaryTrigger = triggers[0] || 'Operational pressure';
    const tam = safe(s2.tam_size_estimate) || 'undisclosed';
    const icp = safe(s3.primary_icp) || 'Senior technology decision-makers';
    const dms = Array.isArray(s3.decision_makers) ? s3.decision_makers : [];

    const whyNow = hasS7 && s7.why_now_analysis
      ? s7.why_now_analysis
      : `${safe(s1.company_overview) || 'This entity'} sits in a ${tam} market with active ${primaryTrigger.toLowerCase()} dynamics. Budget cycles are active, creating a time-sensitive engagement window.`;

    const hook = hasS7 && s7.strategic_hook
      ? s7.strategic_hook
      : (triggers.length >= 2 ? `${triggers[0]} paired with ${triggers[1]}` : `Lead with: ${primaryTrigger}`);

    return `<div class="sec" style="border-top:3px solid #a855f7">
      <div class="sh">
        <div class="snum" style="background:linear-gradient(135deg,#f59e0b,#d97706)">07</div>
        <div class="st">Revenue Intelligence — Decision Engine</div>
      </div>
      <div class="sec-ctx">Boardroom-grade decision layer. Actionable verdict before entering this account.</div>

      <div class="field"><div class="fl">Why Now</div>
        <div class="fv" style="border-left-color:#f59e0b">${e(whyNow)}</div>
      </div>

      <div class="field"><div class="fl">Strategic Hook</div>
        <div class="callout" style="border-left-color:#a855f7"><strong>"${e(hook)}"</strong></div>
      </div>

      <div class="field"><div class="fl">Risk &amp; Constraint Analysis</div>
        <div class="risk-list">
          <div class="risk-item"><strong>Decision Cycle Velocity</strong>${dms.length ? `Buying committee spans ${dms.slice(0,3).join(', ')}. Multi-stakeholder alignment extends cycle 30–60 days.` : 'Expect extended multi-stakeholder approval cycles.'}</div>
          <div class="risk-item"><strong>Vendor Lock-in Inertia</strong>Entrenched incumbent relationships reduce switching probability. Lead with differentiated outcome data.</div>
          <div class="risk-item"><strong>Budget Approval Friction</strong>Capital commitments require CFO-level ROI framing. Surface quantifiable efficiency recovery in every touchpoint.</div>
        </div>
      </div>

      <div class="field"><div class="fl">Decision</div>
        <div class="decision-box">
          <div class="decision-verdict" style="color:${verdictColor}">${e(verdict)}</div>
          <div class="decision-reason"><strong>Verdict:</strong> ${e(reason)}</div>
        </div>
      </div>

      <div class="field"><div class="fl">Execution Priority</div>
        <div class="fv" style="border-left-color:#22c55e"><strong>Target:</strong> ${e(dms[0] || icp)}<br>
        <strong>Lead With:</strong> ${e(primaryTrigger)}<br>
        <strong>Close With:</strong> ${safe(s2.growth_rate) ? `Market growing at ${safe(s2.growth_rate)} — quantify cost of delayed adoption` : 'Quantified ROI recovery and risk elimination'}</div>
      </div>

      <div class="field"><div class="fl">Confidence Score</div>
        <div style="display:flex;align-items:center;gap:14px">
          <div style="font-size:22px;font-weight:900;font-family:monospace;color:${verdictColor}">${confidence}/100</div>
          <div style="flex:1">
            <div style="font-size:8px;color:#9ca3af;margin-bottom:4px">Based on signal strength, data availability, and trigger clarity.</div>
            <div class="conf-bar"><div class="conf-fill" style="width:${confidence}%"></div></div>
          </div>
        </div>
      </div>
    </div>`;
  };

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
  color:white;padding:0;page-break-after:always;
  height:1122px;display:flex;flex-direction:column;position:relative;overflow:hidden;
}
.cover-accent-bar{height:6px;background:linear-gradient(90deg,#a855f7,#7c3aed,#4f46e5);flex-shrink:0}
.cover-body{padding:40px 48px 0;flex:1;display:flex;flex-direction:column}
.cover-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(168,85,247,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none}
.clogo-row{display:flex;align-items:center;gap:10px;margin-bottom:56px}
.clogo-mark{width:34px;height:34px;background:linear-gradient(135deg,#a855f7,#7c3aed);border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:white;flex-shrink:0}
.clogo-name{font-size:11px;font-weight:900;color:white;line-height:1.1}
.clogo-sub{font-size:7px;color:#6b7280;letter-spacing:.2em;text-transform:uppercase;margin-top:2px}
.ctitle{font-size:44px;font-weight:900;line-height:1.05;letter-spacing:-1.5px;margin-bottom:14px;color:white}
.ctitle span{color:#a855f7}
.cco{font-size:20px;color:#a855f7;font-weight:700;margin-bottom:6px}
.cind{font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.15em;margin-bottom:44px}
.cstats{display:flex;gap:16px;flex-wrap:wrap}
.cstat{flex:1;min-width:80px;text-align:center;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px 12px}
.csn{font-size:24px;font-weight:900;font-family:monospace;color:white;line-height:1}
.csl{font-size:7px;text-transform:uppercase;letter-spacing:.18em;color:#6b7280;margin-top:6px}
.cfoot{position:absolute;bottom:28px;left:48px;right:48px;font-size:8px;color:#6b7280;border-top:1px solid rgba(255,255,255,.08);padding-top:14px}
.cconf{display:inline-block;padding:3px 8px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);border-radius:4px;color:#a855f7;font-size:7px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;margin-bottom:6px}

/* ── Page header ── */
.page-hdr{background:#0B0F1A;padding:8px 40px;display:flex;justify-content:space-between;align-items:center;page-break-inside:avoid;page-break-after:avoid}
.page-hdr-l{font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.2em;color:#6b7280}
.page-hdr-r{font-size:7px;color:#6b7280;font-family:monospace}
.page-hdr-accent{height:2px;background:linear-gradient(90deg,#a855f7,transparent)}

/* ── Section blocks ── */
.sec{padding:24px 40px}
.sec+.sec{border-top:1px solid #f3f4f6}
.sh{display:flex;align-items:center;gap:10px;margin-bottom:8px;page-break-inside:avoid;page-break-after:avoid}
.snum{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#7c3aed);color:white;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(168,85,247,.4)}
.st{font-size:15px;font-weight:900;color:#111827;letter-spacing:-.3px}
.sec-ctx{font-size:9px;color:#9ca3af;margin-bottom:14px;padding-bottom:8px;border-bottom:1px dashed #e5e7eb}

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
.tag.r{background:#fee2e2;color:#991b1b;border-color:#fecaca}

/* ── Analyst Callout ── */
.callout{background:#faf5ff;border:1px solid #e9d5ff;border-left:4px solid #a855f7;border-radius:6px;padding:10px 14px;margin:10px 0;font-size:10px;line-height:1.65;page-break-inside:avoid}

/* ── SWOT Grid ── */
.swot-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.swot-cell{border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;background:#fafafa}
.swot-label{font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.15em;margin-bottom:6px}
.swot-cell ul{padding-left:14px;font-size:9.5px;color:#374151;line-height:1.6}
.swot-cell li{margin-bottom:3px}

/* ── Waterfall ── */
.waterfall{margin:10px 0 14px}
.wf-row{display:flex;align-items:center;margin-bottom:8px;gap:8px}
.wf-label{width:50px;font-size:7px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;text-align:right}
.wf-val{width:80px;font-family:monospace;font-size:10px;font-weight:700;text-align:right;color:#111827;flex-shrink:0}
.wf-bar-wrap{flex:1;background:#f3f4f6;border-radius:4px;height:12px;overflow:hidden}
.wf-bar{height:100%;border-radius:4px}

/* ── Data Tables ── */
.dtable{width:100%;border-collapse:collapse;font-size:9.5px;margin-bottom:10px}
.dtable th{text-align:left;color:#9ca3af;font-weight:700;font-size:7px;text-transform:uppercase;letter-spacing:.1em;padding:6px 8px;border-bottom:1px solid #e5e7eb}
.dtable td{padding:8px;border-bottom:1px solid #f3f4f6;vertical-align:top;line-height:1.55}

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

/* ── Decision Engine ── */
.decision-box{display:flex;align-items:center;gap:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;page-break-inside:avoid}
.decision-verdict{font-size:28px;font-weight:900;font-family:monospace;min-width:70px}
.decision-reason{font-size:10.5px;color:#374151;line-height:1.65}
.risk-list{margin-bottom:10px}
.risk-item{padding:8px 12px;border-left:3px solid #ef4444;background:#fef2f2;border-radius:0 6px 6px 0;margin-bottom:6px;font-size:9.5px;line-height:1.55;page-break-inside:avoid}
.risk-item strong{color:#991b1b;display:block;margin-bottom:2px;font-size:8px;text-transform:uppercase;letter-spacing:.08em}
.conf-bar{background:#f3f4f6;border-radius:4px;height:8px;overflow:hidden}
.conf-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#7c3aed,#a855f7)}

/* ── Footer ── */
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
      <div class="ctitle">GTM Intelligence<br><span>Strategy</span> Report</div>
      <div class="cco">${e(strategy.company_name)}</div>
      ${strategy.industry ? `<div class="cind">${e(strategy.industry)}</div>` : '<div class="cind">&nbsp;</div>'}
      <div class="cstats">
        ${score ? `<div class="cstat"><div class="csn" style="color:${sc}">${score}</div><div class="csl">GTM Score</div></div>` : ''}
        ${s2.tam_size_estimate ? `<div class="cstat"><div class="csn">${e(s2.tam_size_estimate)}</div><div class="csl">TAM Size</div></div>` : ''}
        ${s2.growth_rate ? `<div class="cstat"><div class="csn">${e(s2.growth_rate)}</div><div class="csl">CAGR</div></div>` : ''}
        <div class="cstat"><div class="csn">${strategy.steps_completed || 6}/6</div><div class="csl">Steps Done</div></div>
        ${score ? `<div class="cstat"><div class="csn" style="color:${sc}">${score >= 75 ? 'GO' : score >= 50 ? 'WATCH' : 'NO-GO'}</div><div class="csl">Verdict</div></div>` : ''}
      </div>
    </div>
  </div>
  <div class="cfoot">
    <div class="cconf">Confidential</div>
    <div>Generated ${date} &nbsp;·&nbsp; ABE Enterprise AI Revenue Infrastructure &nbsp;·&nbsp; GTM Intelligence Platform</div>
  </div>
</div>

<!-- ═══════════ CONTENT PAGES ═══════════ -->
<div class="page-hdr">
  <div class="page-hdr-l">ABE GTM Intelligence Report &nbsp;·&nbsp; ${e(strategy.company_name)}</div>
  <div class="page-hdr-r">${date}</div>
</div>
<div class="page-hdr-accent"></div>

${section('01', 'Market Research & SWOT Analysis', s1.section_context || 'Deconstructs positioning and isolates macro triggers.',
  buildSWOT() +
  field('Company Overview', s1.company_overview) +
  field('Market Position', s1.market_position) +
  field('GTM Relevance Reasoning', s1.gtm_relevance_reasoning) +
  tags('Growth Signals', s1.growth_signals, 'g') +
  tags('Tech Stack Hints', s1.tech_stack_hints, 'b') +
  callout(s1.analyst_insight)
)}

${s2.tam_overview ? section('02', 'TAM Mapping — The Opportunity', s2.section_context || 'Quantifies total market velocity and filters it to actionable scope.',
  `<div class="g2">
    <div class="mc green"><div class="mn">${e(s2.tam_size_estimate || '—')}</div><div class="ml">Total Addressable Market</div></div>
    <div class="mc amber"><div class="mn">${e(s2.growth_rate || '—')}</div><div class="ml">CAGR / Growth Rate</div></div>
  </div>` +
  buildWaterfall() +
  buildSegments() +
  field('TAM Overview', s2.tam_overview, '#22c55e') +
  field('Priority Opportunities', s2.priority_opportunities) +
  field('Market Maturity', s2.market_maturity) +
  callout(s2.analyst_insight)
) : ''}

${s3.primary_icp ? section('03', 'ICP Modeling — The Persona', s3.section_context || 'Maps decision-makers and operational pain to high-margin solutions.',
  field('Primary ICP Definition', s3.primary_icp) +
  field('Secondary ICP', s3.secondary_icp) +
  field('Firmographics', s3.firmographics) +
  field('Core Pain Points', s3.core_pain_points, '#ef4444') +
  buildPainMap() +
  tags('Buying Triggers', s3.buying_triggers, 'b') +
  tags('Key Decision Makers', s3.decision_makers) +
  tags('Common Objections', s3.objections, 'o') +
  field('Deal Cycle', s3.deal_cycle) +
  callout(s3.analyst_insight)
) : ''}

${s4.sourcing_playbook ? section('04', 'Account Sourcing — The Targets', s4.section_context || 'Translates persona into actionable technographic filters.',
  tags('Recommended Databases', s4.recommended_databases, 'g') +
  field('Filter Criteria', s4.filter_criteria) +
  field('Sourcing Playbook', s4.sourcing_playbook) +
  field('Exclusion Criteria', s4.exclusion_criteria, '#ef4444') +
  field('Estimated Universe', s4.estimated_universe) +
  field('Data Enrichment Tips', s4.data_enrichment_tips) +
  buildTargets() +
  callout(s4.analyst_insight)
) : ''}

${s5.primary_keywords ? section('05', 'Keywords & Intent Intelligence', s5.section_context || 'Maps the semantic footprint before RFP issuance.',
  buildKeywordTaxonomy() +
  tags('Primary Keywords', s5.primary_keywords, 'g') +
  tags('Secondary Keywords', s5.secondary_keywords, 'b') +
  field('Boolean Query String', s5.boolean_query, '#7c3aed', true) +
  field('LinkedIn Search String', s5.linkedin_search_strings, '#0077b5') +
  tags('Intent Signals', s5.intent_signals, 'o') +
  tags('Content Topics', s5.content_topics, 'b') +
  callout(s5.analyst_insight)
) : ''}

${s6.email_1 ? `<div class="pb">` + section('06', 'Outreach Messaging — The Engagement', s6.section_context || 'Hyper-targeted sequences designed to agitate pain and validate scalability.',
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
  field('LinkedIn Follow-up', s6.linkedin_follow_up, '#0077b5') +
  callout(s6.analyst_insight)
) + `</div>` : ''}

${buildDecisionEngine()}

<div style="text-align:center;padding:20px 0 6px;margin-top:8px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:8px;letter-spacing:.08em">
  ${e(strategy.company_name)} &nbsp;·&nbsp; GTM Intelligence Report &nbsp;·&nbsp; ${date} &nbsp;·&nbsp; Confidential &nbsp;·&nbsp; ABE Enterprise AI Revenue Infrastructure
</div>

</body>
</html>`;
}
