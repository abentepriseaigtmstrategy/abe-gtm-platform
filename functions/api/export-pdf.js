/**
 * /api/export-pdf  (v6 — Enterprise A4 Report)
 * Cloudflare Pages Function
 * INPUT:  POST { strategy: { company_name, industry, step_1_market, ... } }
 * OUTPUT: JSON { html, filename, mode: 'html2pdf' }
 */
import { verifyAuth, corsHeaders, validate, errRes } from './_middleware.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const { user, error: authErr } = await verifyAuth(request, env);
  if (!user) return errRes(authErr || 'Unauthorized', 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return errRes('Invalid request body', 400, cors);
  }

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

export function buildReportHTML(strategy) {
  const s1 = strategy.step_1_market || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp || strategy.steps?.[3] || {};
  const s4 = strategy.step_4_sourcing || strategy.steps?.[4] || {};
  const s5 = strategy.step_5_keywords || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};
  const s7 = strategy.step_7_intelligence || strategy.steps?.[7] || {};

  const company = strategy.company_name || 'Company';
  const industry = strategy.industry || '';
  const reportDate = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const mode = getReportMode(strategy);
  const gtmScore = getGtmScore(s1, s2, s6, s7);
  const confidenceScore = normalizeScore(s7.confidence_score || s7.confidence || s7.score || gtmScore) || 0;
  const verdict = getVerdict(gtmScore, s7);

  const tam = safe(s2.tam_size_estimate || s2.tam || s2.market_size) || '—';
  const sam = safe(s2.sam || s2.sam_estimate || s2.market_serviceable || s2.serviceable_market) || '—';
  const som = safe(s2.som || s2.som_estimate || s2.served_market || s2.served_market_estimate) || '—';
  const cagr = safe(s2.growth_rate || s2.cagr) || '—';
  const stepsComplete = [s1, s2, s3, s4, s5, s6, s7].filter(step => step && Object.keys(step).length > 0).length;
  const profileSource = safe(strategy.scraped_profile?._profile_source || s1._profile_source || s2._profile_source || s3._profile_source || s4._profile_source || s5._profile_source || s6._profile_source || s7._profile_source || strategy._profile_source || 'Not available');
  const confidenceBasis = safe(strategy.scraped_profile?._confidence_basis || s1._confidence_basis || s2._confidence_basis || s3._confidence_basis || s4._confidence_basis || s5._confidence_basis || s6._confidence_basis || s7._confidence_basis || strategy._confidence_basis || 'Not available');
  const missingEvidence = safe(strategy.scraped_profile?._missing_evidence || s1._missing_evidence || s2._missing_evidence || s3._missing_evidence || s4._missing_evidence || s5._missing_evidence || s6._missing_evidence || s7._missing_evidence || strategy._missing_evidence || 'Not available');
  const sourceContext = safe(strategy.scraped_profile?._source_context || s1._source_context || s2._source_context || s3._source_context || s4._source_context || s5._source_context || s6._source_context || s7._source_context || strategy._source_context || 'Not available');
  const evidenceNotice = mode.isDemo ? 'Demo mode output is illustrative only. No live data was used.' : 'This report is based on the available validated data sources.';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(company)} GTM Intelligence Report</title><style>
    :root{--bg:#090b14;--surface:#101827;--surface-soft:#131d30;--border:#24304b;--accent:#a855f7;--accent-soft:#7c3aed;--green:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#3b82f6;--text:#e5e7eb;--muted:#9ca3af;--white:#ffffff;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body{min-height:100%;background:#080d1a;color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;line-height:1.6;}
    body{margin:0;padding:0;}
    #root{width:210mm;margin:0 auto;padding:0;}
    .page.pdf-page{width:210mm;padding:20mm;box-sizing:border-box;position:relative;background:linear-gradient(180deg,rgba(7,13,26,.98),rgba(14,21,39,.98));border:1px solid rgba(255,255,255,.06);border-radius:12px;overflow:hidden;page-break-after:always;break-after:page;}
    .page.pdf-page:last-child{page-break-after:auto;}
    .page.pdf-page::before{content:'';position:absolute;inset:0;background-image:linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(180deg,rgba(255,255,255,.02) 1px,transparent 1px);background-size:48px 48px;opacity:.16;pointer-events:none;}
    .page-content{position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;}
    .header,.footer{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--muted);font-size:9px;}
    .panel-copy,.section-subtitle,.hero-copy,.metric-card-note,.mcc-value,.segment-value,.persona-detail,.timeline-step-meta,.appendix-copy{line-height:1.7;letter-spacing:normal;white-space:normal;overflow-wrap:normal;word-break:normal;}
    .break-anywhere{overflow-wrap:anywhere;word-break:break-word;}
    .header{margin-bottom:14px;}
    .footer{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);}
    .header-brand{display:flex;align-items:center;gap:12px;}
    .logo-mark{width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent-soft));display:grid;place-items:center;font-size:11px;font-weight:800;color:var(--white);letter-spacing:.18em;}
    .brand-copy{display:flex;flex-direction:column;gap:4px;}
    .brand-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.18em;color:var(--white);}
    .brand-subtitle{font-size:8.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.18em;}
    .header-badges{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;}
    .badge{padding:8px 12px;border-radius:999px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;border:1px solid rgba(255,255,255,.1);}
    .badge-demo{color:var(--amber);background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.22);}
    .badge-live{color:var(--green);background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.22);}
    .badge-confidential{color:var(--muted);background:rgba(255,255,255,.05);}
    .section-title{font-size:22px;font-weight:800;color:var(--white);line-height:1.1;}
    .section-subtitle{font-size:11px;color:var(--muted);line-height:1.7;}
    .pill-row{display:flex;flex-wrap:wrap;gap:10px;}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);font-size:9px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:.12em;}
    .pill-accent{color:var(--accent);border-color:rgba(168,85,247,.18);}
    .pill-green{color:var(--green);border-color:rgba(34,197,94,.18);}
    .panel{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:22px;}
    .panel-strong{font-size:13px;font-weight:800;color:var(--white);margin-bottom:12px;line-height:1.4;letter-spacing:normal;}
    .panel-copy{font-size:11px;color:var(--muted);line-height:1.7;letter-spacing:normal;white-space:normal;overflow-wrap:normal;word-break:normal;}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;}
    .grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;}
    .metric-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:10px;min-height:122px;}
    .metric-card-head{display:flex;align-items:center;gap:10px;}
    .metric-card-icon{width:24px;height:24px;color:var(--accent);flex-shrink:0;}
    .metric-card-title{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;font-weight:700;}
    .metric-card-value{font-size:22px;font-weight:900;color:var(--white);line-height:1.2;}
    .metric-card-note{font-size:10px;color:var(--muted);line-height:1.6;}
    .hero-panel{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:24px;display:grid;gap:16px;}
    .hero-title{font-size:20px;font-weight:900;color:var(--white);line-height:1.1;}
    .hero-copy{font-size:11px;color:var(--muted);line-height:1.7;}
    .hero-row{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start;}
    .hero-chip{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--text);font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;}
    .warning-strip{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.2);border-radius:16px;padding:14px;color:var(--amber);font-size:10px;}
    .kpi-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;}
    .progress-bar{display:grid;gap:8px;}
    .progress-row{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.14em;}
    .progress-track{height:10px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;}
    .progress-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent-soft),var(--accent));}
    .confidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .confidence-summary{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:12px;}
    .confidence-summary h3{font-size:12px;font-weight:700;color:var(--white);margin:0 0 8px;}
    .swot-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .swot-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:14px;}
    .swot-card-title{display:flex;align-items:center;gap:10px;font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;font-weight:700;}
    .list{list-style:none;padding-left:16px;margin:0;display:grid;gap:8px;}
    .list li{position:relative;padding-left:12px;font-size:11px;color:var(--text);line-height:1.7;}
    .list li::before{content:'';position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:50%;background:var(--accent);}
    .chip-wrap{display:flex;flex-wrap:wrap;gap:10px;}
    .chip-label{display:inline-flex;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--text);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;}
    .waterfall{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;display:grid;gap:14px;}
    .waterfall-row{display:grid;grid-template-columns:110px 1fr 70px;align-items:center;gap:12px;}
    .waterfall-label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;}
    .waterfall-bar{height:12px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;}
    .waterfall-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent-soft),var(--accent));}
    .waterfall-value{font-size:11px;color:var(--text);text-align:right;}
    .segment-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;}
    .segment-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;}
    .segment-card-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
    .segment-card-icon{width:20px;height:20px;color:var(--accent);flex-shrink:0;}
    .segment-label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;margin:0;}
    .segment-value{font-size:12px;color:var(--text);line-height:1.7;}
    .persona-block{display:grid;grid-template-columns:1.2fr .8fr;gap:16px;}
    .persona-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:22px;display:grid;gap:14px;}
    .persona-title{font-size:12px;font-weight:800;color:var(--white);}
    .persona-detail{font-size:11px;color:var(--muted);line-height:1.7;}
    .timeline{display:grid;gap:14px;}
    .timeline-step{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;display:grid;gap:10px;}
    .timeline-step-heading{display:flex;justify-content:space-between;gap:12px;font-size:11px;font-weight:700;color:var(--white);}
    .timeline-step-meta{font-size:10px;color:var(--muted);line-height:1.7;}
    .badge-block{display:inline-flex;align-items:center;justify-content:center;width:124px;height:60px;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);font-size:16px;font-weight:900;text-transform:uppercase;letter-spacing:.14em;}
    .badge-go{color:var(--green);border-color:rgba(34,197,94,.2);}
    .badge-watch{color:var(--amber);border-color:rgba(245,158,11,.2);}
    .badge-nogo{color:var(--red);border-color:rgba(239,68,68,.2);}
    .mcc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;}
    .mcc-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;}
    .mcc-label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;margin-bottom:8px;}
    .mcc-value{font-size:12px;color:var(--text);line-height:1.7;}
    .risk-strip{display:grid;gap:10px;}
    .risk-item{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:16px;}
    .risk-label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;margin-bottom:6px;}
    .risk-copy{font-size:11px;color:var(--text);line-height:1.7;}
    .appendix-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .appendix-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;}
    .appendix-label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.14em;margin-bottom:8px;}
    .appendix-copy{font-size:11px;color:var(--text);line-height:1.7;}
    @media print{.page{border:none;border-radius:0;}}
  </style></head><body><div id="root">
    ${renderCoverPage()}
    ${renderTruthLayerPage()}
    ${renderExecutiveSummaryPage()}
    ${renderMarketResearchPage()}
    ${renderTAMPage()}
    ${renderICPPage()}
    ${renderSourcingPage()}
    ${renderKeywordsPage()}
    ${renderSDRPage()}
    ${renderRevenueIntelPage()}
    ${renderConfidencePage()}
    ${renderAppendixPage()}
  </div></body></html>`;

  return html;

  function esc(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string') {
      if (Array.isArray(value)) return value.map(String).join(', ');
      if (typeof value === 'object') return Object.entries(value).map(([key, val]) => `${key}: ${val}`).join('; ');
      return String(value);
    }
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  function safe(value) {
    if (value === null || value === undefined || value === false) return '';
    if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined).map(String).join(', ');
    if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(', ') : item}`).join('; ');
    return String(value);
  }

  function asArray(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined).map(String).map(item => item.trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(/[\r\n,;]+/).map(item => item.trim()).filter(Boolean);
    return [String(value).trim()].filter(Boolean);
  }

  function normalizeScore(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(String(value).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function sentence(...parts) {
    return asArray(parts).join(' ').replace(/\s+/g, ' ').trim();
  }

  function joinWithDot(...parts) {
    return asArray(parts).join(' · ');
  }

  function joinWithComma(...parts) {
    return asArray(parts).join(', ');
  }

  function getReportMode(strategyData) {
    const demoValues = [
      strategyData.report_mode,
      strategyData.demo_mode,
      strategyData.full_report?.demo_mode,
      strategyData.scraped_profile?.demo_mode,
      strategyData.step_1_market?.demo_mode,
      strategyData.step_2_tam?.demo_mode,
      strategyData.step_3_icp?.demo_mode,
      strategyData.step_4_sourcing?.demo_mode,
      strategyData.step_5_keywords?.demo_mode,
      strategyData.step_6_messaging?.demo_mode,
      strategyData.step_7_intelligence?.demo_mode,
    ];
    const isDemo = demoValues.some(value => value === 'demo' || value === true || value === 'true');
    return { isDemo, modeLabel: isDemo ? 'DEMO MODE' : 'LIVE MODE' };
  }

  function getGtmScore(market, tam, messaging, intelligence) {
    const candidates = [
      market?.gtm_relevance_score,
      tam?.total_score,
      messaging?.score_breakdown?.total,
      intelligence?.confidence_score,
      intelligence?.confidence,
    ];
    for (const candidate of candidates) {
      const value = normalizeScore(candidate);
      if (value !== null) return value;
    }
    return 0;
  }

  function getVerdict(score, intelligence) {
    const recommendation = safe(intelligence?.go_no_go?.recommendation || intelligence?.recommendation || intelligence?.final_recommendation);
    if (recommendation) {
      const normalized = String(recommendation).trim();
      if (normalized) return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
    if (score >= 75) return 'Go';
    if (score >= 50) return 'Watch';
    return 'No-Go';
  }

  function renderPage(section, page, content) {
    return `<div class="page pdf-page">${renderHeader(section)}<div class="page-content">${content}</div>${renderFooter(section, page)}</div>`;
  }

  function renderHeader(section) {
    return `<div class="header"><div class="header-brand"><div class="logo-mark">ABE</div><div class="brand-copy"><div class="brand-title">ABE Revenue Intelligence</div><div class="brand-subtitle">${esc(section)}</div></div></div><div class="header-badges"><span class="badge ${mode.isDemo ? 'badge-demo' : 'badge-live'}">${esc(mode.modeLabel)}</span><span class="badge badge-confidential">Confidential</span></div></div>`;
  }

  function renderFooter(section, page) {
    return `<div class="footer"><div>${esc(company)} · ${esc(section)} · ${esc(mode.modeLabel)}</div><div>Page ${page}</div></div>`;
  }

  function renderSvgIcon(name) {
    switch (name) {
      case 'score':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.9 6.7 7.1 1-5.1 5 1.2 7.1L12 18.8 6 22.8l1.2-7.1-5.1-5 7.1-1L12 2z"/></svg>`;
      case 'insight':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;
      case 'market':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 18V8"/><path d="M12 18V5"/><path d="M19 18V12"/><path d="M3 18h18"/></svg>`;
      case 'swot-strength':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4v5c0 6-4 8-8 9-4-1-8-3-8-9V7l8-4z"/></svg>`;
      case 'swot-weakness':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4v6c0 6-4 8-8 9-4-1-8-3-8-9V7l8-4z"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/></svg>`;
      case 'swot-opportunity':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19h16"/><path d="M12 5v14"/><path d="M8 11l4-4 4 4"/></svg>`;
      case 'swot-threat':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l7 5v6c0 6-3 8-7 9-4-1-7-3-7-9V7l7-5z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;
      case 'tam':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 18h4v-6H4v6zM10 18h4v-9h-4v9zM16 18h4v-3h-4v3z"/></svg>`;
      case 'persona':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="7" r="4"/><path d="M5 21c2-4 6-6 7-6s5 2 7 6"/></svg>`;
      case 'pipeline':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="19" cy="16" r="2"/><path d="M7 12h3l2-3 2 10h3"/></svg>`;
      case 'funnel':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16l-6 7v5l-4 4V11L4 4z"/></svg>`;
      case 'timeline':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12h5l3-4 3 8 5-4"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="20" cy="16" r="2"/></svg>`;
      case 'decision':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l7 5v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-5z"/><path d="M9 12l2 2 4-4"/></svg>`;
      case 'confidence':
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 11v-4"/><path d="M15 14l-3-3-3 3"/></svg>`;
      default:
        return `<svg class="metric-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/></svg>`;
    }
  }

  function renderMetricCard(title, value, note, iconName) {
    return `<div class="metric-card"><div class="metric-card-head">${renderSvgIcon(iconName || 'score')}<div class="metric-card-title">${esc(title)}</div></div><div class="metric-card-value">${esc(value || '—')}</div><div class="metric-card-note">${esc(note || '')}</div></div>`;
  }

  function renderProgressBar(value, label, max = 100) {
    const score = normalizeScore(value);
    const percentage = score === null ? 0 : Math.round((score / max) * 100);
    const display = score === null ? '—' : `${score}/${max}`;
    return `<div class="progress-bar"><div class="progress-row"><span>${esc(label)}</span><span>${esc(display)}</span></div><div class="progress-track"><div class="progress-fill" style="width:${percentage}%;"></div></div></div>`;
  }

  function renderPills(items, variant = 'accent') {
    return asArray(items).map(item => `<span class="pill pill-${variant}">${esc(item)}</span>`).join('');
  }

  function renderList(items) {
    const array = asArray(items);
    if (!array.length) return '<ul class="list"><li>Not available</li></ul>';
    return `<ul class="list">${array.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
  }

  function renderCoverPage() {
    return renderPage('Cover', 1, `
      <div class="hero-panel" style="padding:32px;">
        <div class="hero-row">
          <div>
            <div class="section-title">GTM Intelligence Report</div>
            <div class="panel-copy">A premium boardroom presentation prepared for ${esc(company)} with strategic market, ICP and revenue intelligence.</div>
            <div class="pill-row" style="margin-top:18px;">${renderPills([mode.modeLabel, 'Confidential'], 'accent')}</div>
          </div>
          <div style="display:grid;gap:14px;align-items:start;">
            <div class="logo-mark" style="width:48px;height:48px;font-size:12px;">ABE</div>
            <div class="badge badge-live">${esc(reportDate)}</div>
          </div>
        </div>
        <div class="kpi-strip" style="margin-top:26px;">
          ${renderMetricCard('GTM Score', gtmScore ? `${gtmScore}/100` : '—', 'Strategic fit', 'score')}
          ${renderMetricCard('TAM', tam, 'Total addressable market', 'tam')}
          ${renderMetricCard('CAGR', cagr, 'Compound annual growth rate', 'market')}
          ${renderMetricCard('Verdict', verdict, 'Boardroom recommendation', 'decision')}
          ${renderMetricCard('Steps complete', `${stepsComplete}/7`, 'Completed GTM phases', 'insight')}
        </div>
        <div class="panel" style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
          <div><div class="panel-strong">${esc(company)}</div><div class="panel-copy">${esc(industry || 'Industry details not supplied.')}</div></div>
          ${mode.isDemo ? '<div class="warning-strip">Demo Mode Report — No live data was used. Validate before decision-making.</div>' : ''}
        </div>
      </div>
    `);
  }

  function renderTruthLayerPage() {
    return renderPage('Truth Layer / Evidence Status', 2, `
      <div class="hero-panel" style="padding:28px;">
        <div class="section-title">Truth Layer</div>
        <div class="panel-copy">A structured evidence status page showing provenance, validation needs, and confidence basis for the report.</div>
        <div class="grid2" style="margin-top:18px;">
          <div class="panel"><div class="section-title">Profile source</div><div class="panel-copy">${esc(profileSource)}</div></div>
          <div class="panel"><div class="section-title">Confidence basis</div><div class="panel-copy">${esc(confidenceBasis)}</div></div>
        </div>
        <div class="grid2" style="margin-top:14px;">
          <div class="panel"><div class="section-title">Missing evidence</div><div class="panel-copy">${esc(missingEvidence)}</div></div>
          <div class="panel"><div class="section-title">Source context</div><div class="panel-copy">${esc(sourceContext)}</div></div>
        </div>
        <div class="warning-strip" style="margin-top:18px;">${esc(evidenceNotice)}</div>
      </div>
    `);
  }

  function renderExecutiveSummaryPage() {
    return renderPage('Executive Summary', 3, `
      <div class="panel">
        <div class="section-title">Executive Summary</div>
        <div class="panel-copy">A concise executive narrative describing the GTM opportunity, recommendation, and confidence for leadership review.</div>
        <div class="hero-panel">
          <div class="panel-strong">${esc(s7.executive_brief || s7.summary || s1.executive_summary || s1.gtm_relevance_reasoning || 'Executive summary content is not available.')}</div>
          <div class="panel-copy">${esc(s7.why_now_analysis || s7.why_now || s1.market_timing?.[0] || 'This summary prioritizes outcome-directed guidance for executive decision-making rather than tactical detail.')}</div>
        </div>
        <div class="grid2">
          <div class="panel"><div class="section-title">Strategic hook</div><div class="panel-copy">${esc(s7.strategic_hook || s7.hook || s1.solution_angle || 'A differentiated revenue intelligence narrative to shape market positioning.')}</div></div>
          <div class="panel"><div class="section-title">Recommended action</div><div class="panel-copy">${esc(s7.recommended_next_action || s7.recommended_action || s1.recommended_action || 'Focus on high-fit account outreach and outcome-oriented messaging.')}</div></div>
        </div>
        ${mode.isDemo ? '<div class="warning-strip">Demo Mode Report — No live data was used. Validate before decision-making.</div>' : ''}
      </div>
      <div class="kpi-strip">
        ${renderMetricCard('Market Fit', gtmScore ? `${gtmScore}/100` : '—', 'Inferred GTM relevance', 'score')}
        ${renderMetricCard('Confidence', confidenceScore ? `${confidenceScore}/100` : '—', 'Signal quality estimate', 'confidence')}
        ${renderMetricCard('TAM', tam, 'Market opportunity', 'tam')}
        ${renderMetricCard('Verdict', verdict, 'Suggested decision', 'decision')}
      </div>
      <div class="panel">${renderProgressBar(confidenceScore, 'Confidence score')}</div>
    `);
  }

  function renderMarketResearchPage() {
    const strengths = s1.swot?.strengths || s1.strengths || [];
    const weaknesses = s1.swot?.weaknesses || s1.weaknesses || [];
    const opportunities = s1.swot?.opportunities || s1.opportunities || [];
    const threats = s1.swot?.threats || s1.threats || [];
    const demandSignals = asArray(s1.demand_signals || s1.demand_signals || s1.demand || s1.signals || []);
    const timingSignals = asArray(s1.market_timing || s1.timing_signals || s1.market_timing || []);
    return renderPage('Market Research', 4, `
      <div class="grid2">
        <div class="panel"><div class="section-title">Company overview</div><div class="panel-copy">${esc(s1.company_overview || s1.market_description || 'Overview content is not available.')}</div></div>
        <div class="grid2" style="gap:12px;">
          <div class="metric-card"><div class="metric-card-head">${renderSvgIcon('market')}<div class="metric-card-title">Stage</div></div><div class="metric-card-value">${esc(s1.revenue_stage || s1.stage || 'Not specified')}</div><div class="metric-card-note">Current market maturity</div></div>
          <div class="metric-card"><div class="metric-card-head">${renderSvgIcon('insight')}<div class="metric-card-title">Position</div></div><div class="metric-card-value">${esc(s1.market_position || s1.position || 'Not specified')}</div><div class="metric-card-note">Market differentiation</div></div>
        </div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="section-title">Demand signals</div><div class="panel-copy">${esc(demandSignals.join(' · ') || 'Demand signal detail is not available.')}</div></div>
        <div class="panel"><div class="section-title">Timing signals</div><div class="panel-copy">${esc(timingSignals.join(' · ') || 'Timing signal detail is not available.')}</div></div>
      </div>
      <div class="swot-grid">
        <div class="swot-card"><div class="swot-card-title">${renderSvgIcon('swot-strength')}Strengths</div>${renderList(strengths)}</div>
        <div class="swot-card"><div class="swot-card-title">${renderSvgIcon('swot-weakness')}Weaknesses</div>${renderList(weaknesses)}</div>
        <div class="swot-card"><div class="swot-card-title">${renderSvgIcon('swot-opportunity')}Opportunities</div>${renderList(opportunities)}</div>
        <div class="swot-card"><div class="swot-card-title">${renderSvgIcon('swot-threat')}Threats</div>${renderList(threats)}</div>
      </div>
      <div class="panel"><div class="section-title">Analyst insight</div><div class="panel-copy">${esc(s1.analyst_insight || s1.insight || 'Analyst insight is not available.')}</div></div>
      <div class="chip-wrap">${renderPills(demandSignals, 'accent')}${renderPills(timingSignals, 'green')}${renderPills(asArray(s1.technology_stack || s1.tech_stack || s1.tech), 'accent')}</div>
    `);
  }

  function renderTAMPage() {
    const segmentDetails = asArray(s2.market_segments || s2.segment_list || s2.target_segments).slice(0,3);
    const segmentCards = segmentDetails.length
      ? segmentDetails.map((item, idx) => {
          const label = typeof item === 'object' ? item.name || item.segment_name || `Segment ${idx + 1}` : `Segment ${idx + 1}`;
          const value = typeof item === 'object'
            ? safe(item.size || item.market_size || item.est_size || item.description || item.summary || item.name || item.segment_name)
            : String(item);
          const note = typeof item === 'object'
            ? safe(item.priority || item.growth || item.rationale || 'Market segment details')
            : 'Market segment snapshot';
          return renderSegmentCard(label, value || 'Not available', note);
        }).join('')
      : `${renderSegmentCard('Primary market segment', safe(s2.primary_segment || s2.market_segment || 'Not available'), 'Core segment definition')}${renderSegmentCard('Secondary market segment', safe(s2.secondary_segment || s2.segment_priority || 'Not available'), 'Segment priority')}${renderSegmentCard('Market insight', safe(s2.segment_insight || s2.market_insight || 'Not available'), 'Key takeaway')}`;
    return renderPage('TAM Mapping', 5, `
      <div class="kpi-strip">
        ${renderMetricCard('TAM', tam, 'Total Addressable Market', 'tam')}
        ${renderMetricCard('SAM', sam || '—', 'Serviceable Available Market', 'market')}
        ${renderMetricCard('SOM', som || '—', 'Serviceable Obtainable Market', 'score')}
        ${renderMetricCard('CAGR', cagr, 'Growth rate estimate', 'insight')}
      </div>
      <div class="waterfall">
        ${renderWaterfallRow('TAM', tam, 92)}
        ${renderWaterfallRow('SAM', sam, 68)}
        ${renderWaterfallRow('SOM', som, 42)}
        ${renderWaterfallRow('CAGR', cagr, 30)}
      </div>
      <div class="panel"><div class="section-title">Market sizing formula</div><div class="panel-copy">Global TAM × eligible geography × service-line fit × win-rate assumptions = SOM. Validate definitions before external presentations.</div></div>
      <div class="segment-grid">
        ${segmentCards}
      </div>
    `);
  }

  function renderICPPage() {
    const primaryICP = safe(s3.primary_icp || s3.primary_profile || s3.primary_persona) || 'Not available';
    const secondaryICP = safe(s3.secondary_icp || s3.secondary_profile || s3.secondary_persona) || 'Not available';
    const triggers = asArray(s3.buying_triggers || s3.decision_triggers || s3.key_triggers);
    const pain = safe(s3.core_pain_points || s3.pain_points || s3.primary_pain) || 'Not available';
    const impact = safe(s3.business_impact || s3.pain_impact || 'Not available');
    const intervention = safe(s3.recommended_intervention || s3.solution || 'Not available');
    const decisionMakers = asArray(s3.decision_makers || s3.decision_maker || s3.stakeholders);
    const objections = asArray(s3.objections || s3.key_objections || s3.risks);
    return renderPage('ICP Modeling', 6, `
      <div class="persona-block">
        <div class="persona-card"><div class="persona-title">Primary ICP</div><div class="persona-detail">${esc(primaryICP)}</div></div>
        <div class="persona-card"><div class="persona-title">Secondary ICP</div><div class="persona-detail">${esc(secondaryICP)}</div></div>
      </div>
      <div class="panel"><div class="section-title">Firmographics</div><div class="panel-copy">${esc(s3.firmographics || s3.company_profile || 'Firmographic detail is not available.')}</div></div>
      <div class="grid2">
        <div class="panel"><div class="section-title">Decision makers</div><div class="panel-copy">${esc(decisionMakers.join(' · ') || 'Not available')}</div></div>
        <div class="panel"><div class="section-title">Buying triggers</div><div class="panel-copy">${esc(triggers.join(' · ') || 'Not available')}</div></div>
      </div>
      <div class="segment-grid">
        ${renderSegmentCard('Pain', pain)}
        ${renderSegmentCard('Impact', impact)}
        ${renderSegmentCard('Intervention', intervention)}
        ${renderSegmentCard('Objections', objections.join(', ') || 'Not available')}
      </div>
    `);
  }

  function renderSourcingPage() {
    const accountAnalogs = asArray(s4.account_analogs || s4.high_fit_account_analogs || s4.account_analogs || []);
    return renderPage('Account Sourcing', 7, `
      <div class="panel"><div class="section-title">Target roles</div><div class="panel-copy">${esc(asArray(s4.target_roles || s4.target_role || s4.target_title).join(' · ') || 'Not available')}</div></div>
      <div class="grid2">
        <div class="panel"><div class="section-title">Sourcing filters</div><div class="panel-copy">${esc(s4.filter_criteria || s4.target_filters || s4.sourcing_filters || 'Not available')}</div></div>
        <div class="panel"><div class="section-title">Exclusion criteria</div><div class="panel-copy">${esc(s4.exclusion_criteria || s4.exclude || s4.exclusions || 'Not available')}</div></div>
      </div>
      <div class="hero-panel" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;">
        ${renderPipelineStep('Recommended DBs', safe(s4.recommended_databases || s4.data_source || s4.databases || 'Not available'))}
        ${renderPipelineStep('Estimated deal size', safe(s4.estimated_deal_size?.range || s4.estimated_deal_size || s4.deal_size || 'Not available'))}
        ${renderPipelineStep('Sales approach', safe(s4.sales_approach || s4.sales_strategy || 'Not available'))}
        ${renderPipelineStep('Account analogs', safe(accountAnalogs.join(', ') || 'Not available'))}
      </div>
      <div class="panel"><div class="section-title">Sourcing playbook</div><div class="panel-copy">${esc(s4.sourcing_playbook || s4.account_strategy || 'No sourcing playbook was supplied.')}</div></div>
    `);
  }

  function renderKeywordsPage() {
    const problem = asArray(s5.primary_keywords || s5.problem_keywords || []);
    const solution = asArray(s5.secondary_keywords || s5.solution_keywords || []);
    const intent = asArray(s5.intent_signals || s5.high_intent_keywords || s5.intent_signals || []);
    const booleanQuery = safe(s5.boolean_query || s5.search_query || 'Not available');
    const linkedinQuery = safe(s5.linkedin_search_strings || s5.linkedin_query || s5.linkedin_search_string || 'Not available');
    const contentTopics = asArray(s5.content_topics || s5.topics || []);
    return renderPage('Keywords & Intent', 8, `
      <div class="hero-panel" style="grid-template-columns:1fr 1fr 1fr;gap:14px;">
        ${renderFunnelStep('Problem-aware', problem.join(', ') || 'Not available')}
        ${renderFunnelStep('Solution-aware', solution.join(', ') || 'Not available')}
        ${renderFunnelStep('High-intent', intent.join(', ') || 'Not available')}
      </div>
      <div class="panel"><div class="section-title">Keyword clusters</div><div class="chip-wrap">${renderPills(problem.concat(solution).concat(intent), 'accent')}</div></div>
      <div class="grid2">
        <div class="panel"><div class="section-title">Intent signals</div><div class="panel-copy">${esc(intent.join(' · ') || 'Not available')}</div></div>
        <div class="panel"><div class="section-title">Content topics</div><div class="panel-copy">${esc(contentTopics.join(' · ') || 'Not available')}</div></div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="section-title">Boolean search</div><div class="panel-copy">${esc(booleanQuery)}</div></div>
        <div class="panel"><div class="section-title">LinkedIn query</div><div class="panel-copy">${esc(linkedinQuery)}</div></div>
      </div>
    `);
  }

  function renderSDRPage() {
    const activities = [
      { label: 'Email 1', data: s6.email_1 || {}, defaultAngle: 'Problem introduction' },
      { label: 'Email 2', data: s6.email_2 || {}, defaultAngle: 'Value reinforcement' },
      { label: 'Email 3', data: s6.email_3 || {}, defaultAngle: 'Decision urgency' },
      { label: 'LinkedIn', data: { angle: 'Social touch', body: s6.linkedin_message }, defaultAngle: 'Professional engagement' },
      { label: 'Follow-up', data: { angle: 'Persistence', body: s6.linkedin_follow_up }, defaultAngle: 'Next-step prompt' },
    ];
    return renderPage('SDR / Outreach Sequence', 9, `
      <div class="timeline">
        ${activities.map((item, index) => renderTimelineStep(index + 1, item.label, item.data, item.defaultAngle)).join('')}
      </div>
      <div class="panel"><div class="section-title">Sequence overview</div><div class="panel-copy">${esc(s6.follow_up_sequence || s6.sequence_summary || 'Follow-up instructions are not available.')}</div></div>
    `);
  }

  function renderRevenueIntelPage() {
    const buyingSignals = asArray(s7.buying_signals || s7.signals || s7.signal_summary || []);
    const riskConstraint = safe(s7.risk_constraint || s7.constraint || s7.risk || 'Requires live customer validation and a stronger evidence base before scaling.');
    return renderPage('Revenue Intelligence', 10, `
      <div class="grid2">
        <div class="panel"><div class="section-title">Decision verdict</div><div class="badge-block ${verdict.toLowerCase().includes('go') ? 'badge-go' : verdict.toLowerCase().includes('watch') ? 'badge-watch' : 'badge-nogo'}">${esc(verdict)}</div></div>
        <div class="panel">${renderProgressBar(confidenceScore, 'Confidence')}</div>
      </div>
      <div class="panel"><div class="section-title">Executive brief</div><div class="panel-copy">${esc(s7.executive_brief || s7.summary || 'Executive briefing detail is not available.')}</div></div>
      <div class="grid2">
        <div class="panel"><div class="section-title">Why now</div><div class="panel-copy">${esc(s7.why_now_analysis || s7.why_now || 'Timing rationale is not available.')}</div></div>
        <div class="panel"><div class="section-title">Strategic hook</div><div class="panel-copy">${esc(s7.strategic_hook || s7.hook || 'Strategic value proposition not available.')}</div></div>
      </div>
      <div class="panel"><div class="section-title">Buying signals</div><div class="panel-copy">${esc(buyingSignals.join(' · ') || 'No buying signals were supplied.')}</div></div>
      <div class="mcc-grid">
        ${renderMccCard('Market', safe(s7.mcc_view?.market || s2.market_maturity || 'Market context not available'))}
        ${renderMccCard('Client', safe(s7.mcc_view?.client || s3.primary_icp || 'Client persona not available'))}
        ${renderMccCard('Competitor', safe(s7.mcc_view?.competitor || 'Competitive pressure not available'))}
      </div>
      <div class="risk-strip">
        ${renderRiskItem('Risk constraint', riskConstraint)}
        ${renderRiskItem('Execution priority', safe(s7.execution_priority || 'Medium — validate hypothesis before scaling execution.'))}
      </div>
    `);
  }

  function renderConfidencePage() {
    const matrix = [
      { label: 'Signal Veracity', value: normalizeScore(s7.signal_veracity_score || s7.signal_veracity || confidenceScore * 0.9) },
      { label: 'Market Timing', value: normalizeScore(s7.market_timing_score || s7.market_timing || confidenceScore * 0.8) },
      { label: 'ICP Fit', value: normalizeScore(s7.icp_fit_score || s7.icp_fit || confidenceScore * 0.85) },
      { label: 'Data Completeness', value: normalizeScore(s7.data_quality_score || s7.data_completeness || confidenceScore * 0.75) },
    ];
    const interpretation = confidenceScore >= 75
      ? 'Signals are strong and the GTM narrative is ready for executive review.'
      : confidenceScore >= 50
        ? 'Moderate confidence; validate account targets and message fit before scaling execution.'
        : 'Low confidence; confirm ICP alignment and data quality before active pursuit.';
    return renderPage('Confidence Matrix', 11, `
      <div class="panel"><div class="section-title">Weighted Confidence Matrix</div><div class="panel-copy">Visual assessment of signal veracity, timing, ICP fit and data completeness.</div></div>
      <div class="confidence-grid">
        <div>${matrix.map(item => renderProgressBar(item.value, item.label, 100)).join('')}</div>
        <div class="confidence-summary"><h3>Confidence interpretation</h3>${renderProgressBar(confidenceScore, 'Overall fidelity', 100)}<div class="panel-copy">${esc(interpretation)}</div></div>
      </div>
    `);
  }

  function renderAppendixPage() {
    return renderPage('Appendix', 12, `
      <div class="appendix-grid">
        <div class="appendix-card"><div class="appendix-label">Methodology</div><div class="appendix-copy">Company profile data, market analysis, AI inference and signal extraction are combined to shape the GTM narrative and assumptions.</div></div>
        <div class="appendix-card"><div class="appendix-label">Assumptions</div><div class="appendix-copy">Geography, service-line fit, win-rate and TAM/SAM/SOM defaults are used conservatively when company-specific inputs are incomplete.</div></div>
      </div>
      <div class="appendix-grid" style="margin-top:16px;">
        <div class="appendix-card"><div class="appendix-label">AI-estimated fields</div><div class="appendix-copy">TAM sizing, ICP derivations, account analogs, buying triggers and outreach sequencing may require independent validation.</div></div>
        <div class="appendix-card"><div class="appendix-label">Report metadata</div><div class="appendix-copy">${esc(joinWithDot(`Subject: ${company}`, industry ? `Industry: ${industry}` : '', `Generated: ${reportDate}`, `GTM Score: ${gtmScore}/100`, `Confidence: ${confidenceScore}/100`))}</div></div>
      </div>
    `);
  }

  function renderWaterfallRow(label, value, width) {
    return `<div class="waterfall-row"><div><div class="waterfall-label">${esc(label)}</div><div class="waterfall-value">${esc(value || '—')}</div></div><div style="display:flex;align-items:center;gap:10px;"><div class="waterfall-bar" style="position:relative;"><div class="waterfall-fill" style="width:${width}%;"></div><span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:9px;font-weight:700;color:var(--white);">${esc(width + '%')}</span></div></div></div>`;
  }

  function renderSegmentCard(title, value, note = '', iconName = 'segment') {
    const valueClass = typeof value === 'string' && value.length > 100 ? ' break-anywhere' : '';
    return `<div class="segment-card"><div class="segment-card-header">${renderSvgIcon(iconName)}<div class="segment-label">${esc(title)}</div></div><div class="segment-value${valueClass}">${esc(value)}</div>${note ? `<div class="metric-card-note">${esc(note)}</div>` : ''}</div>`;
  }

  function renderPipelineStep(title, value) {
    const valueClass = typeof value === 'string' && value.length > 100 ? ' break-anywhere' : '';
    return `<div class="segment-card"><div class="segment-card-header">${renderSvgIcon('pipeline')}<div class="segment-label">${esc(title)}</div></div><div class="segment-value${valueClass}">${esc(value)}</div></div>`;
  }

  function renderAccountCard(account, index) {
    const placeholders = ['High-fit enterprise prospect', 'Strategic market account', 'Growth-ready target account'];
    if (!account) {
      const demoLabel = placeholders[index - 1] || `Demo account ${index}`;
      return `<div class="segment-card"><div class="segment-card-header">${renderSvgIcon('pipeline')}<div class="segment-label">Account analog ${index}</div></div><div class="segment-value">${esc(mode.isDemo ? `${demoLabel} — demo / anonymized target account.` : 'Account analog not supplied.')}</div>${mode.isDemo ? `<div class="metric-card-note">Demo account placeholders are illustrative only; replace with real targets for live campaigns.</div>` : ''}</div>`;
    }
    const fit = normalizeScore(account.fit_score || account.fit || account.score) || 0;
    return `<div class="segment-card"><div class="segment-card-header">${renderSvgIcon('pipeline')}<div class="segment-label">${esc(account.account_name || `Target account ${index}`)}</div></div><div class="segment-value">${esc(account.actionable_trigger || account.trigger || 'Account insight not available.')}</div><div style="margin-top:14px;">${renderProgressBar(fit, 'Fit score')}</div></div>`;
  }

  function renderFunnelStep(label, value) {
    const valueClass = typeof value === 'string' && value.length > 100 ? ' break-anywhere' : '';
    return `<div class="segment-card"><div class="segment-card-header">${renderSvgIcon('funnel')}<div class="segment-label">${esc(label)}</div></div><div class="segment-value${valueClass}">${esc(value)}</div></div>`;
  }

  function renderTimelineStep(step, label, data, fallbackAngle) {
    const angle = safe(data.angle || fallbackAngle);
    const subject = safe(data.subject);
    const body = safe(data.body || data.message || data.copy);
    const cta = safe(data.cta || data.call_to_action || 'Next step');
    return `<div class="timeline-step"><div class="timeline-step-heading"><span>${esc(step)} • ${esc(label)}</span><span>${esc(angle)}</span></div>${subject ? `<div class="timeline-step-meta"><strong>Subject:</strong> ${esc(subject)}</div>` : ''}${body ? `<div class="timeline-step-meta">${esc(body)}</div>` : ''}${cta ? `<div class="timeline-step-meta"><strong>CTA:</strong> ${esc(cta)}</div>` : ''}</div>`;
  }

  function renderMccCard(label, value) {
    return `<div class="mcc-card"><div class="mcc-label">${esc(label)}</div><div class="mcc-value">${esc(value)}</div></div>`;
  }

  function renderRiskItem(label, text) {
    return `<div class="risk-item"><div class="risk-label">${esc(label)}</div><div class="risk-copy">${esc(text)}</div></div>`;
  }
}
