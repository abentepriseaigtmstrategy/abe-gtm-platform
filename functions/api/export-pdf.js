/**
 * /api/export-pdf  (v5 — Tier-1 Enterprise A4 Report)
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
  try { body = await request.json(); } catch { return errRes('Invalid request body', 400, cors); }
  const errors = validate({ strategy: 'required' }, body);
  if (errors.length) return errRes(errors[0], 400, cors);
  const { strategy } = body;
  if (!strategy.company_name) return errRes('Missing strategy.company_name', 400, cors);

  // ── QuickChart env config ──
  const QC = {
    enabled: (env?.QUICKCHART_ENABLED ?? 'true') !== 'false',
    apiKey:  env?.QUICKCHART_API_KEY || '',
    timeout: parseInt(env?.QUICKCHART_TIMEOUT_MS) || 5000,
    maxPer:  parseInt(env?.QUICKCHART_MAX_PER_REPORT) || 5,
  };

  // ── Detect demo vs live mode ──
  const isDemoMode = !!(
    strategy.demo_mode || strategy.report_mode === 'demo' ||
    strategy._profile_source === 'demo_mode_simulated' ||
    strategy.step_7_intelligence?.demo_mode ||
    (strategy.step_1_market?.analyst_insight||'').toLowerCase().includes('demo mode')
  );

  // ── Pre-fetch QuickChart images ──
  const charts = { gauge: null, waterfall: null, confidence: null, intent: null, risk: null };
  if (QC.enabled) {
    const s2 = strategy.step_2_tam || {};
    const s7 = strategy.step_7_intelligence || {};
    const s1 = strategy.step_1_market || {};
    const gtmScore = parseInt(
      s1.gtm_relevance_score ||
      s7.score_breakdown?.total ||
      s7.gtm_score ||
      strategy.gtm_score
    ) || (isDemoMode ? 60 : 0);
    const verdict = s7.go_no_go?.recommendation ||
      s7.verdict || strategy.verdict ||
      (gtmScore>=75?'Go':gtmScore>=50?'Watch':'No-Go') ||
      (isDemoMode ? 'Watch' : 'Watch');
    const confScore = parseInt(
      s7.confidence_score || s7.overall_fidelity || s7._data_quality?.confidence_after_cap
    ) || gtmScore || (isDemoMode ? 60 : 0);

    const tamRaw = safe_val(s2.tam_size_estimate); const tamNum = parseMoneyValue(tamRaw, isDemoMode ? 1800 : 0);
    const samRaw = safe_val(s2.sam_estimate || s2.waterfall?.sam_value);
    const somRaw = safe_val(s2.waterfall?.som_value || '5-10% of TAM');
    const samNum = samRaw && samRaw !== '—' ? parseMoneyValue(samRaw, tamNum * 0.4) : tamNum * 0.4;
    const somNum = parseMoneyValue(somRaw, tamNum * 0.07);

    // ── Live-mode confidence sub-field extraction ──
    const liveVeracity     = safeNumber(s7.signal_veracity     || s7.confidence_breakdown?.signal_veracity,     0);
    const liveTiming       = safeNumber(s7.market_timing       || s7.confidence_breakdown?.market_timing,       0);
    const liveIcpFit       = safeNumber(s7.icp_fit             || s7.confidence_breakdown?.icp_fit,             0);
    const liveCompleteness = safeNumber(s7.data_completeness   || s7.confidence_breakdown?.data_completeness,   0);
    // If live sub-fields exist use them; else derive from confScore weights
    const hasLiveSubs = liveVeracity > 0 || liveTiming > 0 || liveIcpFit > 0 || liveCompleteness > 0;
    const matrixVeracity     = hasLiveSubs ? liveVeracity     : Math.round(confScore * 0.4);
    const matrixTiming       = hasLiveSubs ? liveTiming       : Math.round(confScore * 0.25);
    const matrixIcpFit       = hasLiveSubs ? liveIcpFit       : Math.round(confScore * 0.2);
    const matrixCompleteness = hasLiveSubs ? liveCompleteness : Math.round(confScore * 0.15);

    // ── KV Chart Caching (DEFERRED — add env.KV when available) ──
  // When env.KV is present, wrap fetchQuickChartBase64 with:
  //   const cacheKey = `chart:gauge:${gtmScore}:${verdict}`;        TTL demo=604800 live=86400
  //   const cacheKey = `chart:waterfall:${tamNum}:${samNum}:${somNum}`;
  //   const cacheKey = `chart:confidence:${matrixVeracity}:${matrixTiming}:${matrixIcpFit}:${matrixCompleteness}`;
  //   const cached = await env.KV.get(cacheKey);
  //   if (cached) return cached;
  //   const b64 = await fetchQuickChartBase64(...);
  //   await env.KV.put(cacheKey, b64, { expirationTtl: isDemoMode ? 604800 : 86400 });
  //   return b64;

  let chartCount = 0;
  const tryFetch = async (type, config, w, h) => {
    if (chartCount >= QC.maxPer) {
      console.warn(`[QuickChart] max calls (${QC.maxPer}) reached — fallback for ${type}`);
      return null;
    }
    chartCount++;
    try {
      return await fetchQuickChartBase64(config, w, h, QC, type);
    } catch(err) {
      console.warn(`[QuickChart] ${type} fallback triggered:`, err.message);
      return null;
    }
  };

    const [g, wf, cm] = await Promise.allSettled([
      tryFetch('gauge',      buildGtmGaugeChartConfig(gtmScore, verdict), 320, 200),
      tryFetch('waterfall',  buildTamWaterfallChartConfig(tamNum, samNum, somNum), 760, 280),
      tryFetch('confidence', buildConfidenceMatrixChartConfig({
        veracity: matrixVeracity, timing: matrixTiming,
        icpFit: matrixIcpFit, completeness: matrixCompleteness,
        overall: confScore
      }), 760, 300),
    ]);
    charts.gauge      = g.status==='fulfilled'  ? g.value  : null;
    charts.waterfall  = wf.status==='fulfilled' ? wf.value : null;
    charts.confidence = cm.status==='fulfilled' ? cm.value : null;

    // ── Optional mini charts (max 2 additional calls) ──
    const intentSignals = arr(s5?.intent_signals||s5?.intent_topics||[]);
    const intentItems = intentSignals.slice(0,4).map((s,i)=>({
      label: typeof s==='string'?s:(s.signal||s.label||`Signal ${i+1}`),
      strength: typeof s==='object'&&s.strength ? s.strength : [72,58,65,50][i]||60
    }));
    const [intent, risk] = await Promise.allSettled([
      tryFetch('intent', buildIntentSignalChartConfig(intentItems), 480, 180),
      tryFetch('risk',   buildRiskSeverityChartConfig(verdict, gtmScore), 480, 180),
    ]);
    charts.intent = intent.status==='fulfilled' ? intent.value : null;
    charts.risk   = risk.status==='fulfilled'   ? risk.value   : null;
    console.info(`[QuickChart] total calls=${chartCount}/${QC.maxPer} gauge=${!!charts.gauge} waterfall=${!!charts.waterfall} confidence=${!!charts.confidence} intent=${!!charts.intent} risk=${!!charts.risk}`);
  }

  const filename = `GTM_${strategy.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  const html = buildReportHTML(strategy, charts, isDemoMode);
  return new Response(JSON.stringify({ html, filename, mode: 'html2pdf' }), {
    status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}

// ══════════════════════════════════════════════════════════════
// QUICKCHART HELPERS
// ══════════════════════════════════════════════════════════════

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? fallback : n;
}

function renderChartOrFallback(type, base64, fallbackHtml, dimensions = { width: 480, height: 180 }) {
  if (base64) {
    return `<div style="margin:3mm 0;line-height:0">
      <img src="data:image/png;base64,${base64}"
        width="${dimensions.width}" height="${dimensions.height}"
        style="width:100%;max-height:${dimensions.height}px;object-fit:contain;border-radius:8px"
        alt="${type} chart"/>
    </div>`;
  }
  return fallbackHtml;
}

function normalizeCompanyName(name) {
  if (!name) return 'Company';
  let n = String(name).trim();
  // Remove leading/trailing dots and punctuation
  n = n.replace(/^[\.\s]+|[\.\s]+$/g, '');
  // Capitalize first letter if all lowercase
  if (n === n.toLowerCase()) n = n.charAt(0).toUpperCase() + n.slice(1);
  return n || 'Company';
}

function safe_val(v) {
  if (!v && v !== 0) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return Object.values(v).join(', ');
  return String(v);
}

function parseMoneyValue(str, fallback = 0) {
  if (!str) return fallback;
  const s = String(str).replace(/,/g,'').toUpperCase();
  const m = s.match(/([\d.]+)\s*(B|M|K)?/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = m[2] || '';
  if (unit === 'B') return n * 1000;
  if (unit === 'M') return n;
  if (unit === 'K') return n / 1000;
  return n > 1000 ? n / 1e6 : n; // treat large raw numbers as millions
}

function buildGtmGaugeChartConfig(score, verdict) {
  const pct = Math.max(0, Math.min(100, parseInt(score) || 0));
  const color = /^go$/i.test(verdict) ? '#22c55e' : /no/i.test(verdict) ? '#ef4444' : '#f59e0b';
  const verLabel = /^go$/i.test(verdict) ? 'GO' : /no/i.test(verdict) ? 'NO-GO' : 'WATCH';
  return {
    type: 'doughnut',
    data: {
      labels: ['Score', 'Remaining'],
      datasets: [
        {
          data: [100],
          backgroundColor: ['rgba(255,255,255,0.04)'],
          borderWidth: 0, circumference: 220, rotation: 250, cutout: '82%', radius: '100%',
        },
        {
          data: [pct, 100 - pct],
          backgroundColor: [color, 'rgba(255,255,255,0.06)'],
          borderWidth: 0, circumference: 220, rotation: 250, cutout: '70%', radius: '88%',
        },
      ],
    },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false,
      layout: { padding: 10 },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        doughnutlabel: {
          labels: [
            { text: String(pct), font: { size: 36, weight: '900', family: 'monospace' }, color: '#ffffff' },
            { text: verLabel, font: { size: 13, weight: '800', family: 'Inter, sans-serif' }, color: color },
            { text: 'GTM SCORE', font: { size: 8, weight: '600', family: 'Inter, sans-serif' }, color: '#9CA3AF' },
          ],
        },
      },
    },
  };
}

function buildTamWaterfallChartConfig(tamM, samM, somM) {
  const safeNum = v => (Number.isFinite(v) && v > 0) ? v : 0;
  const values = [safeNum(tamM), safeNum(samM), safeNum(somM)];
  const maxVal = Math.max(100, ...values) * 1.22;
  const fmt = v => { const n = Number(v)||0; if(n>=1000) return '$'+(n/1000).toFixed(1)+'B'; if(n>0) return '$'+Math.round(n)+'M'; return '$0'; };
  const somPct = values[0]>0 ? Math.round((values[2]/values[0])*100) : 0;
  return {
    type: 'bar',
    data: {
      labels: ['Total Addressable\nMarket (TAM)', 'Serviceable\nAvailable (SAM)', 'Serviceable\nObtainable (SOM)'],
      datasets: [{
        label: '',
        data: values,
        backgroundColor: ['#6366f1', '#8b5cf6', '#f59e0b'],
        borderRadius: 10, borderSkipped: false, barThickness: 30, maxBarThickness: 38,
      }]
    },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false,
      indexAxis: 'y',
      layout: { padding: { right: 30, left: 10, top: 16, bottom: 16 } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        datalabels: {
          display: true,
          color: '#ffffff',
          font: { size: 11, weight: '700', family: 'monospace' },
          anchor: 'end', align: 'right', offset: 4,
          formatter: v => v > 0 ? fmt(v) : '',
        },
        annotation: {
          annotations: {
            captureZone: {
              type: 'line',
              xMin: values[2] > 0 ? values[2] : values[0] * 0.07,
              xMax: values[2] > 0 ? values[2] : values[0] * 0.07,
              borderColor: 'rgba(245,158,11,0.5)',
              borderWidth: 1.5,
              borderDash: [4, 3],
              label: {
                enabled: true,
                content: somPct > 0 ? `Capture Zone ~${somPct}%` : 'Capture Zone',
                position: 'start',
                backgroundColor: 'rgba(245,158,11,0.12)',
                color: '#f59e0b',
                font: { size: 9, weight: '600' },
                padding: { x: 4, y: 2 },
                xAdjust: 0, yAdjust: -16,
              },
            },
            aiNote: {
              type: 'label',
              xValue: maxVal * 0.01,
              yValue: 2.48,
              content: ['AI-estimated · validate with analyst data'],
              color: 'rgba(156,163,175,0.7)',
              font: { size: 8, style: 'italic' },
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true, min: 0, max: Math.round(maxVal),
          ticks: { color: '#9CA3AF', font: { size: 9 }, callback: v => fmt(v) },
          grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
        },
        y: {
          ticks: {
            color: '#E5E7EB', font: { size: 10, weight: '700' },
            autoSkip: false, maxRotation: 0, minRotation: 0,
          },
          grid: { display: false },
        }
      },
    }
  };
}

function buildConfidenceMatrixChartConfig({ veracity, timing, icpFit, completeness, overall }) {
  const safe = v => { const n=Number(v); return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):0; };
  const toPercent = (sc, max) => safe(Math.round((sc/max)*100));
  const values = [
    toPercent(veracity, 40),
    toPercent(timing, 25),
    toPercent(icpFit, 20),
    toPercent(completeness, 15),
    safe(overall),
  ];
  const overallColor = values[4] >= 75 ? '#22c55e' : values[4] >= 50 ? '#f59e0b' : '#ef4444';
  const bgColors = ['#7c3aed','#8b5cf6','#6366f1','#a78bfa', overallColor];
  return {
    type: 'bar',
    data: {
      labels: ['Signal Veracity (40%)', 'Market Timing (25%)', 'ICP Fit (20%)', 'Data Completeness (15%)', 'Overall Fidelity'],
      datasets: [{
        label: '',
        data: values,
        backgroundColor: bgColors,
        borderRadius: 8, borderSkipped: false, barThickness: 20, maxBarThickness: 26,
      }]
    },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false,
      indexAxis: 'y',
      layout: { padding: { right: 30, left: 10, top: 14, bottom: 14 } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        datalabels: {
          display: true,
          color: ctx => ctx.dataIndex === 4 ? '#ffffff' : 'rgba(255,255,255,0.85)',
          font: ctx => ({ size: ctx.dataIndex === 4 ? 12 : 10, weight: '700', family: 'monospace' }),
          anchor: 'end', align: 'right', offset: 4,
          formatter: (v, ctx) => {
            if (ctx.dataIndex === 4) return v + '/100';
            return v + '%';
          },
        },
        annotation: {
          annotations: {
            weakLine: {
              type: 'line',
              xMin: 50, xMax: 50,
              borderColor: 'rgba(245,158,11,0.35)', borderWidth: 1.5, borderDash: [3,3],
              label: {
                enabled: true, content: 'Validate', position: 'start',
                backgroundColor: 'rgba(245,158,11,0.08)', color: '#f59e0b',
                font: { size: 8, weight: '600' }, padding: { x:4, y:2 }, yAdjust: -14,
              },
            },
            strongLine: {
              type: 'line',
              xMin: 75, xMax: 75,
              borderColor: 'rgba(34,197,94,0.30)', borderWidth: 1.5, borderDash: [3,3],
              label: {
                enabled: true, content: 'Strong', position: 'start',
                backgroundColor: 'rgba(34,197,94,0.08)', color: '#22c55e',
                font: { size: 8, weight: '600' }, padding: { x:4, y:2 }, yAdjust: -14,
              },
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true, min: 0, max: 110,
          ticks: { color: '#9CA3AF', font: { size: 9 }, callback: v => v <= 100 ? v+'%' : '' },
          grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
        },
        y: {
          ticks: { color: '#E5E7EB', font: { size: 9, weight: '600' }, autoSkip: false, maxRotation: 0 },
          grid: { display: false },
        }
      },
    }
  };
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

async function fetchQuickChartBase64(config, width, height, qc, chartType = 'default') {
  const versionMap = { gauge:['4','3'], waterfall:['3','4'], confidence:['4','3'], intent:['4','3'], risk:['4','3'] };
  const versions = versionMap[chartType] || ['4','3'];
  const configStr = JSON.stringify(config);
  const hasDatalabels = configStr.includes('datalabels');
  const hasAnnotation = configStr.includes('annotation');
  const hasDoughnutlabel = configStr.includes('doughnutlabel');
  console.info(`[QuickChart] type=${chartType} w=${width} h=${height} datalabels=${hasDatalabels} annotation=${hasAnnotation} doughnutlabel=${hasDoughnutlabel}`);
  let lastError = null;
  for (const version of versions) {
    const payload = JSON.stringify({
      chart: config, width, height,
      backgroundColor: '#0B0F1A', format: 'png', version,
      ...(qc.apiKey ? { key: qc.apiKey } : {})
    });
    try {
      const res = await withTimeout(
        fetch('https://quickchart.io/chart', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
        }),
        qc.timeout
      );
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`QuickChart HTTP ${res.status}: ${errBody.slice(0,80)}`);
      }
      const buf = await res.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      if (!b64 || b64.length < 200) throw new Error('QuickChart returned empty image');
      console.info(`[QuickChart] ${chartType} v${version} success (${b64.length} chars)`);
      return b64;
    } catch (err) {
      lastError = err;
      console.warn(`[QuickChart] ${chartType} v${version} failed:`, err.message);
    }
  }
  console.warn(`[QuickChart] ${chartType} all versions failed — using fallback`);
  throw lastError || new Error('QuickChart failed');
}

// ── Fallback renderers ──
function renderGaugeFallback(score, verdict) {
  const color = /^go$/i.test(verdict)?'var(--green)':/no/i.test(verdict)?'var(--red)':'var(--amber)';
  const circ = 157, filled = Math.round((score/100)*circ);
  return `<svg width="130" height="80" viewBox="0 0 130 80" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="gaugeGrad2" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="${color}"/></linearGradient></defs>
    <path d="M 15 72 A 50 50 0 0 1 115 72" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8" stroke-linecap="round"/>
    <path d="M 15 72 A 50 50 0 0 1 115 72" fill="none" stroke="url(#gaugeGrad2)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${filled} ${circ}"/>
    <text x="65" y="65" text-anchor="middle" font-family="monospace" font-size="22" font-weight="900" fill="white">${score}</text>
    <text x="65" y="78" text-anchor="middle" font-family="sans-serif" font-size="7" fill="#6B7280" letter-spacing="1.5">GTM SCORE</text>
  </svg>`;
}

function renderWaterfallFallback(tamV, samV, somV) {
  const bar = (label,val,w,cls) => `<div style="display:flex;align-items:center;margin-bottom:3mm">
    <div style="width:100px;font-family:monospace;font-size:10px;text-align:right;padding-right:3mm;color:white;font-weight:700">${val}</div>
    <div style="flex:1;background:rgba(255,255,255,.08);border-radius:6px;height:14px;overflow:hidden">
      <div style="height:100%;border-radius:6px;width:${w}" class="${cls}"></div>
    </div>
    <span style="margin-left:2mm;font-size:9px;color:#6B7280">${label}</span>
  </div>`;
  return `<div style="margin:3mm 0">
    ${bar('TAM',tamV,'80%','wfb')}${bar('SAM',samV,'50%','wfa')}${bar('SOM',somV,'20%','wfm')}
  </div>`;
}

function renderConfidenceFallback(v, t, f, c, overall) {
  const cmBar = (label, sc, max) => `<div style="margin-bottom:3.5mm">
    <div style="display:flex;justify-content:space-between;margin-bottom:1.5mm">
      <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#6B7280">${label}</span>
      <span style="font-family:monospace;font-size:11px;font-weight:900;color:#a855f7">${sc}<span style="font-size:8px;font-weight:400;color:#6B7280">/${max}</span></span>
    </div>
    <div style="background:rgba(255,255,255,.07);border-radius:5px;height:9px;overflow:hidden">
      <div style="height:100%;border-radius:5px;background:linear-gradient(90deg,#7c3aed,#a855f7);width:${Math.round((sc/max)*100)}%;min-width:3px"></div>
    </div>
  </div>`;
  return cmBar('Signal Veracity (40%)',v,40)+cmBar('Market Timing (25%)',t,25)+cmBar('ICP Fit (20%)',f,20)+cmBar('Data Completeness (15%)',c,15)+
    `<div style="border-top:1px solid rgba(168,85,247,.2);margin:3mm 0"></div>`+
    `<div style="margin-bottom:2mm"><div style="display:flex;justify-content:space-between;margin-bottom:1.5mm"><span style="font-size:10px;font-weight:900;color:white">Overall Fidelity</span><span style="font-family:monospace;font-size:14px;font-weight:900;color:white">${overall}<span style="font-size:8px;font-weight:400;color:#6B7280">/100</span></span></div><div style="background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.2);border-radius:6px;height:13px;overflow:hidden"><div style="height:100%;border-radius:6px;background:linear-gradient(90deg,#5b21b6,#7c3aed,#a855f7,#c084fc);width:${overall}%;min-width:3px"></div></div></div>`;
}

// ══════════════════════════════════════════════════════════════
// OPTIONAL MINI CHART CONFIGS (max 2 extra calls per report)
// ══════════════════════════════════════════════════════════════

function buildIntentSignalChartConfig(signals) {
  // signals: array of { label, strength (0-100) }
  const defaults = [
    { label: 'High buyer research', strength: 72 },
    { label: 'Decision-maker outreach', strength: 58 },
    { label: 'Funnel velocity', strength: 65 },
  ];
  const items = (Array.isArray(signals) && signals.length >= 2) ? signals.slice(0,4) : defaults;
  const labels = items.map(s => typeof s === 'string' ? s : (s.label || String(s)));
  const values = items.map(s => typeof s === 'object' && s.strength ? s.strength : 65);
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map(v => v >= 70 ? '#22c55e' : v >= 50 ? '#f59e0b' : '#ef4444'),
        borderRadius: 6, borderSkipped: false, barThickness: 14, maxBarThickness: 20,
      }]
    },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false,
      indexAxis: 'y',
      layout: { padding: { right: 28, left: 8, top: 8, bottom: 8 } },
      plugins: {
        legend: { display: false }, tooltip: { enabled: false },
        datalabels: {
          display: true, color: '#ffffff',
          font: { size: 9, weight: '700', family: 'monospace' },
          anchor: 'end', align: 'right', offset: 3,
          formatter: v => v + '%',
        },
      },
      scales: {
        x: { beginAtZero: true, min: 0, max: 110,
          ticks: { color: '#6B7280', font: { size: 8 }, callback: v => v<=100?v+'%':'' },
          grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false } },
        y: { ticks: { color: '#E5E7EB', font: { size: 9, weight: '600' }, autoSkip: false, maxRotation: 0 },
          grid: { display: false } }
      },
    }
  };
}

function buildRiskSeverityChartConfig(verdict, score) {
  const cycle = score >= 75 ? 35 : score >= 50 ? 65 : 85;
  const lock  = score >= 75 ? 40 : score >= 50 ? 60 : 75;
  const budget = score >= 75 ? 45 : score >= 50 ? 65 : 80;
  const compete = score >= 75 ? 50 : score >= 50 ? 55 : 70;
  return {
    type: 'bar',
    data: {
      labels: ['Decision Cycle', 'Vendor Lock-in', 'Budget Friction', 'Competitive Pressure'],
      datasets: [{
        data: [cycle, lock, budget, compete],
        backgroundColor: [
          cycle>=70?'#ef4444':cycle>=50?'#f59e0b':'#22c55e',
          lock>=70?'#ef4444':lock>=50?'#f59e0b':'#22c55e',
          budget>=70?'#ef4444':budget>=50?'#f59e0b':'#22c55e',
          compete>=70?'#ef4444':compete>=50?'#f59e0b':'#22c55e',
        ],
        borderRadius: 6, borderSkipped: false, barThickness: 14, maxBarThickness: 20,
      }]
    },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false,
      indexAxis: 'y',
      layout: { padding: { right: 28, left: 8, top: 8, bottom: 8 } },
      plugins: {
        legend: { display: false }, tooltip: { enabled: false },
        datalabels: {
          display: true, color: '#ffffff',
          font: { size: 9, weight: '700', family: 'monospace' },
          anchor: 'end', align: 'right', offset: 3,
          formatter: v => v >= 70 ? 'High' : v >= 50 ? 'Med' : 'Low',
        },
        annotation: {
          annotations: {
            highThreshold: {
              type: 'line', xMin: 70, xMax: 70,
              borderColor: 'rgba(239,68,68,0.3)', borderWidth: 1, borderDash: [3,3],
            },
          },
        },
      },
      scales: {
        x: { beginAtZero: true, min: 0, max: 110, display: false },
        y: { ticks: { color: '#E5E7EB', font: { size: 9, weight: '600' }, autoSkip: false, maxRotation: 0 },
          grid: { display: false } }
      },
    }
  };
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();
}

function truncateWords(text, limit = 70) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}...`;
}

function safeText(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  if (typeof value === 'object') return Object.values(value).filter(Boolean).join(', ');
  return String(value).trim();
}

function renderGaugeChart(base64, score, verdict, dimensions = { width: 320, height: 200 }) {
  if (!base64) return renderGaugeFallback(score, verdict);
  const color = /^go$/i.test(verdict) ? '#22c55e' : /no/i.test(verdict) ? '#ef4444' : '#f59e0b';
  return `<div style="position:relative;width:${dimensions.width}px;height:${dimensions.height}px;margin:3mm auto;">
    <img src="data:image/png;base64,${base64}"
      width="${dimensions.width}" height="${dimensions.height}"
      style="width:100%;height:100%;object-fit:contain;border-radius:14px;"
      alt="GTM Score gauge"/>
  </div>`;
}

function renderPageInsight(title, text, isDemoMode) {
  if (!text) return '';
  const clean = truncateWords(escapeHtml(text), 70);
  const final = isDemoMode && !/demo mode/i.test(clean) ? `${clean} In demo mode, validate with live data.` : clean;
  return `<div class="page-insight"><div class="page-insight-title">${escapeHtml(title)}</div><div class="page-insight-text">${final}</div></div>`;
}

function renderExpandedPageInsight(insight, isDemoMode) {
  if (!insight || !insight.title || !insight.what_this_means || !insight.recommended_action) return renderPageInsight(insight?.title, insight?.text, isDemoMode);
  const what = truncateWords(escapeHtml(insight.what_this_means), 60);
  const action = truncateWords(escapeHtml(insight.recommended_action), 60);
  const demoNote = isDemoMode ? '<div class="page-insight-demo">In demo mode, validate with live data.</div>' : '';
  return `<div class="page-insight page-insight-expanded"><div class="page-insight-title">${escapeHtml(insight.title)}</div><div class="page-insight-grid"><div><div class="mini-label">What this means</div><p>${what}</p></div><div><div class="mini-label">Recommended action</div><p>${action}</p></div></div>${demoNote}</div>`;
}

function getPageInsight(pageKey, strategy, isDemoMode) {
  const s1 = strategy.step_1_market || {};
  const s2 = strategy.step_2_tam || {};
  const s3 = strategy.step_3_icp || {};
  const s4 = strategy.step_4_sourcing || {};
  const s5 = strategy.step_5_keywords || {};
  const s6 = strategy.step_6_messaging || {};
  const s7 = strategy.step_7_intelligence || {};
  const score = parseInt(s1.gtm_relevance_score) || 0;
  const keywords = safeText(s5.primary_keywords || s5.secondary_keywords);
  const sequence = safeText(s6.follow_up_sequence || s6.linkedin_message);
  const primary  = safeText(s3.primary_icp);
  switch(pageKey) {
    case 'executive_summary': return {
      title: 'Strategic Interpretation', expanded: true,
      text: score ? `A GTM score of ${score}/100 signals directional attractiveness for this market motion — prioritize, monitor, or pause based on data richness.` : `This summary sets the commercial context. Validate the score with live pipeline and buyer data before taking action.`,
      what_this_means: score >= 75 ? `Strong alignment across TAM, ICP, and timing signals. This motion is ready for active engagement.` : score >= 50 ? `Moderate alignment. Validate the weakest evidence areas before committing outbound resources.` : `Limited fit signals detected. Consider re-evaluating in 60–90 days with richer data.`,
      recommended_action: score >= 75 ? `Initiate outbound with the top-tier ICP accounts and validate conversion signals within 30 days.` : score >= 50 ? `Run a small test batch with high-fit accounts before scaling. Strengthen weak signal areas first.` : `Pause full-scale execution. Identify the root cause of low fit and re-qualify the TAM before proceeding.`,
    };
    case 'market_research': return {
      title: 'Market Implication',
      text: `Positioning, SWOT signals, and growth indicators show whether the current strategy is ready for active engagement or needs refinement. Use this page to align timing and messaging to realistic market conditions.`
    };
    case 'tam_mapping': return {
      title: 'Commercial Impact', expanded: true,
      text: `TAM defines the total universe, SAM defines the addressable slice, and SOM defines what is realistically capturable. These figures anchor prioritization to high-probability account selection.`,
      what_this_means: `The narrowing from TAM to SOM represents realistic go-to-market scope — not just market size. Over-targeting the full TAM is a common execution failure.`,
      recommended_action: `Focus immediate sourcing on the SOM tier. Expand only after win rate and deal cycle data from early accounts are validated.`,
    };
    case 'icp_modeling': return {
      title: 'ICP Interpretation',
      text: primary ? `The primary ICP and pain points identified here are the targeting foundation. Align outreach to buyer roles and objections to reduce wasted effort and improve response rates.` : `Define the highest-fit buyer profile before initiating outbound. Weak ICP clarity is the most common reason for low reply rates.`
    };
    case 'account_sourcing': return {
      title: 'Sourcing Implication', expanded: true,
      text: `Filters and exclusions on this page improve account quality and reduce wasted outreach. These criteria keep the pipeline focused on accounts with the strongest fit and intent.`,
      what_this_means: `The sourcing criteria narrow the target universe to higher-fit accounts, reducing wasted outreach cycles against borderline names.`,
      recommended_action: `Use these filters to prioritize accounts with strong fit and exclude low-fit names from active sequencing immediately.`,
    };
    case 'keywords_intent': return {
      title: 'Intent Interpretation', expanded: true,
      text: keywords ? `Keyword clusters and intent signals here guide messaging and search strategy so outreach matches where buyers are in the funnel.` : `Use the keyword and intent signals to shape content and personalization for higher relevance and reply rates.`,
      what_this_means: `The signal clusters show where buyer intent is strongest and which themes should be prioritized in outreach personalization.`,
      recommended_action: `Build messaging around the highest-priority intent themes. Keep outreach concise and directly aligned to buyer needs.`,
    };
    case 'sdr_sequence': return {
      title: 'Engagement Logic',
      text: `A three-touch SDR sequence moves buyers from problem awareness to interest and urgency without overloading them early. This structure builds credibility while surfacing high-fit responses.`
    };
    case 'followup_social': return {
      title: 'Channel Strategy', expanded: true,
      text: sequence ? `LinkedIn and follow-up messaging extend the outreach motion with a second channel, increasing the chance of connecting with enterprise buyers who require multiple credible touch points.` : `Reinforcing primary outreach with a second channel matters for enterprise connections where single-touch response rates are typically low.`,
      what_this_means: `Follow-up and social outreach broaden the core engagement sequence without adding friction to the buyer journey.`,
      recommended_action: `Activate follow-up within 3–5 days of the first touch. Use LinkedIn to reinforce credibility before the second email touch.`,
    };
    case 'decision_engine': return {
      title: 'Decision Interpretation', expanded: true,
      text: `The verdict is a directional recommendation. Confirm the assumptions behind the score and timing before committing execution resources or re-prioritizing the commercial pipeline.`,
      what_this_means: `The decision score is a prioritization signal for execution readiness — not a substitute for stakeholder review and live validation.`,
      recommended_action: `Review the recommendation, validate weak assumptions, and only advance the motion if evidence support aligns with your go-to-market timing window.`,
    };
    case 'confidence_matrix': return {
      title: 'Confidence Interpretation', expanded: true,
      text: `This matrix shows which evidence areas most affect trust in the recommendation. Use it to identify where additional verification is required before moving resources forward.`,
      what_this_means: `The confidence matrix lets you see which evidence pillars are strong and which need more validation before scaling execution.`,
      recommended_action: `Focus follow-up research on the lowest-confidence dimensions and update the recommendation before committing outbound resources.`,
    };
    default: return null;
  }
}

function renderPageInsightBlock(pageKey, strategy, isDemoMode) {
  const insight = getPageInsight(pageKey, strategy, isDemoMode);
  if (!insight || !insight.text) return '';
  if (insight.expanded && insight.what_this_means && insight.recommended_action) {
    return renderExpandedPageInsight(insight, isDemoMode);
  }
  return renderPageInsight(insight.title, insight.text, isDemoMode);
}

// ══════════════════════════════════════════════════════════════
// TIER-1 ENTERPRISE A4 REPORT — dark-theme, rendered to PDF
// ══════════════════════════════════════════════════════════════
export function buildReportHTML(strategy, charts = {}, isDemoMode = false) {
  const s1 = strategy.step_1_market || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp || strategy.steps?.[3] || {};
  const s4 = strategy.step_4_sourcing || strategy.steps?.[4] || {};
  const s5 = strategy.step_5_keywords || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};
  const s7 = strategy.step_7_intelligence || {};
  const coRaw = strategy.company_name || 'Company';
  const co = normalizeCompanyName(coRaw);
  const ind = strategy.industry || '';
  const date = new Date().toLocaleDateString('en-GB',{year:'numeric',month:'long',day:'numeric'});
  const score = parseInt(s1.gtm_relevance_score) || 0;
  const confScore = parseInt(s7.confidence_score) || score || 0;

  // ── String helpers ──
  const e = s => { if(typeof s!=='string') return String(s||''); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); };
  const safe = v => { if(!v&&v!==0) return ''; if(Array.isArray(v)) return v.join(', '); if(typeof v==='object') return Object.entries(v).map(([k,x])=>`${k}: ${Array.isArray(x)?x.join(', '):x}`).join('; '); return String(v); };
  const arr = v => Array.isArray(v)?v:(v?[String(v)]:[]);

  // ── Strategic positioning: robust first sentence extraction ──
  const getFirstSentence = (text) => {
    if (!text) return '';
    // Strip leading dots/spaces/newlines (e.g. ".cloudflare is..." → "cloudflare is...")
    const clean = String(text).replace(/^[\s.\-–—]+/, '').trim();
    // Find first sentence boundary after at least 20 chars
    const idx = clean.search(/\.(?=\s|$)/);
    if (idx > 15) return clean.slice(0, idx);
    // Fallback: first line or first 150 chars
    const line = clean.split(/\n/)[0];
    return line.length > 20 ? line : clean.slice(0, 150);
  };
  // Strategic positioning fallback chain
  const getStrategicPositioning = () => {
    const candidates = [
      s7.strategic_hook,
      s1.company_overview,
      s1.market_position,
      s7.go_no_go?.reason,
    ];
    for (const c of candidates) {
      const text = safe(c);
      if (text && text.length > 20) return getFirstSentence(text);
    }
    return `${co} is a commercially relevant target based on inferred market fit, GTM maturity, and revenue operations alignment. Validate with live data before decisioning.`;
  };
  const strategicPositioning = getStrategicPositioning();
  const rec = s7.go_no_go?.recommendation || (score>=75?'Go':score>=50?'Watch':'No-Go');
  const recUp = rec.toUpperCase();
  const recColor = /go$/i.test(rec)&&!/no/i.test(rec)?'var(--green)':/no/i.test(rec)?'var(--red)':'var(--amber)';
  const veracity = Math.round(confScore*0.4);
  const timing = Math.round(confScore*0.25);
  const icpFit = Math.round(confScore*0.2);
  const completeness = Math.round(confScore*0.15);

  const srcNote = (src) => `<div style="font-size:7.5px;color:var(--faint);margin:1.5mm 0;font-style:italic">◆ ${e(src)} — validate manually</div>`;
  const callout = (text,cls='') => text?`<div class="ac ${cls}"><strong><svg width="11" height="11" viewBox="0 0 16 16" fill="none" style="display:inline;vertical-align:middle;margin-right:3px"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Analyst Insight:</strong> ${e(text)}</div>`:'';

  // ── ICP placeholder detection & repair ──
  const ICP_BAD = /^(persona|secondary|unknown|n\/a|—|-|\s*)$/i;
  const isPhICP = v => !v || ICP_BAD.test(String(v).trim());
  const deriveICP = (raw, role) => {
    if (!isPhICP(raw)) return safe(raw);
    const dms = arr(s3.decision_makers), trig = arr(s3.buying_triggers);
    if (role === 'primary') {
      if (dms.length) return `${dms[0]}${ind ? ` in ${ind}` : ''} — derived from decision-maker data`;
      if (ind) return `Senior technology decision-maker in ${ind} — derived from industry`;
      if (trig.length) return `Budget holder responsive to ${trig[0]} — derived from triggers`;
      return 'Senior decision-maker with P&L authority — derived from business model';
    }
    if (dms.length > 1) return `${dms[1]}${ind ? ` in ${ind}` : ''} — derived from decision-maker data`;
    if (ind) return `Operations/procurement leader in ${ind} — derived from industry`;
    return 'Line-of-business owner with operational oversight — derived from business model';
  };
  const primaryICP = deriveICP(s3.primary_icp, 'primary');
  const secondaryICP = deriveICP(s3.secondary_icp, 'secondary');
  const icpDerived = isPhICP(s3.primary_icp) || isPhICP(s3.secondary_icp);

  // ── Account name sanitization ──
  const FAKE_RE = /^(global bank|euro\s?manu|healthfirst|acme|sample|test|example|foo|bar|demo|dummy|placeholder|mega\s?corp)/i;
  const ANALOGS = ['Top-5 UK retail bank','Large EU automotive OEM','Tier-1 APAC telco','Regional food delivery aggregator','Enterprise SaaS vendor (NA)','Mid-market insurance carrier (EU)','Large Indian quick-commerce platform','Fortune-500 industrial conglomerate'];
  const cleanAcct = (name, i) => { if (!name||name==='—') return ANALOGS[i%ANALOGS.length]; const n=String(name).trim(); return FAKE_RE.test(n)?ANALOGS[i%ANALOGS.length]:n; };

  // ── Helper builders ──
  const pageHdr = () => `<div class="ph"><div class="phb"><div class="am">ABE</div><div><div class="abn">AI Revenue Infrastructure</div><div class="abs">Enterprise GTM Platform</div></div></div><div class="cb">Confidential</div></div>`;
  const pageFtr = (label,num) => `<div class="pf"><span>ABE · ${e(label)}</span><span>${num}</span></div>`;

  // SVG icons for each section (inline, no external deps)
  const ICONS = {
    ES:  `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="2" rx="1" fill="white"/><rect x="2" y="7" width="8" height="2" rx="1" fill="white" opacity=".7"/><rect x="2" y="11" width="10" height="2" rx="1" fill="white" opacity=".5"/></svg>`,
    '01':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="white" stroke-width="1.5"/><path d="M8 5v3l2 2" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    '02':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 13L6 7l3 3 2-4 3 4" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    '03':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="2.5" stroke="white" stroke-width="1.5"/><path d="M3 13c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    '04':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="5" r="2" stroke="white" stroke-width="1.5"/><circle cx="11" cy="8" r="2" stroke="white" stroke-width="1.5"/><circle cx="5" cy="11" r="2" stroke="white" stroke-width="1.5"/><path d="M7 5h2M7 11h2M6 7l3-1" stroke="white" stroke-width="1" opacity=".6"/></svg>`,
    '05':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4" stroke="white" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    '06':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 12V6l5-3 5 3v6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="6" y="8" width="4" height="4" rx=".5" stroke="white" stroke-width="1.2"/></svg>`,
    '07':`<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2l1.5 4h4l-3.5 2.5 1.5 4L8 10l-3.5 2.5 1.5-4L2.5 6h4z" stroke="white" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    A:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2L10 7H15L11 10L13 15L8 12L3 15L5 10L1 7H6Z" stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  };
  const secHead = (num, title) => {
    const icon = ICONS[num] || '';
    return `<h2 class="section-header"><span class="sa" style="background:linear-gradient(135deg,var(--accent2),var(--accent))">${icon||num}</span> ${e(title)}</h2>`;
  };
  const secCtx = text => text?`<div class="sc">${e(text)}</div>`:'';
  const tags = (items,cls='') => arr(items).slice(0,15).map(t=>`<span class="tg ${cls}">${e(String(t))}</span>`).join('');
  const fieldRow = (label,val) => { const v=safe(val); return v?`<tr><th>${e(label)}</th><td>${e(v)}</td></tr>`:''; };

  // ── SWOT ──
  const swotCell = (label,items,color) => { const a=arr(items); return a.length?`<div class="sc2" style="border-top:3px solid ${color}"><div class="sl" style="color:${color}">${label}</div><ul>${a.slice(0,4).map(i=>`<li>${e(String(i))}</li>`).join('')}</ul></div>`:''; };
  const swotGrid = () => { const sw=s1.swot; if(!sw||typeof sw!=='object') return ''; const h=swotCell('STRENGTHS',sw.strengths,'var(--green)')+swotCell('WEAKNESSES',sw.weaknesses,'var(--red)')+swotCell('OPPORTUNITIES',sw.opportunities,'var(--blue)')+swotCell('THREATS',sw.threats,'var(--amber)'); return h?`<div class="sg swot-grid">${h}</div>`:''; };

  // ── TAM Waterfall with math ──
  const wfBar = (label,value,w,cls) => value?`<div class="wb"><div class="wv">${e(safe(value))}</div><div class="wftrack"><div class="wf ${cls}" style="width:${w}"></div></div><span style="margin-left:2mm;font-size:9px;color:var(--muted)">${label}</span></div>`:'';
  const waterfall = () => {
    const wf=s2.waterfall||{}; const tam=safe(s2.tam_size_estimate); if(!tam&&!wf.tam_value) return '';
    const tamV=wf.tam_value||tam, samV=wf.sam_value||safe(s2.sam_estimate)||'—', somV=wf.som_value||'5–10% of TAM';
    const tamSrc=samV&&samV!=='—'?'Market estimate':'AI estimate ⚠️';
    // Dynamic factors — pull from strategy data when available, else default
    const geoRaw = wf.geography_eligibility || s2.geography_eligibility;
    const slRaw  = wf.service_line_fit || s2.service_line_fit;
    const wrRaw  = wf.win_rate || wf.capture_rate || s2.win_rate;
    const geoVal = geoRaw ? safe(geoRaw) : '60–70%';
    const slVal  = slRaw  ? safe(slRaw)  : '30–40%';
    const wrVal  = wrRaw  ? safe(wrRaw)  : '8–12%';
    const geoSrc = geoRaw ? 'Company data' : 'AI estimate ⚠️ (default)';
    const slSrc  = slRaw  ? 'Company data' : 'AI estimate ⚠️ (default)';
    const wrSrc  = wrRaw  ? 'Company data' : 'AI estimate ⚠️ (default)';
    return `<div class="ww">${wfBar('TAM (Total Addressable)',tamV,'80%','wfb')}${wfBar('SAM (Serviceable Addressable)',samV,'50%','wfa')}${wfBar('SOM (Serviceable Obtainable)',somV,'20%','wfm')}</div>
    <h3>2.2b · TAM Derivation Formula</h3>
    <div class="table-wrap card"><table class="dt">
      <tr><th>Step</th><th>Factor</th><th class="num">Value</th><th>Source</th></tr>
      <tr><td>Global TAM</td><td>Total market size</td><td class="num">${e(tamV)}</td><td>${tamSrc}</td></tr>
      <tr><td>× Geography eligibility</td><td>Addressable regions</td><td class="num">${e(geoVal)}</td><td>${geoSrc}</td></tr>
      <tr><td>× Service-line fit</td><td>Relevant segments</td><td class="num">${e(slVal)}</td><td>${slSrc}</td></tr>
      <tr><td>× Capture / win rate</td><td>Realistic close rate</td><td class="num">${e(wrVal)}</td><td>${wrSrc}</td></tr>
      <tr style="border-top:1px solid var(--accent)"><td><strong>= Obtainable opportunity</strong></td><td></td><td class="num ha">${e(somV)}</td><td>Derived</td></tr>
    </table>
    <div style="font-size:8px;color:var(--faint);margin-top:2mm;font-style:italic">⚠️ Factors marked "AI estimate" use conservative defaults. When company-specific data is available, it is used automatically.</div></div>`;
  };

  // ── Pain-Solution Map ──
  const painMap = () => { const m=s3.pain_solution_map; if(!Array.isArray(m)||!m.length) return ''; return `<h3>3.3 · Pain → Impact → Intervention</h3><table class="dt"><thead><tr><th>Operational Friction</th><th>Business Impact</th><th>Intervention</th></tr></thead><tbody>${m.slice(0,5).map(p=>`<tr><td>${e(safe(p.operational_friction||'—'))}</td><td style="color:var(--amber)">${e(safe(p.business_impact||'—'))}</td><td style="color:var(--green)">${e(safe(p.recommended_intervention||'—'))}</td></tr>`).join('')}</tbody></table>`; };

  // ── Account Targets (sanitized) ──
  const acctTable = () => { const t=s4.account_targets; if(!Array.isArray(t)||!t.length) return ''; return `<h3>4.3 · High-Fit Account Analogs</h3><table class="dt"><thead><tr><th>Account Profile</th><th style="text-align:center">Fit</th><th>Trigger</th></tr></thead><tbody>${t.slice(0,5).map((a,i)=>`<tr><td>${e(cleanAcct(a.account_name,i))}</td><td class="num" style="color:${(a.fit_score||0)>=80?'var(--green)':'var(--amber)'}">${a.fit_score||'—'}</td><td>${e(safe(a.actionable_trigger||'—'))}</td></tr>`).join('')}</tbody></table>${srcNote('Account names are anonymized analogs representing target archetypes — AI-generated profile matching')}`; };

  // ── Keyword Taxonomy ──
  const kwTaxonomy = () => { const kt=s5.keyword_taxonomy; if(!kt||typeof kt!=='object') return ''; const ef=arr(kt.early_funnel), lf=arr(kt.late_funnel); if(!ef.length&&!lf.length) return ''; return `<h3>5.2 · Funnel Taxonomy</h3><div style="display:grid;grid-template-columns:1fr 1fr;gap:3mm"><div><div class="bl">Early Funnel (Problem-Aware)</div>${tags(ef,'blue')}</div><div><div class="bl">Late Funnel (Solution-Aware)</div>${tags(lf,'green')}</div></div>`; };

  // ── Segments Table ──
  const segTable = () => { const sg=s2.market_segments; if(!Array.isArray(sg)||!sg.length) return ''; return `<h3>2.3 · Market Segments</h3><table class="dt"><thead><tr><th>Segment</th><th class="num">Est. Size</th><th>Priority</th><th class="num">Growth</th></tr></thead><tbody>${sg.slice(0,6).map(s=>`<tr><td>${e(safe(s.name||s.segment_name||'—'))}</td><td class="num">${e(safe(s.size||s.market_size||'—'))}</td><td>${e(safe(s.priority||'—'))}</td><td class="num">${e(safe(s.growth_rate||'—'))}</td></tr>`).join('')}</tbody></table>${srcNote('AI market estimate — validate with industry reports')}`; };

  // ── Emails — SDR Timeline ──
  const emailBlock = (k,i) => {
    const em=s6[k]; if(!em) return '';
    const icons = ['✉','✉','✉','🔗','📞'];
    const labels = ['Email 1','Email 2','Email 3','LinkedIn','Follow-up'];
    return `<div class="sdr-step">
      <div class="sdr-num">${icons[i]||i+1}</div>
      <div class="sdr-body">
        <div class="sdr-angle">${labels[i]||'Step '+(i+1)} — ${e(em.angle||'')}</div>
        <div class="sdr-subject">${e(em.subject||'—')}</div>
        <div class="sdr-preview">${e(em.body||'—')}</div>
        <span class="tg green" style="margin-top:2mm;display:inline-block">CTA: ${e(em.cta||'—')}</span>
      </div>
    </div>`;
  };

  // ── ICP Repair Logic ──
  const icpRepair = () => {
    const pm=s3.persona_map; if(!pm||typeof pm!=='object') return '';
    const row = (role,obj) => { if(!obj||typeof obj!=='object') return ''; return `<tr><td><strong>${e(role)}</strong></td><td>${e(safe(obj.title||'—'))}</td><td>${e(safe(obj.key_responsibility||'—'))}</td></tr>`; };
    const rows = row('Primary Contact',pm.primary_role)+row('Economic Buyer',pm.economic_buyer)+row('Internal Champion',pm.champion);
    return rows?`<h3>3.4 · ICP Persona Map (Repair Logic)</h3><table class="dt"><thead><tr><th>Role</th><th>Title</th><th>Key Responsibility</th></tr></thead><tbody>${rows}</tbody></table>`:'';
  };

  // ── Decision Engine (Step 7) ──
  const decisionEngine = () => {
    if(!score&&!confScore) return '';
    const hasS7 = s7 && Object.keys(s7).length>1;
    const triggers = arr(s3.buying_triggers);
    const dms = arr(s3.decision_makers);
    const whyNow = hasS7&&s7.why_now_analysis ? s7.why_now_analysis : `Market conditions and active ${(triggers[0]||'operational pressure').toLowerCase()} dynamics create a time-sensitive engagement window.`;
    const hook = hasS7&&s7.strategic_hook ? s7.strategic_hook : (triggers.length>=2?`${triggers[0]} paired with ${triggers[1]}`:`Lead with: ${triggers[0]||'Operational pressure'}`);
    const reason = s7.go_no_go?.reason || (score>=75?`GTM score of ${score} indicates strong alignment. Initiate outbound immediately.`:score>=50?`GTM score of ${score} reflects moderate alignment. Monitor triggers before committing.`:`GTM score of ${score} indicates limited fit. Re-evaluate in 90 days.`);
    return `
  ${secHead('07','Revenue Intelligence — Decision Engine')}
  ${secCtx('Final strategic audit. Validates execution viability and dictates immediate next steps.')}
  <h3>7.1 · Go / No-Go Validation</h3>
  <div class="card" style="border-left:4px solid ${recColor}">
    <div style="display:flex;align-items:center;gap:5mm">
      <svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
        <circle cx="26" cy="26" r="24" fill="rgba(168,85,247,.06)" stroke="${recColor}" stroke-width="1.5"/>
        ${/no/i.test(rec)?`<path d="M18 18L34 34M34 18L18 34" stroke="${recColor}" stroke-width="3" stroke-linecap="round"/>`:/go$/i.test(rec)&&!/no/i.test(rec)?`<path d="M15 27L22 34L37 18" stroke="${recColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`:`<path d="M26 18v10M26 32v2" stroke="${recColor}" stroke-width="3" stroke-linecap="round"/>`}
      </svg>
      <div>
        <div style="font-family:'Space Mono',monospace;font-size:26px;font-weight:900;color:${recColor};line-height:1">${e(recUp)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:1.5mm"><strong style="color:var(--text)">Verdict Rationale:</strong> ${e(reason)}</div>
      </div>
    </div>
  </div>
  ${srcNote(hasS7?'Source: Step 7 AI intelligence layer — algorithmic composite':'Source: derived from GTM relevance score ('+score+'/100) — algorithmic')}
  <h3>7.2 · Why Now</h3>
  <div class="card"><p style="font-size:12px">${e(whyNow)}</p></div>
  ${srcNote(hasS7&&s7.why_now_analysis?'Source: Step 7 AI analysis of market signals':'Source: AI inference from buying triggers and market context — validate timing independently')}
  <h3>7.3 · Strategic Hook</h3>
  <div class="ac"><strong>"${e(hook)}"</strong></div>
  ${srcNote(hasS7&&s7.strategic_hook?'Source: Step 7 AI strategic analysis':'Source: derived from buying triggers — AI estimate')}
  <h3>7.4 · Risk &amp; Constraint Analysis</h3>
  <div class="card" style="border-left:4px solid var(--red);background:rgba(239,68,68,.03)">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:3mm">
      <div>
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--red);margin-bottom:1.5mm">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style="display:inline;vertical-align:middle;margin-right:2px"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M6 4v3M6 8v.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Decision Cycle</div>
        <div style="font-size:9.5px;color:var(--text)">${dms.length?`Buying committee: ${dms.slice(0,2).join(', ')}. Extends cycle 30–60 days.`:'Multi-stakeholder approval cycle expected.'}</div>
      </div>
      <div>
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--amber);margin-bottom:1.5mm">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style="display:inline;vertical-align:middle;margin-right:2px"><rect x="1" y="4" width="10" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4 4V3a2 2 0 014 0v1" stroke="currentColor" stroke-width="1.2"/></svg> Vendor Lock-in</div>
        <div style="font-size:9.5px;color:var(--text)">Incumbent relationships reduce switching probability. Lead with differentiated outcomes.</div>
      </div>
      <div>
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--amber);margin-bottom:1.5mm">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style="display:inline;vertical-align:middle;margin-right:2px"><path d="M6 2v2M6 8v2M2 6h2M8 6h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.2"/></svg> Budget Friction</div>
        <div style="font-size:9.5px;color:var(--text)">CFO-level ROI framing required. Surface quantifiable efficiency recovery.</div>
      </div>
    </div>
  </div>
  ${srcNote('30–60 day cycle estimate is an industry benchmark (AI estimate) — validate with CRM data')}
  ${charts.risk
    ? `<div style="margin:2mm 0 4mm"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2mm">RISK SEVERITY ASSESSMENT</div>${renderChartOrFallback('Risk Severity', charts.risk, '', {width:480,height:180})}</div>`
    : ''
}
  <h3>7.5 · Execution Priority</h3>
  <div class="card">
    <div style="display:flex;gap:5mm">
      <div style="flex:1;border-right:1px solid var(--border);padding-right:4mm">
        <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm">Target</div>
        <div style="font-size:11px;font-weight:700;color:white">${e(dms[0]||safe(s3.primary_icp)||'Senior decision-makers')}</div>
      </div>
      <div style="flex:1;border-right:1px solid var(--border);padding-right:4mm">
        <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm">Lead With</div>
        <div style="font-size:11px;font-weight:700;color:var(--amber)">${e(triggers[0]||'Operational pressure')}</div>
      </div>
      <div style="flex:1">
        <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm">Close With</div>
        <div style="font-size:11px;font-weight:700;color:var(--green)">${safe(s2.growth_rate)?`${safe(s2.growth_rate)} market — quantify cost of delay`:'Quantified ROI recovery'}</div>
      </div>
    </div>
  </div>
  ${safe(s2.growth_rate)?srcNote('CAGR ('+safe(s2.growth_rate)+') is an AI market estimate — cross-reference with analyst reports'):''}`;

  };

  // ── Weighted Confidence Matrix ──
  const confidenceMatrix = () => {
    if(!confScore) return '';
    const cmBar = (label, sc, max, cls='') => `<div class="cmrow ${cls}">
      <div class="cmhdr"><span class="cmlbl">${label}</span><span class="cmscore">${sc}<span style="font-size:8px;font-weight:400;color:var(--muted)">/${max}</span></span></div>
      <div class="cmtrack"><div class="cmfill" style="width:${Math.round((sc/max)*100)}%"></div></div>
    </div>`;
    // SVG donut: r=28, circumference=176
    const circ = 176;
    const filled = Math.round((confScore/100)*circ);
    const gaugeColor = confScore>=75?'var(--green)':confScore>=50?'var(--amber)':'var(--red)';
    return `
  <h3>7.6 · Weighted Confidence Matrix</h3>
  <div style="display:flex;gap:6mm;align-items:flex-start">
    <svg width="90" height="90" viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
      <circle cx="45" cy="45" r="28" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="9"/>
      <circle cx="45" cy="45" r="28" fill="none" stroke="${gaugeColor}" stroke-width="9"
        stroke-dasharray="${filled} ${circ}" stroke-dashoffset="${Math.round(circ*0.25)}"
        stroke-linecap="round" transform="rotate(-90 45 45)"/>
      <text x="45" y="42" text-anchor="middle" font-family="'Space Mono',monospace" font-size="16" font-weight="900" fill="white">${confScore}</text>
      <text x="45" y="54" text-anchor="middle" font-family="Inter,sans-serif" font-size="6.5" fill="#6B7280" letter-spacing="1">FIDELITY</text>
    </svg>
    <div style="flex:1">
      ${cmBar('Signal Veracity (40%)', veracity, 40)}
      ${cmBar('Market Timing (25%)', timing, 25)}
      ${cmBar('ICP Fit (20%)', icpFit, 20)}
      ${cmBar('Data Completeness (15%)', completeness, 15)}
      <div style="border-top:1px solid rgba(168,85,247,.2);margin:3mm 0 2mm"></div>
      ${cmBar('Overall Fidelity', confScore, 100, 'cmrow-overall')}
    </div>
  </div>
  ${srcNote('Confidence score is algorithmic — weights fixed (40/25/20/15), capped by data richness')}`;
  };

  // ════════════════════════════════════════════════════════════
  // FULL HTML DOCUMENT
  // ════════════════════════════════════════════════════════════
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0B0F1A;--bg2:#0D1120;--card:#121827;--border:#1F2937;--accent:#a855f7;--accent2:#7c3aed;--green:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#3b82f6;--text:#E5E7EB;--muted:#6B7280;--faint:#374151;--white:#fff}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);font-size:11.5px;line-height:1.65;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;min-height:297mm;overflow:visible;margin:0;background:var(--bg);padding:15mm 18mm 20mm;position:relative;page-break-after:always;box-sizing:border-box}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:8mm;border-bottom:1px solid var(--border);padding-bottom:4mm}
.phb{display:flex;align-items:center;gap:10px}
.am{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:white}
.abn{font-size:12px;font-weight:800;color:white}
.abs{font-family:'Space Mono',monospace;font-size:8px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
.cb{background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);border-radius:20px;padding:4px 14px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font-size:36px;font-weight:900;color:white;letter-spacing:-.5px}
h2{font-size:17px;font-weight:700;color:white;margin-bottom:3mm;display:flex;align-items:center;gap:8px}
h3{font-size:13px;font-weight:600;color:var(--text);margin-top:4mm;margin-bottom:2mm}
p{margin-bottom:2mm}
.sa{display:inline-flex;width:26px;height:26px;background:linear-gradient(135deg,var(--accent2),var(--accent));border-radius:7px;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:white}
.sc{font-size:11.5px;color:var(--muted);margin-bottom:4mm;border-bottom:1px dashed var(--border);padding-bottom:2.5mm}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:4mm 5mm;margin-bottom:3.5mm;break-inside:avoid;page-break-inside:avoid;box-sizing:border-box}
.bl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-bottom:1.5mm}
.dt{width:100%;border-collapse:collapse;margin-top:1.5mm;font-size:10px;margin-bottom:3mm}
.dt th{text-align:left;color:var(--muted);font-weight:600;padding:1.5mm 2.5mm;border-bottom:1px solid var(--border)}
.dt td{padding:1.5mm 2.5mm;border-bottom:1px solid rgba(31,41,55,.5);vertical-align:top}
.num{font-family:'Space Mono',monospace;text-align:right}
.ha{color:var(--accent);font-weight:700}
.mn{font-size:22px;font-weight:900;font-family:'Space Mono',monospace;color:var(--accent)}
.ac{background:rgba(168,85,247,.04);border:1px solid rgba(168,85,247,.2);border-left:4px solid var(--accent);border-radius:8px;padding:3mm 4mm;margin:3mm 0;font-size:10.5px;break-inside:avoid;page-break-inside:avoid}
.insight-box{break-inside:avoid;page-break-inside:avoid}
.kpi-row{display:flex;gap:3mm;margin-bottom:4mm;break-inside:avoid;page-break-inside:avoid}
.kpi-card,.kpi{flex:1;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:3.5mm 4mm;text-align:center;position:relative;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
.table-wrap{break-inside:avoid;page-break-inside:avoid;overflow:visible}
.swot-grid{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm;margin:1.5mm 0 3mm;break-inside:avoid;page-break-inside:avoid}
.risk-grid{break-inside:avoid;page-break-inside:avoid}
.email-card{break-inside:avoid;page-break-inside:avoid}
.chart-block{break-inside:avoid;page-break-inside:avoid;margin:3mm 0}
.confidence-matrix{break-inside:avoid;page-break-inside:avoid}
.appendix-section{break-inside:avoid;page-break-inside:avoid;margin-bottom:4mm}
.section-header{break-after:avoid;page-break-after:avoid}
.ac strong{color:var(--accent)}
.ac.amber{border-left-color:var(--amber);background:rgba(245,158,11,.04);border-color:rgba(245,158,11,.2)}
.ac.amber strong{color:var(--amber)}
.ac.green{border-left-color:var(--green);background:rgba(34,197,94,.04);border-color:rgba(34,197,94,.2)}
.ac.green strong{color:var(--green)}
.ac.red{border-left-color:var(--red);background:rgba(239,68,68,.04);border-color:rgba(239,68,68,.2)}
.ac.red strong{color:var(--red)}
.tg{display:inline-block;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);border-radius:5px;padding:1mm 3mm;font-size:8.5px;font-weight:600;color:#c4b5fd;margin:1mm 1.5mm 1mm 0}
.tg.green{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.2);color:#86efac}
.tg.amber{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.2);color:#fcd34d}
.tg.blue{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.2);color:#93c5fd}
.tg.red{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.2);color:#fca5a5}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm;margin:1.5mm 0 3mm;break-inside:avoid;page-break-inside:avoid}
.sc2{border:1px solid var(--border);border-radius:7px;padding:2.5mm 3.5mm}
.sc2 ul{padding-left:4mm;font-size:9px;line-height:1.55}
.sc2 li{margin-bottom:1mm}
.sl{font-size:8.5px;font-weight:900;text-transform:uppercase;letter-spacing:.15em;margin-bottom:1.5mm}
/* ── ICON UTILITIES (inline SVG helpers) ── */
.icon-badge{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;margin-right:2mm;flex-shrink:0}
.kpi-row{display:flex;gap:3mm;margin-bottom:4mm}
.kpi{flex:1;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:3.5mm 4mm;text-align:center;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2.5px;border-radius:0 0 10px 10px}
.kpi-v{font-size:20px;font-weight:900;font-family:'Space Mono',monospace}
.kpi-l{font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm}
/* ── SDR TIMELINE ── */
.sdr-step{display:flex;gap:4mm;margin-bottom:3.5mm;align-items:flex-start}
.sdr-num{width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,var(--accent2),var(--accent));display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:white;flex-shrink:0;margin-top:1mm}
.sdr-body{flex:1;background:var(--card);border:1px solid var(--border);border-radius:9px;padding:3.5mm 4.5mm}
.sdr-angle{font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm}
.sdr-subject{font-size:11px;font-weight:700;color:white;margin-bottom:1.5mm}
.sdr-preview{font-size:10px;color:var(--text);line-height:1.55;white-space:pre-line;word-break:break-word}
.ww{margin:3mm 0}
.wb{display:flex;align-items:center;margin-bottom:3mm}
.wv{width:110px;font-family:'Space Mono',monospace;font-size:10px;text-align:right;padding-right:3mm;color:white;font-weight:700}
.wftrack{flex:1;background:rgba(255,255,255,.08);border-radius:6px;height:14px;overflow:hidden;border:1px solid rgba(255,255,255,.06)}
.wf{height:100%;border-radius:6px;min-width:4px}
.wfb{background:linear-gradient(90deg,#1d4ed8,#3b82f6,#60a5fa)}
.wfa{background:linear-gradient(90deg,#5b21b6,#7c3aed,#a855f7)}
.wfm{background:linear-gradient(90deg,#b45309,#d97706,#f59e0b)}
.confbar{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.06);border-radius:5px;height:12px;overflow:hidden;margin:3mm 0}
.conffill{height:100%;border-radius:5px;background:linear-gradient(90deg,#5b21b6,#7c3aed,#a855f7,#c084fc)}
.cmrow{margin-bottom:4mm}
.cmhdr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1.5mm}
.cmlbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
.cmscore{font-family:'Space Mono',monospace;font-size:11px;font-weight:900;color:var(--accent)}
.cmtrack{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.05);border-radius:5px;height:9px;overflow:hidden}
.cmfill{height:100%;border-radius:5px;background:linear-gradient(90deg,var(--accent2),var(--accent));min-width:3px}
.cmrow-overall .cmtrack{height:13px;border-radius:6px;background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.2)}
.cmrow-overall .cmfill{background:linear-gradient(90deg,#5b21b6,#7c3aed,#a855f7,#c084fc)}
.cmrow-overall .cmlbl{color:white;font-size:10px}
.cmrow-overall .cmscore{font-size:14px;color:white}
.pf{position:absolute;bottom:12mm;left:18mm;right:18mm;font-size:8px;color:var(--faint);display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:4mm}
ul{padding-left:5mm}li{margin-bottom:1.5mm}
</style><'+'/head><body>

<!-- COVER -->
<div class="page" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(168,85,247,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,.025) 1px,transparent 1px);background-size:28px 28px;pointer-events:none"></div>
<div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--accent2),var(--accent),#c084fc)"></div>
<div style="position:relative;z-index:1;width:100%">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12mm">
    <div style="display:flex;align-items:center;gap:8px">
      <div class="am" style="width:38px;height:38px;font-size:13px">ABE</div>
      <div style="text-align:left"><div style="font-size:11px;font-weight:800;color:white">AI Revenue Infrastructure</div><div style="font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">Enterprise GTM Platform</div></div>
    </div>
    <div style="font-size:8px;color:var(--faint);text-align:right;padding-top:2mm">${date}<br>CONFIDENTIAL</div>
  </div>
  <div style="margin-bottom:8mm">
    <h1 style="font-size:42px;font-weight:900;color:white;letter-spacing:-1px;line-height:1.1">${e(co)}</h1>
    <div style="font-size:20px;font-weight:300;color:var(--muted);margin-top:2mm;letter-spacing:2px;text-transform:uppercase">GTM Intelligence Report</div>
    ${ind?`<div style="margin-top:3mm"><span class="tg blue" style="font-size:9px">${e(ind)}</span></div>`:''}
  </div>
  <!-- GTM Score Gauge -->
  <div style="display:flex;justify-content:center;margin-bottom:8mm">
    ${renderGaugeChart(charts.gauge, score, rec, {width:320,height:200})}
  </div>
  <!-- KPI Row -->
  <div style="display:flex;gap:3mm;justify-content:center;margin-bottom:6mm">
    <div style="background:rgba(18,24,39,.85);border:1px solid rgba(168,85,247,.2);border-bottom:3px solid var(--accent);border-radius:10px;padding:4mm 6mm;min-width:38mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:var(--accent)">${e(safe(s2.tam_size_estimate)||'—')}</div>
      <div style="font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm">TAM Size</div>
    </div>
    <div style="background:rgba(18,24,39,.85);border:1px solid rgba(34,197,94,.2);border-bottom:3px solid var(--green);border-radius:10px;padding:4mm 6mm;min-width:38mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:var(--green)">${e(safe(s2.growth_rate)||'—')}</div>
      <div style="font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm">CAGR</div>
    </div>
    <div style="background:rgba(18,24,39,.85);border:1px solid rgba(245,158,11,.2);border-bottom:3px solid ${/go$/i.test(rec)&&!/no/i.test(rec)?'var(--green)':/no/i.test(rec)?'var(--red)':'var(--amber)'};border-radius:10px;padding:4mm 6mm;min-width:38mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:${recColor}">${e(recUp)}</div>
      <div style="font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm">Verdict</div>
    </div>
  </div>
  ${s1.company_overview || s7.strategic_hook ?`<div style="margin:0 auto;max-width:145mm;background:rgba(168,85,247,.05);border:1px solid rgba(168,85,247,.15);border-left:3px solid var(--accent);border-radius:8px;padding:3.5mm 5mm;text-align:left">
    <div style="font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.18em;color:var(--accent);margin-bottom:1.5mm">Strategic Positioning</div>
    <div style="font-size:10.5px;color:var(--text);line-height:1.6">${e(strategicPositioning)}.</div>
  </div>`:''}
</div>
<div style="position:absolute;bottom:12mm;left:0;right:0;font-size:8px;color:var(--faint);text-align:center;z-index:1">Classification: CONFIDENTIAL — Not for External Distribution</div>
</div>

<!-- EXECUTIVE SUMMARY -->
<div class="page">
${pageHdr()}
${secHead('ES','Executive Summary')}
${secCtx('Establishes the macro-opportunity and win-probability. Provides the highest-leverage vector for outbound strategy.')}
<div class="card"><p style="font-size:13px;line-height:1.9">${e(s7.executive_brief||s1.company_overview||'Strategic evaluation of market conditions and buyer readiness.')}</p></div>
<div style="display:flex;gap:4mm;margin-bottom:5mm">
  <div class="card" style="flex:1;text-align:center"><div class="mn">${e(safe(s2.tam_size_estimate)||'N/A')}</div><div class="bl">TAM</div></div>
  <div class="card" style="flex:1;text-align:center"><div class="mn" style="color:var(--green)">${e(safe(s2.growth_rate)||'N/A')}</div><div class="bl">CAGR</div></div>
  <div class="card" style="flex:1;text-align:center"><div class="mn" style="color:var(--amber)">${confScore}/100</div><div class="bl">Relevance</div></div>
  <div class="card" style="flex:1;text-align:center"><div class="mn" style="color:${recColor}">${e(recUp)}</div><div class="bl">Verdict</div></div>
</div>
${srcNote('TAM/CAGR: AI market estimate; Relevance: algorithmic scoring; Verdict: composite signal analysis')}
${callout(s1.gtm_relevance_reasoning||s1.analyst_insight||'')}
${renderPageInsightBlock('executive_summary', strategy, isDemoMode)}
<div style="display:flex;flex-wrap:wrap;gap:3mm;margin-top:5mm">
  <span class="tg green">01 Market</span><span class="tg green">02 TAM</span><span class="tg green">03 ICP</span><span class="tg green">04 Sourcing</span><span class="tg green">05 Keywords</span><span class="tg green">06 Messaging</span><span class="tg amber">07 Revenue Intel</span>
</div>
${pageFtr('Executive Summary',1)}
</div>

<!-- STEP 1: MARKET RESEARCH -->
<div class="page">
${pageHdr()}
${secHead('01','Market Research — The Context')}
${secCtx(s1.section_context||'Deconstructs market positioning and isolates specific macro-triggers.')}
<h3>1.1 · Company Overview</h3>
<div class="card"><p>${e(safe(s1.company_overview)||'—')}</p></div>
<h3>1.2 · Market Position & Stage</h3>
<table class="dt">
${fieldRow('Market Position',s1.market_position)}
${fieldRow('Revenue Stage',s1.revenue_stage)}
${fieldRow('Employee Count',s1.employee_count)}
${fieldRow('Products/Services',s1.products_services)}
</table>
<h3>1.3 · SWOT Analysis</h3>
${swotGrid()}
<h3>1.4 · Strategic Growth Signals</h3>
<div style="margin-bottom:3mm">${tags(s1.growth_signals,'green')}</div>
<h3>1.5 · Tech Stack Indicators</h3>
<div style="margin-bottom:3mm">${tags(s1.tech_stack_hints,'blue')}</div>
${callout(s1.analyst_insight)}
${renderPageInsightBlock('market_research', strategy, isDemoMode)}
${pageFtr('Market Research',2)}
</div>

<!-- STEP 2: TAM MAPPING -->
<div class="page">
${pageHdr()}
${secHead('02','TAM Mapping — The Opportunity')}
${secCtx(s2.section_context||'Quantifies total market velocity and filters it to actionable scope.')}
<h3>2.1 · Market Sizing</h3>
<div style="display:flex;gap:4mm;margin-bottom:5mm">
  <div class="card" style="flex:1;text-align:center"><div class="mn">${e(safe(s2.tam_size_estimate)||'—')}</div><div class="bl">TAM</div></div>
  <div class="card" style="flex:1;text-align:center"><div class="mn" style="color:var(--green)">${e(safe(s2.growth_rate)||'—')}</div><div class="bl">CAGR</div></div>
  <div class="card" style="flex:1;text-align:center">
    ${(()=>{ const mv = safe(s2.market_maturity)||'—'; const isLong = mv.length > 12;
      if (isLong) {
        const parts = mv.split(/\s+with\s+|\s+—\s+|\s*,\s*/i);
        return `<div style="font-size:14px;font-weight:900;font-family:'Space Mono',monospace;color:var(--amber);line-height:1.2">${e(parts[0]||mv)}</div>${parts[1]?`<div style="font-size:9px;color:var(--muted);margin-top:1.5mm;line-height:1.3">${e(parts[1])}</div>`:''}`;
      }
      return `<div class="mn" style="color:var(--amber)">${e(mv)}</div>`;
    })()}
    <div class="bl">Maturity</div>
  </div>
</div>
${srcNote('TAM/CAGR: AI market estimate; Maturity: AI assessment — cross-reference with industry analyst reports')}
<h3>2.2 · Waterfall Logic: TAM → SAM → SOM</h3>
${renderChartOrFallback('TAM Waterfall', charts.waterfall, waterfall(), {width:480,height:180})}
${segTable()}
${s2.priority_opportunities?`<h3>2.4 · Priority Opportunities</h3><div class="card"><p>${e(safe(s2.priority_opportunities))}</p></div>`:''}
${callout(s2.analyst_insight,'amber')}
${renderPageInsightBlock('tam_mapping', strategy, isDemoMode)}
${pageFtr('TAM Analysis',3)}
</div>

<!-- STEP 3: ICP MODELING -->
<div class="page">
${pageHdr()}
${secHead('03','ICP Modeling — The Persona')}
${secCtx(s3.section_context||'Identifies decision-makers and maps operational pain directly to solutions.')}
<h3>3.1 · Primary Persona & Firmographics</h3>
<table class="dt">
${fieldRow('Primary ICP',primaryICP)}
${fieldRow('Secondary ICP',secondaryICP)}
${icpDerived?`<tr><td colspan="2" style="font-size:8px;color:var(--faint);font-style:italic">⚠️ One or more ICP values were derived from decision-maker / industry / trigger data (original was placeholder).</td></tr>`:''}
${fieldRow('Decision Makers',s3.decision_makers)}
${fieldRow('Firmographics',s3.firmographics)}
${fieldRow('Deal Cycle',s3.deal_cycle)}
</table>
<h3>3.2 · Core Pain Points</h3>
<div class="card"><p>${e(safe(s3.core_pain_points)||'—')}</p></div>
<div style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">BUYING TRIGGERS</strong><br>${tags(s3.buying_triggers,'amber')}</div>
<div style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">COMMON OBJECTIONS</strong><br>${tags(s3.objections,'red')}</div>
${painMap()}
${icpRepair()}
${callout(s3.analyst_insight)}
${renderPageInsightBlock('icp_modeling', strategy, isDemoMode)}
${pageFtr('ICP Modeling',4)}
</div>

<div class="page">
${pageHdr()}
${secHead('04','Account Sourcing — The Targets')}
${secCtx(s4.section_context||'Translates persona into actionable technographic filters and sourcing logic.')}
<h3>4.1 · Sourcing Infrastructure</h3>
<table class="dt">
${fieldRow('Recommended Databases',s4.recommended_databases)}
${fieldRow('Estimated Universe',s4.estimated_universe)}
</table>
<h3>4.2 · Filter Criteria</h3>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:2.5mm;margin-bottom:3mm">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:7px;padding:2.5mm 3.5mm">
    <div style="font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm">Include</div>
    <div style="font-size:10px;color:var(--text)">${e(safe(s4.filter_criteria)||'Company size 200–800 employees, B2B revenue operations focus, modern digitization capacity')}</div>
  </div>
  <div style="background:var(--card);border:1px solid rgba(239,68,68,.2);border-radius:7px;padding:2.5mm 3.5mm">
    <div style="font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--red);margin-bottom:1.5mm">Exclude</div>
    <div style="font-size:10px;color:var(--text)">${e(safe(s4.exclusion_criteria)||'Pre-revenue, non-B2B, outside target geography, weak digital presence')}</div>
  </div>
</div>
<h3>4.3 · 3-Step Sourcing Motion</h3>
<div style="display:flex;gap:2.5mm;margin-bottom:3mm">
  ${['Identify','Validate','Prioritize'].map((step,i)=>{
    const descs = [
      safe(s4.sourcing_playbook)||'Build list from Crunchbase, LinkedIn Sales Navigator, ZoomInfo using firmographic filters.',
      'Cross-reference with intent data. Confirm buyer title, tech stack signal, and growth stage.',
      'Score accounts by ICP fit, signal recency, and deal-cycle alignment. Lead with high-fit.'
    ];
    return `<div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 3.5mm;border-top:2.5px solid var(--accent)">
      <div style="display:flex;align-items:center;gap:2mm;margin-bottom:1.5mm">
        <div style="width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,var(--accent2),var(--accent));display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:white;flex-shrink:0">${i+1}</div>
        <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:white">${step}</div>
      </div>
      <div style="font-size:9.5px;color:var(--text);line-height:1.5">${descs[i]}</div>
    </div>`;
  }).join('')}
</div>
${s4.data_enrichment_tips?`<h3>4.4 · Data Enrichment</h3><div class="card"><p>${e(safe(s4.data_enrichment_tips))}</p></div>`:''}
${acctTable()}
${callout(s4.analyst_insight)}
${renderPageInsightBlock('account_sourcing', strategy, isDemoMode)}
${pageFtr('Account Sourcing',5)}
</div>

<!-- STEP 5: KEYWORDS & INTENT -->
<div class="page">
${pageHdr()}
${secHead('05','Keywords & Intent Intelligence')}
${secCtx(s5.section_context||'Maps the semantic footprint before RFP issuance and decodes intent signals.')}
<h3>5.1 · Keyword Arsenal</h3>
<div style="margin-bottom:3mm"><strong style="font-size:9px;color:var(--muted)">PRIMARY KEYWORDS</strong><br>${tags(s5.primary_keywords,'green')}</div>
<div style="margin-bottom:3mm"><strong style="font-size:9px;color:var(--muted)">SECONDARY KEYWORDS</strong><br>${tags(s5.secondary_keywords,'blue')}</div>
${kwTaxonomy()}
${s5.boolean_query?`<h3>5.3 · Boolean Query String</h3><div class="card"><code style="font-family:'Space Mono',monospace;font-size:10px;color:#c4b5fd;word-break:break-all">${e(safe(s5.boolean_query))}</code></div>`:''}
${s5.linkedin_search_strings?`<h3>5.4 · LinkedIn Search String</h3><div class="card"><code style="font-family:'Space Mono',monospace;font-size:10px;color:#93c5fd;word-break:break-all">${e(safe(s5.linkedin_search_strings))}</code></div>`:''}
<div style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">INTENT SIGNALS</strong><br>${tags(s5.intent_signals,'amber')}</div>
${charts.intent
  ? `<div style="margin:3mm 0 5mm"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2mm">INTENT SIGNAL STRENGTH</div>${renderChartOrFallback('Intent Signal', charts.intent, '', {width:480,height:180})}</div>`
  : ''
}
<div style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">CONTENT TOPICS</strong><br>${tags(s5.content_topics,'blue')}</div>
${callout(s5.analyst_insight)}
${renderPageInsightBlock('keywords_intent', strategy, isDemoMode)}
${pageFtr('Keywords & Intent',6)}
</div>

<!-- STEP 6: ENTERPRISE SDR SEQUENCE — PAGE 8: EMAILS -->
<div class="page">
${pageHdr()}
${secHead('06','Enterprise SDR Sequence — The Engagement')}
${secCtx(s6.section_context||'Hyper-targeted sequences designed to agitate pain and validate scalability.')}
<h3>6.1 · 3-Touch Triggered Sequence</h3>
${emailBlock('email_1',0)}
${emailBlock('email_2',1)}
${emailBlock('email_3',2)}
${renderPageInsightBlock('sdr_sequence', strategy, isDemoMode)}
${pageFtr('Engagement Playbook — Emails',7)}
</div>

<!-- STEP 6 CONTINUED — PAGE 9: FOLLOW-UP + LINKEDIN -->
<div class="page">
${pageHdr()}
${secHead('06','Enterprise SDR Sequence — Follow-up & Social')}
${secCtx('Cadence continuation and LinkedIn direct outreach hook.')}
${s6.follow_up_sequence?`<h3>6.2 · Follow-up Cadence</h3><div class="card"><p>${e(safe(s6.follow_up_sequence))}</p></div>`:''}
${s6.linkedin_message?`<h3>6.3 · LinkedIn Hook</h3><div class="card"><p style="font-size:12px"><strong>Direct Message:</strong><br>"${e(safe(s6.linkedin_message))}"</p></div>`:''}
${s6.linkedin_follow_up?`<h3>6.4 · LinkedIn Follow-up</h3><div class="card"><p>${e(safe(s6.linkedin_follow_up))}</p></div>`:''}
${callout(s6.analyst_insight)}
${renderPageInsightBlock('followup_social', strategy, isDemoMode)}
${pageFtr('Engagement Playbook — Cadence',8)}
</div>

<!-- STEP 7: REVENUE INTELLIGENCE — Decision Engine -->
<div class="page">
${pageHdr()}
${decisionEngine()}
${renderPageInsightBlock('decision_engine', strategy, isDemoMode)}
${pageFtr('Revenue Intelligence',9)}
</div>

<!-- STEP 7 CONTINUED: CONFIDENCE MATRIX -->
<div class="page">
${pageHdr()}
${secHead('07','Revenue Intelligence — Confidence Matrix')}
${secCtx('Weighted fidelity assessment of signal quality, market timing, and ICP alignment.')}
<h3>7.6 · Weighted Confidence Matrix</h3>
<div class="confidence-matrix">
${renderChartOrFallback('Confidence Matrix', charts.confidence,
  `<div style="display:flex;gap:6mm;align-items:flex-start">${(()=>{
    const circ=176, filled=Math.round((confScore/100)*circ);
    const gc = confScore>=75?'var(--green)':confScore>=50?'var(--amber)':'var(--red)';
    return `<svg width="90" height="90" viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
      <circle cx="45" cy="45" r="28" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="9"/>
      <circle cx="45" cy="45" r="28" fill="none" stroke="${gc}" stroke-width="9" stroke-dasharray="${filled} ${circ}" stroke-dashoffset="${Math.round(circ*0.25)}" stroke-linecap="round" transform="rotate(-90 45 45)"/>
      <text x="45" y="42" text-anchor="middle" font-family="monospace" font-size="16" font-weight="900" fill="white">${confScore}</text>
      <text x="45" y="54" text-anchor="middle" font-size="6.5" fill="#6B7280" letter-spacing="1">FIDELITY</text>
    </svg><div style="flex:1">${renderConfidenceFallback(veracity,timing,icpFit,completeness,confScore)}</div>`;
  })()}</div>`,
  {width:480, height:200}
)}
</div>
${srcNote('Confidence score is algorithmic — weights fixed (40/25/20/15), capped by data richness')}
${renderPageInsightBlock('confidence_matrix', strategy, isDemoMode)}
${callout(s7.analyst_insight)}
${pageFtr('Revenue Intelligence — Confidence',10)}
</div>

<!-- APPENDIX PAGE 1: A.1-A.4 -->
<div class="page">
${pageHdr()}
${secHead('A','Appendix — Methodology & Data Quality')}
${secCtx('Transparency layer. Documents data provenance, scoring methodology, and known limitations.')}
<div class="appendix-section">
<h3>A.1 · Data Sources</h3>
<table class="dt">
  <tr><th>Data Point</th><th>Source Type</th><th>Reliability</th></tr>
  <tr><td>Company overview, position</td><td>Company website / public data</td><td>High — verify currency</td></tr>
  <tr><td>TAM / SAM / SOM</td><td>AI market estimate</td><td>Medium — cross-ref industry reports</td></tr>
  <tr><td>CAGR / growth rate</td><td>AI market estimate</td><td>Medium — validate with analyst data</td></tr>
  <tr><td>ICP / decision makers</td><td>AI inference from company profile</td><td>Medium — confirm with sales intel</td></tr>
  <tr><td>Buying triggers</td><td>AI inference from market signals</td><td>Medium</td></tr>
  <tr><td>Account targets</td><td>AI-generated analogs (anonymized)</td><td>Low — replace with real pipeline</td></tr>
  <tr><td>Keywords / intent signals</td><td>AI inference from ICP + industry</td><td>Medium</td></tr>
  <tr><td>Email sequences</td><td>AI-generated, personalized</td><td>High — review before sending</td></tr>
  <tr><td>Confidence score</td><td>Algorithmic (capped by data richness)</td><td>High</td></tr>
</table>
</div>
<div class="appendix-section">
<h3>A.2 · TAM Calculation Methodology</h3>
<table class="dt">
  <tr><th>Step</th><th>Method</th></tr>
  <tr><td>1. Global TAM</td><td>AI estimate from industry classification, public market reports, and comparable company analysis</td></tr>
  <tr><td>2. Geography filter</td><td>Uses company-provided geography_eligibility when available; defaults to conservative 60-70%</td></tr>
  <tr><td>3. Service-line fit</td><td>Uses company-provided service_line_fit when available; defaults to conservative 30-40%</td></tr>
  <tr><td>4. Win rate</td><td>Uses company-provided win_rate when available; defaults to 8-12% (enterprise benchmark)</td></tr>
  <tr><td>5. SOM derivation</td><td>Product of steps 1-4; dynamic values override defaults when strategy data provides them</td></tr>
</table>
<h3>A.3 · Key Assumptions</h3>
<table class="dt">
  <tr><th>Assumption</th><th>Default Value</th><th>Override Guidance</th></tr>
  <tr><td>Geography eligibility</td><td>Dynamic when available; else 60-70%</td><td>Auto-populated from strategy.waterfall.geography_eligibility</td></tr>
  <tr><td>Service-line fit</td><td>Dynamic when available; else 30-40%</td><td>Auto-populated from strategy.waterfall.service_line_fit</td></tr>
  <tr><td>Win/capture rate</td><td>Dynamic when available; else 8-12%</td><td>Auto-populated from strategy.waterfall.win_rate</td></tr>
  <tr><td>ICP derivation</td><td>Inferred from decision-makers + industry</td><td>Replace with validated buyer persona research</td></tr>
  <tr><td>Account analogs</td><td>AI-generated archetypes</td><td>Replace with actual target account list from sales</td></tr>
</table>
<h3>A.4 · Confidence Scoring Explanation</h3>
<table class="dt">
  <tr><th>Dimension</th><th>Weight</th><th>Description</th></tr>
  <tr><td>Signal Veracity</td><td class="num">40%</td><td>Density and recency of explicit buying signals observed</td></tr>
  <tr><td>Market Timing</td><td class="num">25%</td><td>Alignment with macro tailwinds, budget cycles, and trigger events</td></tr>
  <tr><td>ICP Fit</td><td class="num">20%</td><td>Firmographic and technographic match against ideal profile</td></tr>
  <tr><td>Data Completeness</td><td class="num">15%</td><td>Depth and quality of source data used in analysis</td></tr>
</table>
<div class="card"><p>The AI confidence score is <strong>hard-capped</strong> by measured data richness. The AI cannot claim higher confidence than the underlying data supports. If data richness = 40, confidence is capped at 40 regardless of AI output.</p></div>
${pageFtr('Appendix — Methodology',11)}
</div>

<!-- APPENDIX PAGE 2: A.5-A.7 -->
<div class="page">
${pageHdr()}
${secHead('A','Appendix — Data Quality & Report Metadata')}
${secCtx('Data quality audit, AI-estimated fields disclaimer, and report metadata.')}
${s7._data_quality?`<h3>A.5 · Data Quality Audit</h3><table class="dt"><tr><th>Metric</th><th>Value</th></tr><tr><td>Data Richness Score</td><td class="num">${s7._data_quality.richness_score||'—'}</td></tr><tr><td>Signals (Pre-filter)</td><td class="num">${s7._data_quality.signals_before_filter||'—'}</td></tr><tr><td>Signals (Post-filter)</td><td class="num">${s7._data_quality.signals_after_filter||'—'}</td></tr><tr><td>AI Confidence (Claimed)</td><td class="num">${s7._data_quality.confidence_ai_claimed||'—'}</td></tr><tr><td>Confidence (After Cap)</td><td class="num">${s7._data_quality.confidence_after_cap||'—'}</td></tr></table>`:''}
<h3>A.6 · AI-Estimated Fields Disclaimer</h3>
<div class="ac amber"><strong>AI-Estimated Content:</strong> The following fields in this report are generated by AI and should be independently validated before use in strategic decisions:<br>
TAM / SAM / SOM sizing and growth rates<br>
Market segment estimates and priorities<br>
ICP persona derivations (when original data was placeholder)<br>
Account target analogs and fit scores<br>
Buying trigger identification and signal strength<br>
Confidence score components<br><br>
All competitive intelligence reflects publicly available data only. Manual validation of exact revenue figures, headcount, and funding data is recommended prior to boardroom presentation.</div>
<h3>A.7 · Report Metadata</h3>
<table class="dt">
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td>Subject Company</td><td>${e(co)}</td></tr>
  ${ind?`<tr><td>Industry</td><td>${e(ind)}</td></tr>`:''}
  <tr><td>Generated</td><td>${date}</td></tr>
  <tr><td>Platform</td><td>ABE Enterprise AI Revenue Infrastructure</td></tr>
  <tr><td>Report Mode</td><td>${isDemoMode ? 'Demo — illustrative only' : 'Live / Realtime'}</td></tr>
  <tr><td>Steps Completed</td><td>${strategy.steps_completed||6}/7</td></tr>
  <tr><td>GTM Relevance Score</td><td>${score}/100</td></tr>
  <tr><td>Confidence Score</td><td>${confScore}/100</td></tr>
  <tr><td>QuickChart Charts</td><td>${[
    charts.gauge?'Gauge':'',charts.waterfall?'Waterfall':'',
    charts.confidence?'Confidence':'',charts.intent?'Intent':'',charts.risk?'Risk':''
  ].filter(Boolean).join(', ')||'Fallback HTML used'}</td></tr>
</table>
<div style="text-align:center;margin-top:8mm;padding-top:5mm;border-top:1px solid var(--border)">
  <div class="am" style="margin:0 auto 3mm;width:28px;height:28px;font-size:9px">ABE</div>
  <p style="font-size:9px;color:var(--faint)">End of Report · ${e(co)} · ${date} · Confidential</p>
</div>
${pageFtr('Appendix — Report Metadata',12)}
</div>

${'</body></html>'}`;
}
