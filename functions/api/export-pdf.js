/**
 * /api/export-pdf  (v6 — Phase 21C: Gotenberg Server-Side PDF + Print Flow Cleanup)
 * Cloudflare Pages Function
 * INPUT:  POST { strategy: { company_name, industry, step_1_market, ... } }
 * OUTPUT: application/pdf (Gotenberg) or JSON { html, filename, mode } (fallback)
 *
 * Env vars:
 *   PDF_RENDER_ENGINE=gotenberg   → enables Gotenberg path
 *   GOTENBERG_URL=https://...     → Gotenberg service base URL
 */
import { verifyAuth, corsHeaders, validate, errRes } from './_middleware.js';
import { normalizeStrategy } from './gtm-intelligence.js';
import { getIntegrationStatus } from './integration-readiness.js';

// ══════════════════════════════════════════════════════════════
// PHASE 21C — GOTENBERG SERVER-SIDE PDF HELPER
// ══════════════════════════════════════════════════════════════

/**
 * renderPdfWithGotenberg(html, filename, env)
 *
 * Sends final report HTML to a Gotenberg Headless Chromium instance.
 * Returns an ArrayBuffer (PDF binary) on success.
 * Throws a clear Error if Gotenberg fails so the caller can fallback.
 *
 * Gotenberg docs: https://gotenberg.dev/docs/routes#html-file-into-pdf
 */
async function renderPdfWithGotenberg(html, filename, env) {
  const gotenbergUrl = env.GOTENBERG_URL.replace(/\/$/, '');
  const endpoint = `${gotenbergUrl}/forms/chromium/convert/html`;

  // Build multipart/form-data body
  const boundary = `----GotenbergBoundary${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();

  // Encode one multipart field (file or string)
  const encodeField = (fieldName, content, mimeType = 'text/html') => {
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fieldName === 'files' ? 'index.html' : fieldName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const footer = '\r\n';
    const headerBytes = encoder.encode(header);
    const contentBytes = typeof content === 'string' ? encoder.encode(content) : content;
    const footerBytes = encoder.encode(footer);
    const combined = new Uint8Array(headerBytes.length + contentBytes.length + footerBytes.length);
    combined.set(headerBytes, 0);
    combined.set(contentBytes, headerBytes.length);
    combined.set(footerBytes, headerBytes.length + contentBytes.length);
    return combined;
  };

  const encodeSimpleField = (name, value) => {
    const str = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    return encoder.encode(str);
  };

  const closingBytes = encoder.encode(`--${boundary}--\r\n`);

  // Gotenberg Chromium route parameters
  // paperWidth/paperHeight in inches (A4 = 8.27 × 11.69)
  const fields = [
    encodeField('files', html, 'text/html'),         // main HTML as index.html
    encodeSimpleField('paperWidth', '8.27'),
    encodeSimpleField('paperHeight', '11.69'),
    encodeSimpleField('marginTop', '0'),
    encodeSimpleField('marginBottom', '0'),
    encodeSimpleField('marginLeft', '0'),
    encodeSimpleField('marginRight', '0'),
    encodeSimpleField('printBackground', 'true'),      // preserve dark backgrounds
    encodeSimpleField('preferCssPageSize', 'true'),    // honour @page CSS
    encodeSimpleField('emulatedMediaType', 'print'),   // use @media print rules
    encodeSimpleField('waitDelay', '1s'),              // allow fonts/charts to load
    closingBytes,
  ];

  // Concatenate all field byte arrays into a single body
  const totalLength = fields.reduce((sum, f) => sum + f.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const f of fields) { body.set(f, offset); offset += f.length; }

  // Send to Gotenberg with a generous but bounded timeout (28s)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 28000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body.buffer,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gotenberg HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const pdfBuffer = await res.arrayBuffer();
  if (!pdfBuffer || pdfBuffer.byteLength < 1000) {
    throw new Error('Gotenberg returned an empty or invalid PDF binary');
  }

  console.info(`[Gotenberg] PDF rendered successfully — ${pdfBuffer.byteLength} bytes for "${filename}"`);
  return pdfBuffer;
}

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

  // ── Phase 21C diagnostic: identify the active export layer before rendering ──
  const url = new URL(request.url);
  const isViewer = url.searchParams.get('mode') === 'viewer';
  const requestedRenderMode = body.renderMode || 'browser-pdf';

  // Gotenberg must never hijack viewer-mode HTML rendering; viewer mode always returns JSON/HTML.
  const useGotenberg = !isViewer && env?.PDF_RENDER_ENGINE === 'gotenberg' && !!env?.GOTENBERG_URL;
  const activeExportPath = isViewer
    ? 'viewer-json-html'
    : useGotenberg
      ? 'gotenberg-application-pdf'
      : 'json-html-fallback';
  console.info(`[PDF Export] active_path=${activeExportPath}; requested_render_mode=${requestedRenderMode}; gotenberg_env=${env?.PDF_RENDER_ENGINE || 'unset'}; viewer=${isViewer}`);

  // ── QuickChart env config ──
  const QC = {
    enabled: (env?.QUICKCHART_ENABLED ?? 'true') !== 'false',
    apiKey: env?.QUICKCHART_API_KEY || '',
    timeout: parseInt(env?.QUICKCHART_TIMEOUT_MS) || 5000,
    maxPer: parseInt(env?.QUICKCHART_MAX_PER_REPORT) || 5,
  };

  // ── Detect demo vs live mode ──
  const isDemoMode = !!(
    strategy.demo_mode || strategy.report_mode === 'demo' ||
    strategy._profile_source === 'demo_mode_simulated' ||
    strategy.step_7_intelligence?.demo_mode ||
    (strategy.step_1_market?.analyst_insight || '').toLowerCase().includes('demo mode')
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
      (gtmScore >= 75 ? 'Go' : gtmScore >= 50 ? 'Watch' : 'No-Go') ||
      (isDemoMode ? 'Watch' : 'Watch');
    const confScore = parseInt(
      s7.confidence_score || s7.overall_fidelity || s7._data_quality?.confidence_after_cap
    ) || gtmScore || (isDemoMode ? 60 : 0);

    const tamRaw = safe_val(s2.tam_size_estimate); const tamNum = parseMoneyValue(tamRaw, isDemoMode ? 1800 : 0);
    const samRaw = safe_val(s2.sam_estimate || s2.waterfall?.sam_value);
    const samNum = samRaw && samRaw !== '—' ? parseMoneyValue(samRaw, tamNum * 0.4) : tamNum * 0.4;
    const somRawVal = safe_val(s2.waterfall?.som_value || '');
    const somIsPercent = somRawVal && /\d+.*%/.test(somRawVal);
    const somNum = (!somRawVal || somIsPercent) ? tamNum * 0.07 : parseMoneyValue(somRawVal, tamNum * 0.07);

    const formatUSD = n => { if (n >= 1000) return `USD ${(n / 1000).toFixed(1).replace(/\.0$/, '')}B`; if (n > 0) return `USD ${Math.round(n)}M`; return 'USD 0'; };
    s2.tam_size_estimate = formatUSD(tamNum);
    s2.sam_estimate = formatUSD(samNum);
    if (!s2.waterfall) s2.waterfall = {};
    s2.waterfall.tam_value = formatUSD(tamNum);
    s2.waterfall.sam_value = formatUSD(samNum);
    s2.waterfall.som_value = formatUSD(somNum);

    // ── Live-mode confidence sub-field extraction ──
    const liveVeracity = safeNumber(s7.signal_veracity || s7.confidence_breakdown?.signal_veracity, 0);
    const liveTiming = safeNumber(s7.market_timing || s7.confidence_breakdown?.market_timing, 0);
    const liveIcpFit = safeNumber(s7.icp_fit || s7.confidence_breakdown?.icp_fit, 0);
    const liveCompleteness = safeNumber(s7.data_completeness || s7.confidence_breakdown?.data_completeness, 0);
    // If live sub-fields exist use them; else derive from confScore weights
    const hasLiveSubs = liveVeracity > 0 || liveTiming > 0 || liveIcpFit > 0 || liveCompleteness > 0;
    const matrixVeracity = hasLiveSubs ? liveVeracity : Math.round(confScore * 0.4);
    const matrixTiming = hasLiveSubs ? liveTiming : Math.round(confScore * 0.25);
    const matrixIcpFit = hasLiveSubs ? liveIcpFit : Math.round(confScore * 0.2);
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
      } catch (err) {
        console.warn(`[QuickChart] ${type} fallback triggered:`, err.message);
        return null;
      }
    };

    const [g, wf, cm] = await Promise.allSettled([
      tryFetch('gauge', buildGtmGaugeChartConfig(gtmScore, verdict), 320, 200),
      tryFetch('waterfall', buildTamWaterfallChartConfig(tamNum, samNum, somNum), 760, 280),
      tryFetch('confidence', buildConfidenceMatrixChartConfig({
        veracity: matrixVeracity, timing: matrixTiming,
        icpFit: matrixIcpFit, completeness: matrixCompleteness,
        overall: confScore
      }), 760, 300),
    ]);
    charts.gauge = g.status === 'fulfilled' ? g.value : null;
    charts.waterfall = wf.status === 'fulfilled' ? wf.value : null;
    charts.confidence = cm.status === 'fulfilled' ? cm.value : null;

    // ── Optional mini charts (max 2 additional calls) ──
    const _s5 = strategy.step_5_keywords || strategy.steps?.[5] || {};
    const _arr = v => Array.isArray(v) ? v : (v ? [String(v)] : []);
    const intentSignals = _arr(_s5?.intent_signals || _s5?.intent_topics || []);
    const intentItems = intentSignals.slice(0, 4).map((s, i) => ({
      label: typeof s === 'string' ? s : (s.signal || s.label || `Signal ${i + 1}`),
      strength: typeof s === 'object' && s.strength ? s.strength : [72, 58, 65, 50][i] || 60
    }));
    const [intent, risk] = await Promise.allSettled([
      tryFetch('intent', buildIntentSignalChartConfig(intentItems), 480, 180),
      tryFetch('risk', buildRiskSeverityChartConfig(verdict, gtmScore), 480, 180),
    ]);
    charts.intent = intent.status === 'fulfilled' ? intent.value : null;
    charts.risk = risk.status === 'fulfilled' ? risk.value : null;
    console.info(`[QuickChart] total calls=${chartCount}/${QC.maxPer} gauge=${!!charts.gauge} waterfall=${!!charts.waterfall} confidence=${!!charts.confidence} intent=${!!charts.intent} risk=${!!charts.risk}`);
  }

  const filename = `GTM_${strategy.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  // When Gotenberg is active, always generate with 'gotenberg' renderMode so print CSS applies correctly.
  // Viewer mode is deliberately excluded above and keeps browser-safe HTML.
  const renderMode = useGotenberg ? 'gotenberg' : requestedRenderMode;
  const integration = getIntegrationStatus(env);
  const html = buildReportHTML(strategy, charts, isDemoMode, renderMode, isViewer);

  // ── Phase 21C: Gotenberg path ──────────────────────────────────────────
  if (useGotenberg) {
    try {
      const pdfBuffer = await renderPdfWithGotenberg(html, filename, env);
      return new Response(pdfBuffer, {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
          'X-ABE-PDF-Engine': 'gotenberg',
          'X-ABE-Export-Path': activeExportPath,
        },
      });
    } catch (gotenbergErr) {
      console.warn('[Gotenberg] Failed — returning JSON fallback:', gotenbergErr.message);
      const fallbackHtml = buildReportHTML(strategy, charts, isDemoMode, 'browser-pdf', isViewer);
      return new Response(
        JSON.stringify({
          html: fallbackHtml,
          filename,
          mode: 'browser-pdf',
          active_export_path: 'gotenberg_failed_json_html_fallback',
          integration_status: integration,
          pdf_fallback: 'gotenberg_failed',
          pdf_fallback_reason: gotenbergErr.message,
        }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'X-ABE-PDF-Engine': 'json-fallback', 'X-ABE-Export-Path': 'gotenberg_failed_json_html_fallback' } }
      );
    }
  }

  // ── Default JSON/html fallback (Gotenberg disabled or viewer mode) ────────────────────
  return new Response(JSON.stringify({ html, filename, mode: renderMode, active_export_path: activeExportPath, integration_status: integration }), {
    status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'X-ABE-PDF-Engine': isViewer ? 'viewer-html' : 'json-fallback', 'X-ABE-Export-Path': activeExportPath },
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
  const s = String(str).replace(/,/g, '').toUpperCase();
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
  const safeNum = v => { const n = Number(v); return (Number.isFinite(n) && n > 0) ? Math.round(n) : 0; };
  const values = [safeNum(tamM), safeNum(samM), safeNum(somM)];
  const maxVal = Math.max(100, ...values) * 1.22;
  const fmt = v => { const n = Number(v) || 0; if (n >= 1000) return 'USD ' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'B'; if (n > 0) return 'USD ' + Math.round(n) + 'M'; return 'USD 0'; };
  const somPct = values[0] > 0 ? Math.round((values[2] / values[0]) * 100) : 0;
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
          formatter: function (v) {
            var n = Number(v) || 0;
            if (n >= 1000) return 'USD ' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'B';
            if (n >= 1) return 'USD ' + Math.round(n) + 'M';
            return n > 0 ? 'USD ' + n : 'USD 0';
          },
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
  const safe = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0; };
  const toPercent = (sc, max) => safe(Math.round((sc / max) * 100));
  const values = [
    toPercent(veracity, 40),
    toPercent(timing, 25),
    toPercent(icpFit, 20),
    toPercent(completeness, 15),
    safe(overall),
  ];
  const overallColor = values[4] >= 75 ? '#22c55e' : values[4] >= 50 ? '#f59e0b' : '#ef4444';
  const bgColors = ['#7c3aed', '#8b5cf6', '#6366f1', '#a78bfa', overallColor];
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
          color: function (ctx) { return ctx.dataIndex === 4 ? '#ffffff' : 'rgba(255,255,255,0.85)'; },
          font: function (ctx) { return { size: ctx.dataIndex === 4 ? 12 : 10, weight: '700', family: 'monospace' }; },
          anchor: 'end', align: 'right', offset: 4,
          formatter: function (v, ctx) {
            if (ctx.dataIndex === 4) return v + '/100';
            return v + '%';
          },
        },
        annotation: {
          annotations: {
            weakLine: {
              type: 'line',
              xMin: 50, xMax: 50,
              borderColor: 'rgba(245,158,11,0.35)', borderWidth: 1.5, borderDash: [3, 3],
              label: {
                enabled: true, content: 'Validate', position: 'start',
                backgroundColor: 'rgba(245,158,11,0.08)', color: '#f59e0b',
                font: { size: 8, weight: '600' }, padding: { x: 4, y: 2 }, yAdjust: -14,
              },
            },
            strongLine: {
              type: 'line',
              xMin: 75, xMax: 75,
              borderColor: 'rgba(34,197,94,0.30)', borderWidth: 1.5, borderDash: [3, 3],
              label: {
                enabled: true, content: 'Strong', position: 'start',
                backgroundColor: 'rgba(34,197,94,0.08)', color: '#22c55e',
                font: { size: 8, weight: '600' }, padding: { x: 4, y: 2 }, yAdjust: -14,
              },
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true, min: 0, max: 110,
          ticks: { color: '#9CA3AF', font: { size: 9 }, callback: v => v <= 100 ? v + '%' : '' },
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

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

async function fetchQuickChartBase64(config, width, height, qc, chartType = 'default') {
  const versionMap = { gauge: ['4', '3'], waterfall: ['3', '4'], confidence: ['4', '3'], intent: ['4', '3'], risk: ['4', '3'] };
  const versions = versionMap[chartType] || ['4', '3'];
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
        throw new Error(`QuickChart HTTP ${res.status}: ${errBody.slice(0, 80)}`);
      }
      const buf = await res.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
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
  const color = /^go$/i.test(verdict) ? 'var(--green)' : /no/i.test(verdict) ? 'var(--red)' : 'var(--amber)';
  const circ = 157, filled = Math.round((score / 100) * circ);
  return `<svg width="130" height="80" viewBox="0 0 130 80" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="gaugeGrad2" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="${color}"/></linearGradient></defs>
    <path d="M 15 72 A 50 50 0 0 1 115 72" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8" stroke-linecap="round"/>
    <path d="M 15 72 A 50 50 0 0 1 115 72" fill="none" stroke="url(#gaugeGrad2)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${filled} ${circ}"/>
    <text x="65" y="65" text-anchor="middle" font-family="monospace" font-size="22" font-weight="900" fill="white">${score}</text>
    <text x="65" y="78" text-anchor="middle" font-family="sans-serif" font-size="7" fill="#6B7280" letter-spacing="1.5">GTM SCORE</text>
  </svg>`;
}

function renderWaterfallFallback(tamV, samV, somV) {
  const bar = (label, val, w, cls) => `<div style="display:flex;align-items:center;margin-bottom:3mm">
    <div style="width:100px;font-family:monospace;font-size:10px;text-align:right;padding-right:3mm;color:white;font-weight:700">${val}</div>
    <div style="flex:1;background:rgba(255,255,255,.08);border-radius:6px;height:14px;overflow:hidden">
      <div style="height:100%;border-radius:6px;width:${w}" class="${cls}"></div>
    </div>
    <span style="margin-left:2mm;font-size:9px;color:#6B7280">${label}</span>
  </div>`;
  return `<div style="margin:3mm 0">
    ${bar('TAM', tamV, '80%', 'wfb')}${bar('SAM', samV, '50%', 'wfa')}${bar('SOM', somV, '20%', 'wfm')}
  </div>`;
}

function renderConfidenceFallback(v, t, f, c, overall) {
  const cmBar = (label, sc, max) => `<div style="margin-bottom:3.5mm">
    <div style="display:flex;justify-content:space-between;margin-bottom:1.5mm">
      <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#6B7280">${label}</span>
      <span style="font-family:monospace;font-size:11px;font-weight:900;color:#a855f7">${sc}<span style="font-size:8px;font-weight:400;color:#6B7280">/${max}</span></span>
    </div>
    <div style="background:rgba(255,255,255,.07);border-radius:5px;height:9px;overflow:hidden">
      <div style="height:100%;border-radius:5px;background:linear-gradient(90deg,#7c3aed,#a855f7);width:${Math.round((sc / max) * 100)}%;min-width:3px"></div>
    </div>
  </div>`;
  return cmBar('Signal Veracity (40%)', v, 40) + cmBar('Market Timing (25%)', t, 25) + cmBar('ICP Fit (20%)', f, 20) + cmBar('Data Completeness (15%)', c, 15) +
    `<div style="border-top:1px solid rgba(168,85,247,.2);margin:3mm 0"></div>` +
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
  const items = (Array.isArray(signals) && signals.length >= 2) ? signals.slice(0, 4) : defaults;
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
          formatter: function (v) { return v + '%'; },
        },
      },
      scales: {
        x: {
          beginAtZero: true, min: 0, max: 110,
          ticks: { color: '#6B7280', font: { size: 8 }, callback: v => v <= 100 ? v + '%' : '' },
          grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false }
        },
        y: {
          ticks: { color: '#E5E7EB', font: { size: 9, weight: '600' }, autoSkip: false, maxRotation: 0 },
          grid: { display: false }
        }
      },
    }
  };
}

function buildRiskSeverityChartConfig(verdict, score) {
  const cycle = score >= 75 ? 35 : score >= 50 ? 65 : 85;
  const lock = score >= 75 ? 40 : score >= 50 ? 60 : 75;
  const budget = score >= 75 ? 45 : score >= 50 ? 65 : 80;
  const compete = score >= 75 ? 50 : score >= 50 ? 55 : 70;
  return {
    type: 'bar',
    data: {
      labels: ['Decision Cycle', 'Vendor Lock-in', 'Budget Friction', 'Competitive Pressure'],
      datasets: [{
        data: [cycle, lock, budget, compete],
        backgroundColor: [
          cycle >= 70 ? '#ef4444' : cycle >= 50 ? '#f59e0b' : '#22c55e',
          lock >= 70 ? '#ef4444' : lock >= 50 ? '#f59e0b' : '#22c55e',
          budget >= 70 ? '#ef4444' : budget >= 50 ? '#f59e0b' : '#22c55e',
          compete >= 70 ? '#ef4444' : compete >= 50 ? '#f59e0b' : '#22c55e',
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
          formatter: function (v) { return v >= 70 ? 'High' : v >= 50 ? 'Med' : 'Low'; },
        },
        annotation: {
          annotations: {
            highThreshold: {
              type: 'line', xMin: 70, xMax: 70,
              borderColor: 'rgba(239,68,68,0.3)', borderWidth: 1, borderDash: [3, 3],
            },
          },
        },
      },
      scales: {
        x: { beginAtZero: true, min: 0, max: 110, display: false },
        y: {
          ticks: { color: '#E5E7EB', font: { size: 9, weight: '600' }, autoSkip: false, maxRotation: 0 },
          grid: { display: false }
        }
      },
    }
  };
}

// ══════════════════════════════════════════════════════════════
// STRING / RENDER HELPERS
// ══════════════════════════════════════════════════════════════

function isBadVisibleValue(value) {
  if (value === null || value === undefined) return true;
  const raw = String(value).trim();
  if (!raw) return true;
  // Dash-only cells should not be considered bad — they are valid empty indicators
  // but we do catch hard bad values below
  return /^(undefined|null|nan|infinity|-infinity|\[object object\])$/i.test(raw);
}

// ── Placeholder repair: [HName] → greeting, [Your Name] → AB Enterprise Team ──
function repairTemplatePlaceholders(text) {
  return String(text)
    .replace(/\[Name\]/gi, '{{First Name}}')
    .replace(/\[HName\]/gi, 'Hi {{First Name}}')
    .replace(/\[Your Name\]/gi, 'AB Enterprise Team')
    .replace(/\[First Name\]/gi, '{{First Name}}')
    .replace(/\[Company\]/gi, '{{Company}}');
}

// ── Dash-only table cell detection ──
function isDashOnly(cell) {
  if (!cell && cell !== 0) return true;
  const stripped = String(cell).replace(/<[^>]*>/g, '').trim();
  return /^[-–—\s]+$/.test(stripped);
}

// ── Merged/run-on list repair ──
// Handles three cases:
//   1. Known GTM merged phrases (phrase map — most reliable)
//   2. camelCase boundary: pipelineUnpredictability → pipeline Unpredictability
//   3. lowercase-run-on: "pipelineunpredictabilityforecast" — split on known GTM tokens
const GTM_PHRASE_MAP = [
  ['pipelineunpredictability', 'pipeline unpredictability'],
  ['forecastmiss', 'forecast miss'],
  ['forecastmisses', 'forecast misses'],
  ['salesexecutiongap', 'sales execution gap'],
  ['salesexecutiongaps', 'sales execution gaps'],
  ['revenueoperations', 'revenue operations'],
  ['commercialperformance', 'commercial performance'],
  ['forecastreliability', 'forecast reliability'],
  ['buyerresearch', 'buyer research'],
  ['buyerresearchactivity', 'buyer research activity'],
  ['decisionmakeroutreach', 'decision-maker outreach'],
  ['increaseindecisionmaker', 'increase in decision-maker'],
  ['icpfit', 'ICP fit'],
  ['gonogovalidation', 'go/no-go validation'],
  ['gtmscore', 'GTM score'],
  ['tamsize', 'TAM size'],
  ['marketmaturity', 'market maturity'],
  ['signalveracity', 'signal veracity'],
  ['markettiming', 'market timing'],
  ['datacompleteness', 'data completeness'],
  ['winrate', 'win rate'],
  ['dealmotions', 'deal motions'],
  ['accountsourcing', 'account sourcing'],
  ['buyertrigger', 'buyer trigger'],
  ['buyingtrigger', 'buying trigger'],
  ['painsolution', 'pain → solution'],
];

function repairMergedList(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  // Pass 1: known phrase map (case-insensitive)
  for (const [merged, repaired] of GTM_PHRASE_MAP) {
    const re = new RegExp(merged, 'gi');
    t = t.replace(re, repaired);
  }
  // Pass 2: camelCase boundary (e.g. "pipelineUnpredictability" → "pipeline Unpredictability")
  t = t.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');
  // Pass 3: lowercase run-on with duplicate word detection — insert separator before repeated patterns
  // e.g. "forecast missesales" → "forecast miss · sales"
  t = t.replace(/([a-z]{4,})(sales|forecast|pipeline|revenue|decision|buyer|account|market|signal|intent|outreach|sourcing|execution|operations|performance|reliability|validation)/gi,
    (_, a, b) => `${a} · ${b}`);
  return t.replace(/\s{2,}/g, ' ').trim();
}

// ── safeArray(value, fallback) ──
// Normalizes any input into a clean string array.
// - Arrays: filtered and items repaired
// - Comma/semicolon strings: split
// - Objects: values extracted
// - Bad values: return fallback
// Never joins without separator. Never produces run-on text.
function safeArray(value, fallback = []) {
  if (value === null || value === undefined) return fallback;
  let items;
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'object') {
    items = Object.values(value);
  } else {
    const str = String(value).trim();
    if (!str) return fallback;
    // Split on common list separators
    if (str.includes(';')) {
      items = str.split(/\s*;\s*/);
    } else if (str.includes(',')) {
      items = str.split(/\s*,\s*/);
    } else if (str.includes('\n')) {
      items = str.split(/\n+/);
    } else {
      items = [str];
    }
  }
  const cleaned = items
    .map(v => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? Object.values(v).join(', ') : String(v).trim();
      return repairTemplatePlaceholders(repairMergedList(s));
    })
    .filter(v => v && !/^(undefined|null|nan|infinity|\[object object\]|[-–—\s]+)$/i.test(v));
  return cleaned.length ? cleaned : fallback;
}

function normalizeBusinessFallback(fallback = 'strategic market growth') {
  return isBadVisibleValue(fallback) ? 'strategic market growth' : String(fallback).trim();
}

function repairFloatArtifacts(text) {
  return String(text).replace(/\b-?\d+\.\d{6,}\b/g, (match) => {
    const n = Number(match);
    if (!Number.isFinite(n)) return '0';
    const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
    return String(rounded);
  });
}

function safeBusinessText(value, fallback = 'strategic market growth') {
  if (isBadVisibleValue(value)) return normalizeBusinessFallback(fallback);
  let text;
  if (Array.isArray(value)) {
    text = value.filter(v => !isBadVisibleValue(v)).map(v => safeBusinessText(v, '')).filter(Boolean).join(', ');
  } else if (typeof value === 'object') {
    text = Object.values(value).filter(v => !isBadVisibleValue(v)).map(v => safeBusinessText(v, '')).filter(Boolean).join(', ');
  } else {
    text = String(value);
  }
  text = repairFloatArtifacts(text)
    .replace(/focused on\s+(undefined|null|nan|\[object Object\])/gi, 'focused on strategic market growth')
    .replace(/\b(undefined|null|NaN|Infinity|-Infinity|\[object Object\])\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Repair template placeholders and merged lists
  text = repairTemplatePlaceholders(text);
  text = repairMergedList(text);
  return text || normalizeBusinessFallback(fallback);
}

function formatBusinessNumber(value, type = 'number', fallback = '—') {
  if (isBadVisibleValue(value)) return fallback;
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(numeric)) return fallback;
  if (type === 'currency') return formatCurrency(numeric, fallback);
  if (type === 'percent') return formatPercent(numeric, fallback);
  const rounded = Math.abs(numeric) >= 100 ? Math.round(numeric) : Math.round(numeric * 100) / 100;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rounded);
}

function formatCurrency(value, fallback = 'USD 0') {
  if (isBadVisibleValue(value)) return fallback;
  const numeric = typeof value === 'number' ? value : parseMoneyValue(String(value), NaN);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  // Avoid raw float artifacts like 126.00000000000001
  const millions = numeric > 1000000 ? numeric / 1000000 : numeric;
  const cleanM = Math.round(millions * 100) / 100; // max 2dp, strips float noise
  if (cleanM >= 1000) return `USD ${(cleanM / 1000).toFixed(1).replace(/\.0$/, '')}B`;
  if (cleanM >= 1) return `USD ${Math.round(cleanM)}M`;
  if (cleanM > 0) return `USD ${cleanM.toString()}M`;
  return fallback;
}

function formatPercent(value, fallback = '—') {
  if (isBadVisibleValue(value)) return fallback;
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(numeric)) return fallback;
  const pct = Math.abs(numeric) <= 1 && !String(value).includes('%') ? numeric * 100 : numeric;
  if (!Number.isFinite(pct) || Math.abs(pct) > 10000) return fallback;
  return `${Math.round(pct * 10) / 10}%`.replace('.0%', '%');
}

// ── removeInvalidVisibleTokens: strip bare placeholder tokens that slip through other passes ──
function removeInvalidVisibleTokens(text) {
  return String(text)
    // Remove bare undefined/null/nan/object tokens not already caught
    .replace(/\b(undefined|null|NaN|Infinity|-Infinity)\b/g, '')
    .replace(/\[object Object\]/gi, '')
    // Collapse any double spaces left behind
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeVisibleHtml(html) {
  if (!html) return '';
  // Pass 1: float artifact repair
  let out = repairFloatArtifacts(String(html));
  // Pass 2: template placeholder repair ([HName], [Your Name], etc.)
  out = repairTemplatePlaceholders(out);
  // Pass 3: merged-list / camelCase run-on repair
  // Only applied to text nodes — skip tag attributes by targeting >…< spans
  out = out.replace(/>([^<]+)</g, (m, txt) => '>' + repairMergedList(txt) + '<');
  // Pass 4: remove residual invalid visible tokens
  out = removeInvalidVisibleTokens(
    out
      .replace(/focused on\s*(undefined|null|NaN|\[object Object\])/gi, 'focused on strategic market growth')
      .replace(/>\s*(undefined|null|NaN|Infinity|-Infinity|\[object Object\])\s*</gi, '>—<')
      .replace(/\b(undefined|null|NaN|Infinity|-Infinity|\[object Object\])\b/g, 'strategic market growth')
      .replace(/(USD\s+)USD\s+/g, '$1')
      .replace(/\s+([,.;:])/g, '$1')
      // Remove table rows where ALL cells are dash-only (—, –, -, &mdash;, &ndash;)
      .replace(/<tr[^>]*>(\s*<t[dh][^>]*>\s*(?:—|–|-|&mdash;|&ndash;)\s*<\/t[dh]>\s*)+<\/tr>/gi, '')
  );
  return out;
}

function escapeHtml(value, fallback = '') {
  return safeBusinessText(value, fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateWords(text, limit = 70) {
  const words = safeBusinessText(text, '').trim().split(/\s+/).filter(Boolean);
  return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}...`;
}

function safeText(value, fallback = '') {
  return safeBusinessText(value, fallback);
}

// ══════════════════════════════════════════════════════════════
// PHASE 20C — VISUAL REPORT COMPONENTS
// Pure, stateless helpers. Safe for both browser-pdf and viewer.
// All output is sanitized via escapeHtml / safeBusinessText.
// ══════════════════════════════════════════════════════════════

/**
 * renderKpiCard(label, value, opts)
 * @param {string} label  - Uppercase display label
 * @param {string} value  - Metric value (already formatted)
 * @param {{ color?, sub?, flex? }} opts
 * Returns a single KPI tile <div>.
 */
function renderKpiCard(label, value, { color = 'var(--accent)', sub = '', flex = '1', icon = '' } = {}) {
  const safeVal = safeBusinessText(value, '—');
  const safeLabel = escapeHtml(label, 'Metric');
  const safeSub = sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : '';
  const iconHtml = icon ? `<div style="position:absolute;top:3mm;right:4mm;color:${color};opacity:0.4">${icon}</div>` : '';
  return `<div class="kpi-card" style="flex:${flex};border-bottom:3px solid ${color};position:relative">
    ${iconHtml}
    <div class="kpi-value" style="color:${color}">${safeVal}</div>
    <div class="kpi-label">${safeLabel}</div>
    ${safeSub}
  </div>`;
}

/**
 * renderMetricStrip(cards, wrapClass)
 * @param {Array<{label,value,opts}>} cards  - Array of card configs
 * @param {string} wrapClass                 - Extra class on the row wrapper
 * Renders a flex row of KPI cards inside .kpi-strip.
 */
function renderMetricStrip(cards, wrapClass = '') {
  if (!Array.isArray(cards) || !cards.length) return '';
  const inner = cards.map(c => renderKpiCard(c.label, c.value, c.opts || {})).join('');
  return `<div class="kpi-strip keep-together ${wrapClass}">${inner}</div>`;
}

/**
 * renderInsightBox(title, body, opts)
 * @param {string} title
 * @param {string} body
 * @param {{ accent?, cls? }} opts
 * Returns a styled insight callout block.
 */
function renderInsightBox(title, body, { accent = 'var(--accent)', cls = '' } = {}) {
  if (!body) return '';
  const safeTitle = escapeHtml(title, 'Insight');
  const safeBody = safeBusinessText(body, '');
  return `<div class="insight-box ${cls}" style="border-left:3px solid ${accent};background:linear-gradient(90deg, rgba(168,85,247,.08), transparent);position:relative">
    <div style="position:absolute;top:8px;right:8px;color:${accent};opacity:0.15"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></div>
    <div class="insight-box__title" style="color:${accent}">${safeTitle}</div>
    <div class="insight-box__body">${safeBody}</div>
  </div>`;
}

const renderPageFooter = (label, num) => `
<div class="pf-wrap" style="margin-top:auto;padding-top:2.5mm;break-before:avoid;page-break-before:avoid">
  <div class="pf-tagline" style="text-align:center;margin-bottom:2mm;font-style:italic;color:#FFFFFF;font-size:10px;letter-spacing:.04em;opacity:1">Plan with clarity. Build with intent. Grow through trust.</div>
  <div class="pf" style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.28);padding-top:2mm;font-size:10px;color:#FFFFFF;font-weight:700;opacity:1">
    <span style="flex:1;text-align:left;font-weight:900;color:#FFFFFF">ABE Platform</span>
    <span style="flex:2;text-align:center;text-transform:uppercase;letter-spacing:.1em;color:#FFFFFF">${escapeHtml(label)}</span>
    <span style="flex:1;text-align:right;color:#FFFFFF">Page ${num}</span>
  </div>
</div>`;

const SVG_MAP = {
  'gauge': '<circle cx="12" cy="12" r="10"/><path d="m12 14 4-4"/><path d="M12 14v6"/><path d="M7.34 7.34 5.93 5.93"/><path d="M16.66 7.34l1.41-1.41"/>',
  'target': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'calendar': '<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  'clipboard-check': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  'triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>',
  'sparkles': '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>',
  'compass': '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  'route': '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  'bar-chart': '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  'user-check': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
  'filter': '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'mail': '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'trophy': '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2-1 4-2 7-2 2.5 0 4.5 1 6 2a1 1 0 0 1 1 1z"/>',
  'checklist': '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/><path d="m9 15 2 2 4-4"/>',
  'cpu': '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'brain': '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'
};

const renderSvgIcon = (name, size = 16, color = 'currentColor') => {
  const paths = SVG_MAP[name] || SVG_MAP['grid'];
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle">${paths}</svg>`;
};

const renderStatusBadge = (value) => {
  const label = safeBusinessText(value, 'Pending Validation') || 'Pending Validation';
  const raw = label.toLowerCase();
  const color = /critical|high risk|high/.test(raw) ? 'var(--red)'
    : /low risk|low|validated|approved/.test(raw) ? 'var(--green)'
    : /medium|watch|pending|requires|estimate|validation/.test(raw) ? 'var(--amber)'
    : 'var(--accent)';
  return `<span class="status-pill" style="display:inline-flex;align-items:center;gap:1mm;padding:1mm 2.4mm;border-radius:999px;border:1px solid ${color};background:${color}22;color:${color};font-size:9.5px;font-weight:800;white-space:nowrap">${escapeHtml(label, 'Pending Validation')}</span>`;
};

const SECTION_ICONS = {
  ES: 'gauge', RS: 'compass', MD: 'grid', FW: 'calendar',
  BC: 'users', SF: 'filter', RM: 'clipboard-check', DT: 'triangle',
  PI: 'sparkles', MO: 'route', ME: 'calendar', KF: 'search',
  '01': 'search', '02': 'bar-chart', '03': 'user-check', '04': 'target',
  '05': 'search', '06': 'mail', CL: 'trophy', RW: 'trophy',
  P5: 'shield', CA: 'cpu', RR: 'alert-triangle', '07': 'brain',
  A: 'file-text'
};

const renderPageHeader = (sectionCode, title, subtitle, iconName) => {
  const icon = renderSvgIcon(iconName, 18, 'white');
  return `
    <div class="keep-together" style="margin-bottom:5mm;padding-bottom:3mm;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:4mm">
      <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent2),var(--accent));display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(168,85,247,.2);flex-shrink:0">
        ${icon}
      </div>
      <div>
        <div style="font-size:9px;color:var(--accent);letter-spacing:.12em;text-transform:uppercase;font-weight:800;margin-bottom:0.5mm">Section ${escapeHtml(sectionCode)}</div>
        <h2 style="font-size:18px;font-weight:800;color:white;margin:0;line-height:1.2;border:none;padding:0">${escapeHtml(title)}</h2>
        ${subtitle ? `<div style="font-size:9.5px;color:var(--muted);margin-top:1mm">${escapeHtml(subtitle)}</div>` : ''}
      </div>
    </div>
  `;
};

const renderVisualCallout = (type, title, body, iconName) => {
  const accent = type === 'amber' ? 'var(--amber)' : type === 'red' ? 'var(--red)' : 'var(--accent)';
  return renderInsightBox(title, body, { accent, icon: renderSvgIcon(iconName || 'sparkles', 24, accent) });
};

const renderExecutiveTakeaway = (title, body, iconName) => {
  return renderInsightBox(title, body, { accent: 'var(--blue)', cls: 'exec-takeaway', icon: renderSvgIcon(iconName || 'target', 24, 'var(--blue)') });
};

const renderIconMetric = (label, value, iconName, status) => {
  const color = status === 'High' || status === 'Critical' ? 'var(--red)' : status === 'Low' || status === 'Validated' ? 'var(--green)' : 'var(--amber)';
  return renderKpiCard(label, value, { color, icon: renderSvgIcon(iconName || 'bar-chart', 16, color) });
};

/**
 * renderSectionHeader(num, title, icon)
 * Thin wrapper so Phase 20C callers can use the canonical name.
 * Delegates to the internal secHead() inside buildReportHTML but
 * provides a standalone version for contexts outside that scope.
 */
function renderSectionHeader(num, title, icon = '') {
  const iconHtml = icon ? `<span style="margin-right:2mm">${icon}</span>` : num;
  return `<h2 class="section-header"><span class="sa" style="background:linear-gradient(135deg,var(--accent2),var(--accent))">${iconHtml}</span> ${escapeHtml(title)}</h2>`;
}

/**
 * renderFigureCaption(caption, source)
 * Renders a standardised figure caption + source attribution line.
 */
function renderFigureCaption(caption, source = 'ABE GTMS Engine v1.0') {
  if (!caption) return '';
  return `<p class="figure-caption">${escapeHtml(caption)}</p>
  <p class="figure-source">Source: ${escapeHtml(source)}</p>`;
}

/**
 * renderValidationNote(text, level)
 * @param {string} text
 * @param {'info'|'warn'|'error'} level
 * Returns a small validation note banner.
 */
function renderValidationNote(text, level = 'info') {
  if (!text) return '';
  const colors = { info: 'var(--accent)', warn: 'var(--amber)', error: 'var(--red)' };
  const color = colors[level] || colors.info;
  return `<div class="validation-note" style="border-left:3px solid ${color};color:${color}">${escapeHtml(text)}</div>`;
}

/**
 * renderSegmentationGrid(segments)
 * @param {Array<{dimension,items,primaryFit,secondaryFit,status}>} segments
 * Renders a 20E segmentation framework grid.
 */
function renderSegmentationGrid(segments) {
  if (!Array.isArray(segments) || !segments.length) return '';
  const rows = segments.map(seg => {
    const dim    = escapeHtml(seg.dimension  || 'Segment',              'Segment');
    const items  = safeBusinessText(seg.items       || 'Validation pending', '');
    const pFit   = escapeHtml(seg.primaryFit  || 'Requires source validation');
    const sFit   = escapeHtml(seg.secondaryFit || 'Requires source validation');
    const rawSt  = seg.status || 'Validation pending';
    const stColor = /validated/i.test(rawSt) ? 'var(--green)' : /partial/i.test(rawSt) ? 'var(--amber)' : 'var(--muted)';
    const st     = escapeHtml(rawSt);
    return `<tr>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${dim}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${items}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${pFit}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:#8b5cf6">${sFit}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:${stColor};font-style:italic">${st}</td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:22%">Dimension</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:28%">Segments / Items</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:18%">Primary Fit</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:18%">Secondary Fit</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:14%">Validation Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * renderTriangulationGrid(pillars)
 * @param {Array<{title,score,status,items}>} pillars
 * Renders the 20F data triangulation layout.
 */
function renderTriangulationGrid(pillars) {
  if (!Array.isArray(pillars) || !pillars.length) return '';
  return `<div class="triangulation-grid keep-together">
    ${pillars.map(p => {
      const color = /validated/i.test(p.status) ? 'var(--green)' : /estimate/i.test(p.status) ? 'var(--amber)' : 'var(--red)';
      return `<div class="triangulation-card" style="border-top:3px solid ${color}">
        <div class="triangulation-header">
          <div class="triangulation-title">${escapeHtml(p.title)}</div>
          <div class="triangulation-score" style="color:${color}">${escapeHtml(p.score)}</div>
        </div>
        <div class="triangulation-status" style="color:${color}">${escapeHtml(p.status)}</div>
        <ul class="triangulation-items">
          ${p.items.map(item => `<li>${safeBusinessText(item, 'Requires validation')}</li>`).join('')}
        </ul>
      </div>`;
    }).join('')}
  </div>`;
}

/**
 * renderMethodologyLedger(rows)
 * @param {Array<{category,dataUsed,notValidated}>} rows
 * Renders the 20F methodology breakdown.
 */
function renderMethodologyLedger(rows) {
  if (!Array.isArray(rows)) return '';
  const trs = rows.map((r, i) => {
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    return `<tr style="background:${bg}">
    <td style="border:.5px solid #444;border-left:2px solid var(--accent);padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${renderSvgIcon('search', 10, 'var(--accent)')} &nbsp; ${escapeHtml(r.category)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--text)">${safeBusinessText(r.dataUsed, 'Validation pending')}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber);font-style:italic">${safeBusinessText(r.notValidated, 'Validation pending')}</td>
  </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:25%">Evidence Pillar</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:40%">Data Used (Verified)</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:9px;width:35%">Unvalidated / Excluded</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </div>`;
}

/**
 * renderTruthLedgerSummary(metrics)
 * @param {{richness,freshness,risk,priority}} metrics
 * Renders the 20F Truth Ledger block.
 */
function renderTruthLedgerSummary(m) {
  return `<div class="truth-ledger keep-together">
    <div class="truth-ledger-row"><div class="truth-ledger-label">Source Richness</div><div class="truth-ledger-val">${escapeHtml(m.richness)}</div></div>
    <div class="truth-ledger-row"><div class="truth-ledger-label">Signal Freshness</div><div class="truth-ledger-val">${escapeHtml(m.freshness)}</div></div>
    <div class="truth-ledger-row"><div class="truth-ledger-label">Assumption Risk</div><div class="truth-ledger-val" style="color:var(--amber)">${escapeHtml(m.risk)}</div></div>
    <div class="truth-ledger-row"><div class="truth-ledger-label">Validation Priority</div><div class="truth-ledger-val" style="color:var(--red)">${escapeHtml(m.priority)}</div></div>
  </div>`;
}

/**
 * renderSegmentOpportunityTable(segments)
 * @param {Array<{segment,size,growth,urgency,fit,priority,status}>} segments
 */
function renderSegmentOpportunityTable(segments) {
  if (!Array.isArray(segments) || !segments.length) return '';
  const rows = segments.map(s => `<tr>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;font-weight:700;color:var(--accent)">${escapeHtml(s.segment)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${escapeHtml(s.size)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${escapeHtml(s.growth)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${escapeHtml(s.urgency)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${escapeHtml(s.fit)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber);font-weight:700">${escapeHtml(s.priority)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:var(--muted);font-style:italic">${escapeHtml(s.status)}</td>
  </tr>`).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:18%">Segment</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:14%">Est. Size</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:14%">Growth Signal</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:14%">Buyer Urgency</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:14%">Fit Score</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:12%">Priority</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:14%">Validation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function _cleanICP(val) {
  if (!val || typeof val !== 'string') return 'Requires source validation';
  const clean = String(val).trim();
  if (/^(unknown|persona|secondary|N\/A|none|-|—|undefined|null|\[object Object\])$/i.test(clean)) return 'Requires source validation';
  return clean;
}

function renderIcpProfileGrid(icp) {
  if (!icp) return '';
  return `<div class="icp-grid keep-together">
    <div class="icp-card" style="border-top:3px solid var(--accent)">
      <div class="icp-label">Primary ICP</div>
      <div class="icp-value">${_cleanICP(safeBusinessText(icp.primary, 'Requires source validation'))}</div>
    </div>
    <div class="icp-card" style="border-top:3px solid var(--blue)">
      <div class="icp-label">Secondary ICP</div>
      <div class="icp-value">${_cleanICP(safeBusinessText(icp.secondary, 'Requires source validation'))}</div>
    </div>
    <div class="icp-card" style="border-top:3px solid var(--green)">
      <div class="icp-label">Firmographics</div>
      <div class="icp-value">${_cleanICP(safeBusinessText(icp.firmographics, 'Requires source validation'))}</div>
    </div>
    <div class="icp-card" style="border-top:3px solid var(--amber)">
      <div class="icp-label">Technographics</div>
      <div class="icp-value">${_cleanICP(safeBusinessText(icp.technographics, 'Requires source validation'))}</div>
    </div>
  </div>`;
}

function renderBuyingCommitteeTable(roles) {
  if (!Array.isArray(roles) || !roles.length) return '';
  const rows = roles.map(r => `<tr>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;font-weight:700;color:var(--accent)">${escapeHtml(r.role)}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${_cleanICP(safeBusinessText(r.title, 'Requires source validation'))}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--text)">${safeBusinessText(r.focus, 'Validation pending')}</td>
    <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--text)">${safeBusinessText(r.proof, 'Validation pending')}</td>
  </tr>`).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:18%">Committee Role</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:25%">Target Title</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:30%">Messaging Focus</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:27%">Proof Required</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderAccountSourcingFunnel(funnel) {
  if (!funnel) return '';
  return `<div class="sourcing-funnel keep-together">
    <div class="funnel-tier" style="border-left:3px solid var(--accent)">
      <div class="funnel-label">Tier 1: High Fit, Active Intent</div>
      <div class="funnel-value">${safeBusinessText(funnel.tier1, 'Requires source validation')}</div>
    </div>
    <div class="funnel-tier" style="border-left:3px solid var(--green)">
      <div class="funnel-label">Tier 2: High Fit, Latent Need</div>
      <div class="funnel-value">${safeBusinessText(funnel.tier2, 'Requires source validation')}</div>
    </div>
    <div class="funnel-tier" style="border-left:3px solid var(--amber)">
      <div class="funnel-label">Watchlist: Trigger Dependent</div>
      <div class="funnel-value">${safeBusinessText(funnel.watchlist, 'Requires source validation')}</div>
    </div>
  </div>`;
}

function renderAccountTierCards(acts) {
  const t1 = acts[0] || 'Requires source validation';
  const t2 = acts[1] || 'Requires source validation';
  const t3 = acts[2] || 'Requires source validation';
  return `<div class="tier-cards keep-together">
    <div class="tier-card" style="border-left:3px solid var(--accent)">
      <div class="tier-title">Tier 1 Example</div>
      <div class="tier-body">${_cleanICP(safeBusinessText(t1, 'Requires source validation'))}</div>
    </div>
    <div class="tier-card" style="border-left:3px solid var(--green)">
      <div class="tier-title">Tier 2 Example</div>
      <div class="tier-body">${_cleanICP(safeBusinessText(t2, 'Requires source validation'))}</div>
    </div>
    <div class="tier-card" style="border-left:3px solid var(--amber)">
      <div class="tier-title">Watchlist Example</div>
      <div class="tier-body">${_cleanICP(safeBusinessText(t3, 'Requires source validation'))}</div>
    </div>
  </div>`;
}

/**
 * renderDrocGrid(droc)
 * @param {{drivers,restraints,opportunities,challenges}} droc
 * Renders the 20H Market Overview DROC breakdown.
 */
function renderDrocGrid(droc) {
  if (!droc) return '';
  const rows = [
    { cat: 'Drivers', items: droc.drivers || [], color: 'var(--green)' },
    { cat: 'Restraints', items: droc.restraints || [], color: 'var(--red)' },
    { cat: 'Opportunities', items: droc.opportunities || [], color: 'var(--accent)' },
    { cat: 'Challenges', items: droc.challenges || [], color: 'var(--amber)' }
  ];
  return `<div class="droc-grid keep-together">
    ${rows.map(r => `<div class="droc-card" style="border-top:3px solid ${r.color}">
      <div class="droc-title" style="color:${r.color}">${escapeHtml(r.cat)}</div>
      <ul class="droc-items">
        ${r.items.length ? r.items.map(item => `<li><strong>${escapeHtml(item.title)}:</strong> ${safeBusinessText(item.explanation)} <span style="display:block;margin-top:2px;font-style:italic;color:var(--muted)">Implication: ${safeBusinessText(item.implication)}</span></li>`).join('') : '<li style="font-style:italic;color:var(--muted)">Requires source validation</li>'}
      </ul>
    </div>`).join('')}
  </div>`;
}

/**
 * renderMarketEvolutionTimeline(stages)
 * @param {Array<{name,change,implication,relevance}>} stages
 * Renders the 20H Market Evolution Timeline.
 */
function renderMarketEvolutionTimeline(stages) {
  if (!Array.isArray(stages) || !stages.length) return '';
  return `<div class="evolution-timeline keep-together">
    ${stages.map((stage, i) => `<div class="evolution-stage">
      <div class="evolution-node">${i + 1}</div>
      <div class="evolution-content">
        <div class="evolution-name">${escapeHtml(stage.name)}</div>
        <div class="evolution-change"><strong>Shift:</strong> ${safeBusinessText(stage.change, 'Validation pending')}</div>
        <div class="evolution-implication"><strong>Impact:</strong> ${safeBusinessText(stage.implication, 'Validation pending')}</div>
        <div class="evolution-relevance" style="color:var(--accent)"><strong>Current Relevance:</strong> ${safeBusinessText(stage.relevance, 'Validation pending')}</div>
      </div>
    </div>`).join('')}
  </div>`;
}

/**
 * renderKeyFindingsGrid(findings)
 * @param {Array<{label,value,color}>} findings
 * Renders the 20H Key Findings overview.
 */
function renderKeyFindingsGrid(findings) {
  if (!Array.isArray(findings) || !findings.length) return '';
  return `<div class="findings-grid keep-together">
    ${findings.map(f => `<div class="findings-card" style="border-left:3px solid ${f.color || 'var(--border)'}">
      <div class="findings-label">${escapeHtml(f.label)}</div>
      <div class="findings-value">${safeBusinessText(f.value, 'Validation pending')}</div>
    </div>`).join('')}
  </div>`;
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
  const primary = safeText(s3.primary_icp);
  switch (pageKey) {
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
// CONTEXTUAL FILLER — Educational Insights for short PDF pages
// Shown at bottom of each page via margin-top:auto (flex column).
// Fills blank space without cluttering content-rich pages.
// ══════════════════════════════════════════════════════════════

const EDU_INSIGHTS = {
  exec: {
    term: 'GTM Score — How It\'s Calculated',
    definition: 'The GTM Relevance Score (0–100) is a composite signal derived from four weighted dimensions: signal veracity (40%), market timing (25%), ICP fit (20%), and data completeness (15%). The score is hard-capped by data richness — AI cannot claim higher confidence than the evidence supports.',
    points: ['≥ 75 = GO — strong alignment, initiate outbound now', '50–74 = WATCH — monitor for catalyst event before committing', '< 50 = NO-GO — re-evaluate in 90 days or on trigger', 'Score is directional, not a guarantee — validate with pipeline data'],
    proTip: 'Treat the GTM Score as a prioritisation signal, not a verdict. A score of 72 earns a WATCH, not a GO — the next deal stage requires human validation of the weakest sub-score dimension.',
  },
  market: {
    term: 'SWOT — How to Action Each Quadrant',
    definition: 'A SWOT is only useful if each quadrant drives a specific GTM motion. Strengths anchor your messaging. Weaknesses pre-empt objections before the prospect raises them. Opportunities frame urgency in outreach. Threats build risk narratives that justify budget.',
    points: ['Strengths → lead your email subject line with the proof point', 'Weaknesses → address proactively in the demo, not reactively', 'Opportunities → "your competitors are already doing this" framing', 'Threats → quantify the cost of inaction to drive urgency'],
    proTip: 'Run your SWOT through a messaging filter: for each quadrant, write one sentence you\'d say to the prospect. If you can\'t, the SWOT entry is too abstract to be useful.',
  },
  tam: {
    term: 'TAM · SAM · SOM — The Three Numbers That Matter',
    definition: 'TAM is the total global opportunity if you had 100% share. SAM is the portion reachable by your current product and geography. SOM is the realistic slice you can close in 12–24 months given your win rate and capacity.',
    points: ['TAM = market size; SAM = addressable scope; SOM = your pipeline ceiling', 'SOM = TAM × geo eligibility × service-line fit × win rate', 'AI estimates TAM from public market data — cross-reference reports', 'Use SOM to set outbound targets; use TAM to frame investor decks'],
    proTip: 'CROs and investors care about SOM, not TAM. Always ground your pipeline forecast in SOM × CAGR and be ready to defend every multiplier with company-specific data.',
  },
  icp: {
    term: 'ICP vs Buyer Persona — Key Distinction',
    definition: 'An ICP (Ideal Customer Profile) defines the type of company most likely to buy, expand, and refer — firmographics, revenue band, tech stack, geography. A Buyer Persona defines the individual within that company who initiates, evaluates, or signs. You need both to run effective outbound.',
    points: ['ICP = the account filter (company fit)', 'Persona = the contact filter (person within that account)', 'Wrong ICP = wasted SDR cycles on unwinnable accounts', 'Wrong persona = right company, wrong door — longer sales cycle'],
    proTip: 'Your ICP should disqualify as aggressively as it qualifies. A tight ICP shrinks your universe but dramatically improves reply rates, close rates, and NRR.',
  },
  sourcing: {
    term: 'Account Sourcing — Three-Tier Prioritisation',
    definition: 'Not all accounts in your SAM deserve equal SDR effort. Tier 1 (Dream 100): manually curated, maximum effort. Tier 2 (Scaled Outbound): ICP-matched but lower intent — sequence-driven. Tier 3 (Programmatic): broad awareness plays, content and paid channels only.',
    points: ['Tier 1: ≤ 100 accounts — personalised 1:1 outreach', 'Tier 2: 100–500 accounts — personalised sequences, lighter research', 'Tier 3: 500+ accounts — automated, minimal personalisation', 'Enrich every Tier 1 account with a recent trigger event before touching'],
    proTip: 'Enrich each sourced account with at least two contact-level signals — a job-change alert and a content-engagement event — before your first outreach touch. Cold + no signal = noise.',
  },
  keywords: {
    term: 'Intent Signal Taxonomy — Funnel Mapping',
    definition: 'A structured map of the language buyers use at each funnel stage. Early funnel: problem-definition language ("how to reduce X"). Mid funnel: category language ("best tools for X"). Late funnel: vendor language (branded terms, pricing pages, G2 reviews).',
    points: ['Early funnel signals → top-of-funnel content and paid', 'Mid funnel signals → competitive positioning and comparison content', 'Late funnel signals → direct outbound, trials, demo requests', 'Intent signals precede RFPs — act before competitors know they\'re looking'],
    proTip: 'Mirror late-funnel keywords in your email subject lines. Subject lines that use the buyer\'s own language ("pipeline unpredictability" vs "improve sales") achieve 2–3× higher open rates.',
  },
  sdr: {
    term: 'SDR Sequence — The 3:1 Value-to-Ask Ratio',
    definition: 'The biggest sequencing mistake is pitching on every touch. High-performing sequences alternate between giving value (insight, data, proof) and asking for a micro-commitment (briefing, feedback, reply). The ratio should be 3:1 in favour of value.',
    points: ['Touch 1: personalised insight referencing a specific trigger event', 'Touch 2: hard ROI metric — quantify the cost of the problem', 'Touch 3: social proof — a case study or data point from a similar account', 'Touch 4: permission-based break-up — low-friction re-engagement ask'],
    proTip: 'A permission-based break-up ("should I close your file?") often generates more replies than the first three touches combined. People respond to closure more than to pitches.',
  },
  decision: {
    term: 'Go / Watch / No-Go — What Happens Next',
    definition: 'The Go/Watch/No-Go verdict is a resource allocation decision, not a rejection. GO accounts get immediate SDR outreach and AE involvement. WATCH accounts enter a 60-day monitoring sequence with trigger-based re-entry. NO-GO accounts get parked with a 90-day nurture.',
    points: ['GO: assign an AE, start the 3-touch sequence within 48h', 'WATCH: set a CRM trigger for leadership change, funding, or compliance event', 'NO-GO: add to a low-frequency nurture — one touchpoint every 6 weeks', 'Re-score any account when a material trigger event occurs'],
    proTip: 'Build a 90-day automated nurture for every NO-GO account. Most NO-GOs become GO accounts within 12 months when their situation changes — the cost of re-entry is near zero if you\'ve maintained light contact.',
  },
  confidence: {
    term: 'Confidence Matrix — Reading the Sub-Scores',
    definition: 'The weighted fidelity matrix breaks the overall confidence score into four independent dimensions. Signal Veracity (40%) measures the density and recency of explicit buying signals. Market Timing (25%) measures macro alignment. ICP Fit (20%) measures firmographic match. Data Completeness (15%) measures source quality.',
    points: ['Signal Veracity < 50%: insufficient buying signals — monitor longer', 'Market Timing < 50%: macro conditions not aligned — revisit in 60 days', 'ICP Fit < 50%: account may be outside core persona — de-prioritise', 'Data Completeness < 50%: report based on limited data — validate manually'],
    proTip: 'Focus research effort on the LOWEST sub-score, not the highest. Improving the weakest dimension from 40% to 60% moves the overall score more than improving a strong dimension from 80% to 90%.',
  },
};

function buildFillerBlock(key, renderMode) {
  // Edu-filler only works inside a fixed-height flex page (html2canvas mode).
  // In browser-pdf mode sections flow naturally — no fixed container to push into.
  // In gotenberg mode the CSS already hides .edu-filler via display:none, but
  // skip generation entirely to avoid DOM clutter and save render time.
  if (renderMode === 'browser-pdf') return '';
  if (renderMode === 'gotenberg') return '';
  if (renderMode !== 'html2canvas') return '';
  const ins = EDU_INSIGHTS[key];
  if (!ins) return '';
  const pts = (ins.points || []).map(p =>
    `<li>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</li>`
  ).join('');
  const safe = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div class="edu-filler">
    <div class="edu-filler__badge">📖 Glossary &amp; Pro-Tips</div>
    <div class="edu-filler__term">${safe(ins.term)}</div>
    <div class="edu-filler__definition">${safe(ins.definition)}</div>
    ${pts ? `<ul class="edu-filler__points">${pts}</ul>` : ''}
    ${ins.proTip ? `<div class="edu-filler__protip"><strong>Pro Tip:</strong> ${safe(ins.proTip)}</div>` : ''}
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// PHASE 20K — COMPETITIVE INTELLIGENCE HELPERS
// Pure, stateless. Safe for both browser-pdf and viewer modes.
// Data sourced from strategy.competitive_landscape (optional).
// Falls back to 'Requires source validation' on any missing field.
// ══════════════════════════════════════════════════════════════

/**
 * renderCompetitorCategoryTable(competitors)
 * @param {Array<{name,category,strength,weakness,threat_level,notes}>} competitors
 * Renders the Competitor Category Table.
 */
function renderCompetitorCategoryTable(competitors) {
  if (!Array.isArray(competitors) || !competitors.length) {
    return `<div class="validation-note" style="border-left:3px solid var(--muted);color:var(--muted);padding:4px 8px;font-size:9px;margin:3mm 0">
      No competitor data provided — add competitors to the <code>competitive_landscape.competitors</code> field.
    </div>`;
  }
  const THREAT_COLOR = { High: 'var(--red)', Medium: 'var(--amber)', Low: 'var(--green)' };
  const rows = competitors.map(c => {
    const threatRaw  = safeBusinessText(c.threat_level || 'Medium', 'Medium');
    const threatTrim = /^(high|medium|low)$/i.test(threatRaw.trim()) ? threatRaw.trim() : 'Medium';
    const threatKey  = threatTrim.charAt(0).toUpperCase() + threatTrim.slice(1).toLowerCase();
    const threatColor = THREAT_COLOR[threatKey] || 'var(--amber)';
    return `<tr>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${escapeHtml(c.name, 'Unknown')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${escapeHtml(c.category, 'Uncategorised')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${safeBusinessText(c.strength, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${safeBusinessText(c.weakness, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;font-weight:700;color:${threatColor}">${escapeHtml(threatKey)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:var(--muted);font-style:italic">${safeBusinessText(c.notes, '—')}</td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:18%">Competitor</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:16%">Category</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:18%">Key Strength</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:18%">Key Weakness</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:12%">Threat Level</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:18%">Notes</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * renderRightToWinTable(dimensions)
 * @param {Array<{dimension,our_advantage,competitor_gap,win_condition,confidence}>} dimensions
 * Renders the Right-to-Win analysis table.
 */
function renderRightToWinTable(dimensions) {
  if (!Array.isArray(dimensions) || !dimensions.length) {
    return `<div class="validation-note" style="border-left:3px solid var(--muted);color:var(--muted);padding:4px 8px;font-size:9px;margin:3mm 0">
      No right-to-win data provided — add dimensions to <code>competitive_landscape.right_to_win</code>.
    </div>`;
  }
  const CONF_COLOR = { High: 'var(--green)', Medium: 'var(--amber)', Low: 'var(--red)' };
  const rows = dimensions.map((d, i) => {
    const confRaw   = safeBusinessText(d.confidence || 'Medium', 'Medium');
    const confTrim  = /^(high|medium|low)$/i.test(confRaw.trim()) ? confRaw.trim() : 'Medium';
    const confKey   = confTrim.charAt(0).toUpperCase() + confTrim.slice(1).toLowerCase();
    const confColor = CONF_COLOR[confKey] || 'var(--amber)';
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;border-left:2px solid ${confColor};padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${renderSvgIcon('trophy', 10, 'var(--accent)')} &nbsp; ${escapeHtml(d.dimension, 'Dimension')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${safeBusinessText(d.our_advantage, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${safeBusinessText(d.competitor_gap, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${safeBusinessText(d.win_condition, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;font-weight:700;color:${confColor};text-align:center"><span style="background:${confColor}22;padding:1px 4px;border-radius:3px">${escapeHtml(confKey)}</span></td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:20%">Win Dimension</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:25%">Our Advantage</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:25%">Competitor Gap</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:20%">Win Condition</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8.5px;width:10%">Confidence</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * render2x2EvalMatrix(accounts)
 * @param {Array<{name,quadrant,fit_score,urgency,rationale}>} accounts
 * Renders a 2x2 Account Evaluation Matrix.
 * Quadrant values (case-insensitive):
 *   'strategic'   → Strategic Accounts     (top-left: High Fit / High Urgency)
 *   'emerging'    → Emerging Opportunities  (top-right: Low Fit / High Urgency)
 *   'watchlist'   → Watchlist Accounts      (bottom-left: High Fit / Low Urgency)
 *   'low-fit'     → Low-Fit / Defer         (bottom-right: Low Fit / Low Urgency)
 */
function render2x2EvalMatrix(accounts) {
  const QUADRANTS = [
    { key: 'strategic',  label: 'Strategic Accounts',      sub: 'High Fit · High Urgency',   color: 'var(--green)',  bg: 'rgba(34,197,94,.06)',   border: 'rgba(34,197,94,.25)'  },
    { key: 'emerging',   label: 'Emerging Opportunities',  sub: 'Lower Fit · High Urgency',  color: 'var(--accent)', bg: 'rgba(168,85,247,.06)',  border: 'rgba(168,85,247,.25)' },
    { key: 'watchlist',  label: 'Watchlist Accounts',      sub: 'High Fit · Lower Urgency',  color: 'var(--amber)',  bg: 'rgba(245,158,11,.06)',  border: 'rgba(245,158,11,.25)' },
    { key: 'low-fit',    label: 'Low-Fit / Defer',         sub: 'Low Fit · Low Urgency',     color: 'var(--red)',    bg: 'rgba(239,68,68,.06)',   border: 'rgba(239,68,68,.25)'  },
  ];
  const normalise = s => String(s || '').toLowerCase().replace(/[\s_]+/g, '-').replace('deferred', 'low-fit').replace('defer', 'low-fit').replace('low_fit', 'low-fit');
  const grouped = {};
  QUADRANTS.forEach(q => { grouped[q.key] = []; });

  if (Array.isArray(accounts)) {
    accounts.forEach(a => {
      const qKey = normalise(a.quadrant);
      const match = QUADRANTS.find(q => q.key === qKey) ? qKey : 'watchlist';
      grouped[match].push(a);
    });
  }

  const cells = QUADRANTS.map(q => {
    const items = grouped[q.key];
    const itemsHtml = items.length
      ? items.map(a => `<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:5px;padding:3px 5px;margin-bottom:2px">
          <div style="font-size:9px;font-weight:700;color:white">${escapeHtml(a.name || 'Account')}</div>
          ${a.fit_score ? `<div style="font-size:8px;color:var(--muted)">Fit: <span style="color:${q.color};font-weight:700">${escapeHtml(String(a.fit_score))}</span>${a.urgency ? ` · Urgency: ${escapeHtml(String(a.urgency))}` : ''}</div>` : ''}
          ${a.rationale ? `<div style="font-size:7.5px;color:var(--muted);font-style:italic;margin-top:1px">${safeBusinessText(a.rationale, '').slice(0,80)}</div>` : ''}
        </div>`).join('')
      : `<div style="font-size:8px;color:var(--muted);font-style:italic;padding:4px 0">No accounts assigned</div>`;
    return `<div style="background:${q.bg};border:1px solid ${q.border};border-radius:8px;padding:5px 6px;min-height:50px">
      <div style="font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:${q.color};margin-bottom:1mm">${escapeHtml(q.label)}</div>
      <div style="font-size:7.5px;color:var(--muted);margin-bottom:2mm">${escapeHtml(q.sub)}</div>
      ${itemsHtml}
    </div>`;
  });

  return `<div class="keep-together" style="margin:3mm 0">
    <div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto auto;gap:3mm">
      ${cells.join('')}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:2mm">
      <span style="font-size:7.5px;color:var(--muted);font-style:italic">← Lower Fit</span>
      <span style="font-size:7.5px;color:var(--muted);font-style:italic">Higher Fit →</span>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// PHASE 20L — PORTER'S FIVE FORCES & BUYING CRITERIA HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * renderPorterForcesGrid(forces)
 * @param {Array<{force,rating,explanation,gtm_implication,recommended_action,validation_status}>} forces
 * Renders Porter's Five Forces in the GTM lens grid layout.
 * rating: 'Low' | 'Medium' | 'High'
 */
function renderPorterForcesGrid(forces) {
  const RATING_COLOR = { High: 'var(--red)', Medium: 'var(--amber)', Low: 'var(--green)' };
  const RATING_BG    = { High: 'rgba(239,68,68,.06)', Medium: 'rgba(245,158,11,.06)', Low: 'rgba(34,197,94,.06)' };
  const RATING_BORDER= { High: 'rgba(239,68,68,.25)',  Medium: 'rgba(245,158,11,.25)', Low: 'rgba(34,197,94,.25)' };

  const normaliseRating = raw => {
    const s = String(raw || '').trim();
    if (/^high$/i.test(s))   return 'High';
    if (/^low$/i.test(s))    return 'Low';
    return 'Medium';
  };

  if (!Array.isArray(forces) || !forces.length) {
    return `<div class="validation-note" style="border-left:3px solid var(--muted);color:var(--muted);padding:4px 8px;font-size:9px;margin:3mm 0">
      No Porter force data provided — add forces to <code>strategy_context.porter_forces</code>.
    </div>`;
  }

  const cards = forces.map(f => {
    const rating  = normaliseRating(f.rating);
    const color   = RATING_COLOR[rating]  || 'var(--amber)';
    const bg      = RATING_BG[rating]     || RATING_BG.Medium;
    const border  = RATING_BORDER[rating] || RATING_BORDER.Medium;
    const valStatus = safeBusinessText(f.validation_status, 'Validation pending');
    const valColor  = /validated/i.test(valStatus) ? 'var(--green)' : /partial/i.test(valStatus) ? 'var(--amber)' : 'var(--muted)';
    return `<div style="background:${bg};border:1px solid ${border};border-left:3px solid ${color};border-radius:8px;padding:5px 7px;break-inside:avoid;position:relative">
      <div style="position:absolute;top:4px;right:4px;color:${color};opacity:0.2"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2mm;padding-right:18px">
        <div style="font-size:9.5px;font-weight:800;color:var(--text)">${escapeHtml(f.force, 'Force')}</div>
        <span style="font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;background:${color}22;color:${color};white-space:nowrap">${escapeHtml(rating)}</span>
      </div>
      <div style="font-size:8.5px;color:var(--text);margin-bottom:1.5mm"><strong>Analysis:</strong> ${safeBusinessText(f.explanation, 'Requires source validation')}</div>
      <div style="font-size:8.5px;color:var(--accent);margin-bottom:1.5mm"><strong>GTM Implication:</strong> ${safeBusinessText(f.gtm_implication, 'Validation pending')}</div>
      <div style="font-size:8.5px;color:var(--green);margin-bottom:1.5mm"><strong>Recommended Action:</strong> ${safeBusinessText(f.recommended_action, 'Validation pending')}</div>
      <div style="font-size:7.5px;color:${valColor};font-style:italic;display:inline-block;border:1px solid ${valColor}40;padding:1px 4px;border-radius:2px;background:rgba(0,0,0,0.2)">Validation: ${escapeHtml(valStatus)}</div>
    </div>`;
  });

  return `<div class="keep-together" style="display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:3mm 0">
    ${cards.join('')}
  </div>`;
}

/**
 * renderBuyingCriteriaTable(criteria)
 * @param {Array<{criteria,buyer_concern,importance,proof_required,gtm_message,recommended_action,validation_status}>} criteria
 * Renders the Buying Criteria Matrix table.
 * importance: 'Critical' | 'High' | 'Medium' | 'Low'
 */
function renderBuyingCriteriaTable(criteria) {
  const IMP_COLOR = { Critical: 'var(--red)', High: 'var(--accent)', Medium: 'var(--amber)', Low: 'var(--muted)' };
  const normaliseImp = raw => {
    const s = String(raw || '').trim();
    if (/^critical$/i.test(s)) return 'Critical';
    if (/^high$/i.test(s))     return 'High';
    if (/^low$/i.test(s))      return 'Low';
    return 'Medium';
  };

  if (!Array.isArray(criteria) || !criteria.length) {
    return `<div class="validation-note" style="border-left:3px solid var(--muted);color:var(--muted);padding:4px 8px;font-size:9px;margin:3mm 0">
      No buying criteria data — add rows to <code>strategy_context.buying_criteria</code>.
    </div>`;
  }

  const rows = criteria.map((c, i) => {
    const imp      = normaliseImp(c.importance);
    const impColor = IMP_COLOR[imp] || 'var(--amber)';
    const bg       = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    const valStatus = safeBusinessText(c.validation_status, 'Validation pending');
    const valColor  = /validated/i.test(valStatus) ? 'var(--green)' : /partial/i.test(valStatus) ? 'var(--amber)' : 'var(--muted)';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;border-left:2px solid ${impColor};padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${renderSvgIcon('users', 10, 'var(--accent)')} &nbsp; ${escapeHtml(c.criteria, 'Criteria')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${safeBusinessText(c.buyer_concern, 'Requires source validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;font-weight:700;color:${impColor};text-align:center"><span style="background:${impColor}22;padding:1px 4px;border-radius:3px">${escapeHtml(imp)}</span></td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${safeBusinessText(c.proof_required, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${safeBusinessText(c.gtm_message, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${safeBusinessText(c.recommended_action, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:${valColor};font-style:italic"><span style="border:1px solid ${valColor}40;padding:1px 3px;border-radius:2px;display:inline-block">${escapeHtml(valStatus)}</span></td>
    </tr>`;
  }).join('');

  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:12%">Criteria</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:17%">Buyer Concern</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:center;border:.5px solid #444;padding:5px 6px;font-size:8px;width:10%">Importance</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:17%">Proof Required</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:17%">GTM Message</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:17%">Recommended Action</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:10%">Validation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// PHASE 20M — CAPABILITY & REGULATORY RISK HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * renderCapabilityLandscape(capabilities)
 * @param {Array<{group,capability,buyer_value,maturity_signal,gtm_implication,validation_status}>} capabilities
 * Renders the Technology / Capability Analysis grid.
 * group: 'Core' | 'Complementary' | 'Adjacent'
 */
function renderCapabilityLandscape(capabilities) {
  const GROUP_COLOR  = { Core: 'var(--accent)', Complementary: 'var(--green)', Adjacent: 'var(--blue)' };
  const GROUP_BG     = { Core: 'rgba(168,85,247,.07)', Complementary: 'rgba(34,197,94,.06)', Adjacent: 'rgba(59,130,246,.06)' };
  const GROUP_BORDER = { Core: 'rgba(168,85,247,.25)',  Complementary: 'rgba(34,197,94,.25)', Adjacent: 'rgba(59,130,246,.25)' };

  const normaliseGroup = raw => {
    const s = String(raw || '').trim();
    if (/^core$/i.test(s))          return 'Core';
    if (/^complementary$/i.test(s)) return 'Complementary';
    return 'Adjacent';
  };

  if (!Array.isArray(capabilities) || !capabilities.length) {
    return `<div class="validation-note" style="border-left:3px solid var(--muted);color:var(--muted);padding:4px 8px;font-size:9px;margin:3mm 0">
      No capability data — add rows to <code>strategy_context.capabilities</code>.
    </div>`;
  }

  const rows = capabilities.map((c, i) => {
    const group   = normaliseGroup(c.group);
    const color   = GROUP_COLOR[group]  || 'var(--accent)';
    const bg      = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    const valStatus = safeBusinessText(c.validation_status, 'Validation pending');
    const valColor  = /validated/i.test(valStatus) ? 'var(--green)' : /partial/i.test(valStatus) ? 'var(--amber)' : 'var(--muted)';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;border-left:2px solid ${color};padding:5px 6px;font-size:9px;vertical-align:top;font-weight:700;color:${color}">${renderSvgIcon('cpu', 10, color)} &nbsp; ${escapeHtml(group)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--text)">${escapeHtml(c.capability, 'Capability')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${safeBusinessText(c.buyer_value, 'Requires source validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${safeBusinessText(c.maturity_signal, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--accent)">${safeBusinessText(c.gtm_implication, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:${valColor};font-style:italic"><span style="border:1px solid ${valColor}40;padding:1px 3px;border-radius:2px;display:inline-block">${escapeHtml(valStatus)}</span></td>
    </tr>`;
  }).join('');

  // Render a summary strip showing how many of each group exist
  const groups = ['Core', 'Complementary', 'Adjacent'];
  const countStrip = groups.map(g => {
    const n = capabilities.filter(c => normaliseGroup(c.group) === g).length;
    const color  = GROUP_COLOR[g];
    const bg     = GROUP_BG[g];
    const border = GROUP_BORDER[g];
    return `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:3mm 4mm;text-align:center;flex:1">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:${color}">${n}</div>
      <div style="font-size:8px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:1mm">${g}</div>
    </div>`;
  }).join('');

  return `<div class="keep-together" style="display:flex;gap:3mm;margin-bottom:4mm">${countStrip}</div>
  <div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:14%">Group</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:18%">Capability</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Buyer Value</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:16%">Maturity Signal</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">GTM Implication</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:12%">Validation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * renderRegulatoryRiskTable(risks)
 * @param {Array<{risk_area,buyer_concern,gtm_impact,mitigation_message,required_proof,validation_status}>} risks
 * Renders the Regulatory & Risk Landscape table.
 * No fake legal claims. All values fallback to 'Validation pending'.
 */
function renderRegulatoryRiskTable(risks) {
  if (!Array.isArray(risks) || !risks.length) {
    return `<div class="validation-note" style="border-left:3px solid var(--muted);color:var(--muted);padding:4px 8px;font-size:9px;margin:3mm 0">
      No regulatory/risk data — add rows to <code>strategy_context.regulatory_risks</code>.
    </div>`;
  }

  const rows = risks.map((r, i) => {
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    const valStatus = safeBusinessText(r.validation_status, 'Validation pending');
    const valColor  = /validated/i.test(valStatus) ? 'var(--green)' : /partial/i.test(valStatus) ? 'var(--amber)' : 'var(--muted)';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;border-left:2px solid var(--accent);padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${renderSvgIcon('alert-triangle', 10, 'var(--accent)')} &nbsp; ${escapeHtml(r.risk_area, 'Risk Area')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${safeBusinessText(r.buyer_concern, 'Requires source validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${safeBusinessText(r.gtm_impact, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${safeBusinessText(r.mitigation_message, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${safeBusinessText(r.required_proof, 'Validation pending')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:${valColor};font-style:italic"><span style="border:1px solid ${valColor}40;padding:1px 3px;border-radius:2px;display:inline-block">${escapeHtml(valStatus)}</span></td>
    </tr>`;
  }).join('');

  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:14%">Risk Area</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:18%">Buyer Concern</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:16%">GTM Impact</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Mitigation Message</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Required Proof</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:12%">Validation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:7.5px;font-style:italic;color:var(--muted);margin:1.5mm 0 0">
      ◆ All regulatory and risk items reflect inferred buyer concern patterns. No verified legal or compliance claims are made. Validate with legal counsel before boardroom use.
    </p>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// PHASE 20N & 20O — SDR PLAYBOOK & APPENDIX HELPERS
// ══════════════════════════════════════════════════════════════

function renderCtaTable(ctas) {
  const rows = (ctas || [
    { touch: 'Touch 1', type: 'Soft / Value-driven', copy: 'Open to exploring how peers handle this?', intent: 'Problem awareness', status: 'Validation pending' },
    { touch: 'Touch 2', type: 'Educational', copy: 'Can I send over the benchmark report?', intent: 'Solution awareness', status: 'Validation pending' },
    { touch: 'Touch 3', type: 'Direct Ask', copy: 'Worth a 15-min chat next Tuesday?', intent: 'Vendor evaluation', status: 'Validation pending' }
  ]).map((c, i) => {
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${escapeHtml(c.touch)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${escapeHtml(c.type)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${safeBusinessText(c.copy, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--blue)">${safeBusinessText(c.intent, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:var(--muted);font-style:italic">${escapeHtml(c.status || 'Validation pending')}</td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:12%">Touch</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:18%">CTA Type</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:35%">CTA Copy</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Buyer Intent</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:15%">Validation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderObjectionHandlingTable(objections) {
  const rows = (objections || [
    { objection: 'Budget timing', response: 'Focus on cost-of-delay / unbudgeted ROI recovery', proof: 'ROI calculator, payback period case study', follow_up: 'Send CFO-ready one-pager', status: 'Validation pending' },
    { objection: 'Existing vendor', response: 'Highlight complementary use cases or critical gaps', proof: 'Feature gap analysis, competitive teardown', follow_up: 'Offer no-commitment gap assessment', status: 'Validation pending' },
    { objection: 'Integration concern', response: 'Emphasize native integrations and low IT lift', proof: 'API docs, security whitepaper', follow_up: 'Invite technical buyer to quick sync', status: 'Validation pending' },
    { objection: 'Security/compliance concern', response: 'Proactively share certifications and data residency', proof: 'SOC2 report, compliance matrix', follow_up: 'Send InfoSec packet early', status: 'Validation pending' },
    { objection: 'Low urgency', response: 'Tie to macro market pressures and competitor moves', proof: 'Analyst reports, industry benchmarks', follow_up: 'Nurture with high-value market insights', status: 'Validation pending' },
    { objection: 'No clear owner', response: 'Identify cross-functional champion', proof: 'Multi-stakeholder success story', follow_up: 'Multi-thread to adjacent departments', status: 'Validation pending' }
  ]).map((o, i) => {
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--amber)">${escapeHtml(o.objection)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${safeBusinessText(o.response, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--accent)">${safeBusinessText(o.proof, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--green)">${safeBusinessText(o.follow_up, 'Requires validation')}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:var(--muted);font-style:italic">${escapeHtml(o.status || 'Validation pending')}</td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:18%">Objection</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:30%">Response Angle</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Proof Needed</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Recommended Follow-up</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:12%">Validation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderRiskScoreCards(risks) {
  const defaultRisks = [
    { name: 'Market Timing Risk', score: 'Medium', detail: 'Macro constraints extend cycles. AI-estimated — validate before commercial use.' },
    { name: 'ICP Fit Risk', score: 'Low', detail: 'Clear buyer persona identified. Validation pending live outbound.' },
    { name: 'Data Confidence Risk', score: 'High', detail: 'Algorithmic limits on baseline inputs. Requires source validation.' },
    { name: 'Competitive Pressure Risk', score: 'Medium', detail: 'Established incumbents present. Validation pending competitive displacement proof.' },
    { name: 'Execution Complexity Risk', score: 'Medium', detail: 'Multi-threaded enterprise motion required. AI-estimated — validate capacity.' }
  ];
  const list = risks && Array.isArray(risks) && risks.length ? risks : defaultRisks;
  const cards = list.map(r => {
    const s = String(r.score || 'Medium').trim();
    const color = /^high/i.test(s) ? 'var(--red)' : /^low/i.test(s) ? 'var(--green)' : 'var(--amber)';
    return `<div style="background:linear-gradient(90deg, rgba(255,255,255,.03), rgba(255,255,255,.01));border:1px solid var(--border);border-left:3px solid ${color};border-radius:6px;padding:3mm 4mm;margin-bottom:2mm;break-inside:avoid;position:relative">
      <div style="position:absolute;top:4px;right:4px;color:${color};opacity:0.2"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1mm;padding-right:20px">
        <strong style="font-size:9.5px;color:var(--text)">${escapeHtml(r.name)}</strong>
        <span style="font-size:8px;font-weight:700;background:${color}22;color:${color};padding:1px 5px;border-radius:3px;text-transform:uppercase">${escapeHtml(s)} RISK</span>
      </div>
      <div style="font-size:8.5px;color:var(--muted);line-height:1.4">${safeBusinessText(r.detail, 'Requires source validation')}</div>
    </div>`;
  }).join('');
  return `<div class="keep-together" style="margin:3mm 0">${cards}</div>`;
}

function renderNextBestActionBlock(actions) {
  const a = actions || {
    immediate: 'Refine ICP definition and validate active CRM pipeline fit.',
    day30: 'Launch localized pilot sequences to segment #1.',
    day60: 'Evaluate touchpoint conversion; adjust messaging angle.',
    day90: 'Boardroom sync: expand segment or pause outbound based on CAC indicators.',
    checkpoint: '30-day signal validation required before full resource commitment.'
  };
  return `<div class="keep-together" style="display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin:3mm 0">
    <div>
      <div style="margin-bottom:3mm">
        <div style="font-size:8px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:.1em;margin-bottom:1mm">Immediate Action (0-7 Days)</div>
        <div style="font-size:9.5px;color:var(--text);border-left:2px solid var(--accent);padding-left:2mm">${safeBusinessText(a.immediate, 'Requires source validation')}</div>
      </div>
      <div style="margin-bottom:3mm">
        <div style="font-size:8px;font-weight:800;color:var(--green);text-transform:uppercase;letter-spacing:.1em;margin-bottom:1mm">30-Day Action</div>
        <div style="font-size:9.5px;color:var(--text);border-left:2px solid var(--green);padding-left:2mm">${safeBusinessText(a.day30, 'Requires source validation')}</div>
      </div>
      <div style="margin-bottom:3mm">
        <div style="font-size:8px;font-weight:800;color:var(--blue);text-transform:uppercase;letter-spacing:.1em;margin-bottom:1mm">60-Day Action</div>
        <div style="font-size:9.5px;color:var(--text);border-left:2px solid var(--blue);padding-left:2mm">${safeBusinessText(a.day60, 'Requires source validation')}</div>
      </div>
      <div style="margin-bottom:3mm">
        <div style="font-size:8px;font-weight:800;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:1mm">90-Day Action</div>
        <div style="font-size:9.5px;color:var(--text);border-left:2px solid var(--amber);padding-left:2mm">${safeBusinessText(a.day90, 'Requires source validation')}</div>
      </div>
    </div>
    <div>
      <div style="background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:4mm;height:100%">
        <div style="font-size:8px;font-weight:800;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:2mm">Decision Checkpoint</div>
        <div style="font-size:10px;color:var(--text);line-height:1.6;margin-bottom:3mm">${safeBusinessText(a.checkpoint, 'Validation pending')}</div>
        <div style="font-size:7.5px;color:var(--muted);font-style:italic">Validate all AI-estimated directives before commercial execution.</div>
      </div>
    </div>
  </div>`;
}

function renderProvenanceTable() {
  const rows = [
    { area: 'Company overview', type: 'Primary / Extracted', rel: 'High', status: 'Validated', notes: 'Derived directly from user input.' },
    { area: 'Market sizing', type: 'Secondary / AI Model', rel: 'Low', status: 'Requires source validation', notes: 'Algorithmic TAM extraction.' },
    { area: 'CAGR / growth indicators', type: 'Secondary / AI Model', rel: 'Low', status: 'Requires source validation', notes: 'General category trajectory.' },
    { area: 'ICP', type: 'Inferred', rel: 'Medium', status: 'Validation pending', notes: 'Generated from company text.' },
    { area: 'Buying triggers', type: 'Inferred', rel: 'Medium', status: 'Validation pending', notes: 'AI-estimated pain points.' },
    { area: 'Account sourcing', type: 'Logic Framework', rel: 'High', status: 'Validated', notes: 'Standardised account tiering.' },
    { area: 'Keywords', type: 'Semantic Extraction', rel: 'Medium', status: 'Validation pending', notes: 'SEO analog generation.' },
    { area: 'Email sequences', type: 'Generative Template', rel: 'Medium', status: 'Validation pending', notes: 'Requires tonal review.' },
    { area: 'Confidence score', type: 'Algorithmic', rel: 'High', status: 'Validated', notes: 'Internal heuristic matrix.' },
    { area: 'Competitive analysis', type: 'AI-Estimated', rel: 'Low', status: 'Requires source validation', notes: 'Subject to hallucinations.' },
    { area: 'Regional analysis', type: 'Default / Global', rel: 'Medium', status: 'Requires source validation', notes: 'Assumes US/Global unless set.' },
    { area: 'Regulatory/risk analysis', type: 'Heuristic', rel: 'Medium', status: 'Validation pending', notes: 'No legal claims asserted.' }
  ].map((r, i) => {
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${escapeHtml(r.area)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${escapeHtml(r.type)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:${r.rel === 'High' ? 'var(--green)' : r.rel === 'Medium' ? 'var(--amber)' : 'var(--red)'}">${escapeHtml(r.rel)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:${/pending|requires/i.test(r.status) ? 'var(--amber)' : 'var(--green)'};font-style:italic">${escapeHtml(r.status)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:var(--muted)">${escapeHtml(r.notes)}</td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Data Area</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Source Type</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:10%">Reliability</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Validation Status</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:30%">Notes</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderAssumptionLedger() {
  const rows = [
    { assumption: 'Standard B2B SaaS buying dynamics apply', section: 'SDR Sequence, Buying Criteria', impact: 'Medium', risk: 'Medium', validation: 'Confirm with sales team' },
    { assumption: 'Decision-making relies on committee consensus', section: 'ICP Modeling, Objections', impact: 'High', risk: 'High', validation: 'Requires source validation' },
    { assumption: 'Market follows global growth trajectory', section: 'TAM Mapping, Segment Growth', impact: 'High', risk: 'High', validation: 'Check analyst reports' },
    { assumption: 'Competitive set implies baseline feature parity', section: 'Competitive Landscape, Right-to-Win', impact: 'Medium', risk: 'Medium', validation: 'Requires competitive teardown' }
  ].map((r, i) => {
    const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
    return `<tr style="background:${bg}">
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;font-weight:700;color:var(--accent)">${escapeHtml(r.assumption)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top">${escapeHtml(r.section)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--amber)">${escapeHtml(r.impact)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:9px;vertical-align:top;color:var(--red)">${escapeHtml(r.risk)}</td>
      <td style="border:.5px solid #444;padding:5px 6px;font-size:8.5px;vertical-align:top;color:var(--muted);font-style:italic">${escapeHtml(r.validation)}</td>
    </tr>`;
  }).join('');
  return `<div class="keep-together table-wrap" style="margin:3mm 0">
    <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-family:inherit">
      <thead><tr>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:35%">Assumption</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:25%">Used In Section</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:10%">Impact</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:10%">Risk Level</th>
        <th style="background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:left;border:.5px solid #444;padding:5px 6px;font-size:8px;width:20%">Validation Needed</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}


// ══════════════════════════════════════════════════════════════
// SECTION REGISTRY
// Defines the canonical order and metadata for every report section.
// renderFn is resolved inside buildReportHTML where data is in scope.
// mode: 'standard' | 'enterprise' | 'both'
// ══════════════════════════════════════════════════════════════
const SECTION_REGISTRY = [
  { id: 'cover',                  order:  0, required: true,  mode: 'both', title: 'Cover' },
  { id: 'executive_summary',      order:  1, required: true,  mode: 'both', title: 'Executive Summary' },
  { id: 'market_research',        order:  2, required: true,  mode: 'both', title: 'Market Research' },
  { id: 'tam_mapping',            order:  3, required: true,  mode: 'both', title: 'TAM Mapping' },
  { id: 'icp_modeling',           order:  4, required: true,  mode: 'both', title: 'ICP Modeling' },
  { id: 'account_sourcing',       order:  5, required: true,  mode: 'both', title: 'Account Sourcing' },
  { id: 'keywords_intent',        order:  6, required: true,  mode: 'both', title: 'Keywords & Intent' },
  { id: 'sdr_emails',             order:  7, required: true,  mode: 'both', title: 'SDR Sequence — Emails' },
  { id: 'sdr_social',             order:  8, required: true,  mode: 'both', title: 'SDR Sequence — Social & Cadence' },
  // ── Phase 20K: Competitive Intelligence ──
  { id: 'competitive_landscape',  order:  9, required: true,  mode: 'both', title: 'Competitive Landscape' },
  { id: 'right_to_win',           order: 10, required: true,  mode: 'both', title: 'Right-to-Win Analysis' },
  // ── Phase 20L: Porter Five Forces & Buying Criteria ──
  { id: 'porter_five_forces',     order: 11, required: true,  mode: 'both', title: 'Porter\'s Five Forces: GTM Lens' },
  { id: 'buying_criteria',        order: 12, required: true,  mode: 'both', title: 'Buying Criteria Matrix' },
  // ── Phase 20M: Technology, Capability & Risk ──
  { id: 'capability_analysis',    order: 13, required: true,  mode: 'both', title: 'Technology / Capability Analysis' },
  { id: 'regulatory_risk',        order: 14, required: true,  mode: 'both', title: 'Regulatory & Risk Landscape' },
  // ── Revenue Intelligence ──
  { id: 'decision_engine',        order: 15, required: true,  mode: 'both', title: 'Revenue Intelligence — Decision Engine' },
  { id: 'confidence_matrix',      order: 16, required: true,  mode: 'both', title: 'Revenue Intelligence — Confidence Matrix' },
  { id: 'appendix_methodology',   order: 17, required: true,  mode: 'both', title: 'Appendix — Methodology' },
  { id: 'appendix_metadata',      order: 18, required: true,  mode: 'both', title: 'Appendix — Report Metadata' },
];

// ══════════════════════════════════════════════════════════════
// TIER-1 ENTERPRISE A4 REPORT — dark-theme, rendered to PDF
// ══════════════════════════════════════════════════════════════
export function buildReportHTML(strategy, charts = {}, isDemoMode = false, renderMode = 'browser-pdf', isViewer = false) {
  const p = isViewer ? '.abe-viewer-wrapper ' : '';
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
  const date = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const intelligence = strategy.backend_intelligence || normalizeStrategy(strategy, false);
  const tm = intelligence.truthMetadata || {};
  const score = intelligence.gtmScore;
  const confScore = intelligence.confScore;

  // ── String helpers — hardened to block raw arrays, objects, placeholders, merged text, bad values ──
  const e = s => {
    // Use global safeBusinessText to strip bad values, repair merges and placeholders before escaping
    const cleaned = safeBusinessText(s, '');
    return cleaned
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  };
  const safe = v => {
    if (v === null || v === undefined) return '';
    if (v === 0) return '0';
    let str;
    if (Array.isArray(v)) {
      // Filter and repair each array item through the global sanitizer
      str = v.map(item => safeBusinessText(item, '')).filter(Boolean).join(', ');
    } else if (typeof v === 'object') {
      str = Object.entries(v)
        .map(([k, x]) => {
          const val = Array.isArray(x) ? x.map(i => safeBusinessText(i, '')).filter(Boolean).join(', ') : safeBusinessText(x, '');
          return val ? `${k}: ${val}` : '';
        })
        .filter(Boolean).join('; ');
    } else {
      str = safeBusinessText(v, '');
    }
    // Final pass: strip any residual invalid tokens
    return str
      .replace(/\b(undefined|null|NaN|Infinity|-Infinity)\b/g, '')
      .replace(/\[object Object\]/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  const arr = v => Array.isArray(v) ? v : (v ? [String(v)] : []);

  const numbering = {
    "executive-summary":      { main: "ES", title: "Executive Summary" },
    "market-research":        { main: "1",  title: "Market Research" },
    "tam-mapping":            { main: "2",  title: "TAM Mapping" },
    "icp-modeling":           { main: "3",  title: "ICP Modeling" },
    "account-sourcing":       { main: "4",  title: "Account Sourcing" },
    "keywords-intent":        { main: "5",  title: "Keywords & Intent" },
    "sdr-sequence":           { main: "6",  title: "Enterprise SDR Sequence" },
    // Phase 20K
    "competitive-landscape":  { main: "CL", title: "Competitive Landscape" },
    "right-to-win":           { main: "RW", title: "Right-to-Win Analysis" },
    // Phase 20L
    "porter-five-forces":     { main: "P5", title: "Porter's Five Forces" },
    "buying-criteria":        { main: "BC", title: "Buying Criteria Matrix" },
    // Phase 20M
    "capability-analysis":    { main: "CA", title: "Technology / Capability Analysis" },
    "regulatory-risk":        { main: "RR", title: "Regulatory & Risk Landscape" },
    "revenue-intelligence":   { main: "7",  title: "Revenue Intelligence" },
    "appendix":               { main: "A",  title: "Appendix" }
  };
  const h3 = (slug, sub, title) => {
    const main = numbering[slug]?.main || '';
    return `<h3 class="keep-together">${main}.${sub} · ${title}</h3>`;
  };
  const renderDarkTable = (data = {}, note, source) => {
    const headers = Array.isArray(data.headers) ? data.headers : [];
    const rows = Array.isArray(data.rows) ? data.rows : [];

    // Contextual fallback by column header — avoid bare dash cells
    const contextualFallback = (header = '', rowIdx = 0) => {
      const h = String(header).toLowerCase();
      if (/icp|persona|profile|buyer|contact|role/i.test(h)) return 'Commercial Decision Maker';
      if (/decision.maker|decision maker/i.test(h)) return 'Revenue Operations Leader';
      if (/confidence|fidelity|quality/i.test(h)) return 'Moderate confidence — pending live validation';
      if (/source|provenance|origin/i.test(h)) return 'Requires source validation';
      if (/status|validation|verified/i.test(h)) return 'Validation pending';
      if (/trigger|signal|intent/i.test(h)) return 'Operational pressure (inferred)';
      if (/segment|market|tam|sam|som/i.test(h)) return 'AI estimate — validate with analyst data';
      if (/action|next|step|recommendation/i.test(h)) return 'Define during discovery';
      return 'Validation pending';
    };

    const cleanCell = (cell, headerIdx = 0) => {
      const header = headers[headerIdx] || '';
      // If cell is empty, null, undefined, or bare dash — apply contextual fallback
      if (cell === undefined || cell === null || cell === '') {
        return `<span style="color:var(--muted);font-style:italic;font-size:10px">${contextualFallback(header)}</span>`;
      }
      const raw = String(cell);
      // Strip HTML tags to check for dash-only content
      const stripped = raw.replace(/<[^>]*>/g, '').trim();
      if (/^[-–—\s]+$/.test(stripped)) {
        return `<span style="color:var(--muted);font-style:italic;font-size:10px">${contextualFallback(header)}</span>`;
      }
      if (/^(critical|high risk|medium risk|low risk|high|medium|low|watch|go|no-go|validated|validation pending|pending validation|requires validation|requires source validation)$/i.test(stripped)) {
        return renderStatusBadge(stripped);
      }
      return sanitizeVisibleHtml(raw);
    };

    const cleanRows = rows
      .filter(row => Array.isArray(row) && row.some(cell => {
        if (cell === null || cell === undefined || cell === '') return false;
        // Strip HTML tags before checking dash-only / bad-value patterns
        const stripped = String(cell).replace(/<[^>]*>/g, '').trim();
        if (!stripped) return false;
        // Fully block dash-only: em-dash, en-dash, hyphen, combinations, whitespace
        if (/^[\-\u2013\u2014\s]+$/.test(stripped)) return false;
        // Block bare invalid tokens
        if (/^(undefined|null|nan|infinity|-infinity|\[object object\])$/i.test(stripped)) return false;
        return true;
      }))
      .map(row => row.map((cell, ci) => cleanCell(cell, ci)));
    if (!headers.length || !cleanRows.length) return '';
    const tableHtml = `
      <table class="dark-table" style="width:100%;table-layout:fixed;border-collapse:collapse;margin-top:1.5mm;margin-bottom:1.5mm;font-family:inherit;">
        <thead>
          <tr>
            ${headers.map(h => `<th style="background:#2a2a2a;color:#f0f0f0;font-weight:bold;text-align:center;border:0.5px solid #444;padding:6px;font-size:10px;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(h, 'Data Point')}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${cleanRows.map((row, i) => {
            const bg = i % 2 === 0 ? '#1e1e1e' : '#2a2a2a';
            return `<tr style="background:${bg};">${row.map((cell, ci) => {
              const rendered = cell || `<span style="color:var(--muted);font-style:italic;font-size:10px">${contextualFallback(headers[ci])}</span>`;
              return `<td style="border:0.5px solid #444;padding:6px;font-size:10px;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;">${rendered}</td>`;
            }).join('')}</tr>`;
          }).join('')}
        </tbody>
      </table>
      ${note ? `<p class="table-note" style="font-size:8px;font-style:italic;color:#aaa;margin:1mm 0 0.5mm;">Note: ${escapeHtml(note)}</p>` : ''}
      ${source ? `<p class="table-source" style="font-size:8px;font-style:italic;color:#aaa;margin:0 0 3mm;">Source: ${escapeHtml(source)}</p>` : ''}
    `;
    return `<div class="keep-together table-wrap">${tableHtml}</div>`;
  };

  const renderReportMetadata = () => {
    return renderDarkTable({
      headers: ['Field', 'Value'],
      rows: [
        ['Subject Company', e(co)],
        ...(ind ? [['Industry', e(ind)]] : []),
        ['Generated', e(date)],
        ['Platform', 'ABE Enterprise AI Revenue Infrastructure'],
        ['Report Mode', isDemoMode ? 'Demo — illustrative only' : 'Live / Realtime'],
        ['Steps Completed', e(String(strategy.steps_completed || 6)) + '/7'],
        ['GTM Relevance Score', e(String(score)) + '/100'],
        ['Confidence Score', e(String(confScore)) + '/100'],
        ['QuickChart Charts', e([charts.gauge ? 'Gauge' : '', charts.waterfall ? 'Waterfall' : '', charts.confidence ? 'Confidence' : '', charts.intent ? 'Intent' : '', charts.risk ? 'Risk' : ''].filter(Boolean).join(', ') || 'Fallback HTML used')]
      ]
    }, '', 'ABE GTMS Engine v1.0');
  };

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
  const rec = s7.go_no_go?.recommendation || (score >= 75 ? 'Go' : score >= 50 ? 'Watch' : 'No-Go');
  const recUp = rec.toUpperCase();
  const recColor = /go$/i.test(rec) && !/no/i.test(rec) ? 'var(--green)' : /no/i.test(rec) ? 'var(--red)' : 'var(--amber)';
  const veracity = Math.round(confScore * 0.4);
  const timing = Math.round(confScore * 0.25);
  const icpFit = Math.round(confScore * 0.2);
  const completeness = Math.round(confScore * 0.15);

  const srcNote = (src) => `<div style="font-size:7.5px;color:var(--faint);margin:1.5mm 0;font-style:italic">◆ ${e(src)} — validate manually</div>`;
  const callout = (text, cls = '') => text ? `<div class="ac ${cls}"><strong><svg width="11" height="11" viewBox="0 0 16 16" fill="none" style="display:inline;vertical-align:middle;margin-right:3px"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Analyst Insight:</strong> ${e(text)}</div>` : '';

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
  const ANALOGS = ['Top-5 UK retail bank', 'Large EU automotive OEM', 'Tier-1 APAC telco', 'Regional food delivery aggregator', 'Enterprise SaaS vendor (NA)', 'Mid-market insurance carrier (EU)', 'Large Indian quick-commerce platform', 'Fortune-500 industrial conglomerate'];
  const cleanAcct = (name, i) => { if (!name || name === '—') return ANALOGS[i % ANALOGS.length]; const n = String(name).trim(); return FAKE_RE.test(n) ? ANALOGS[i % ANALOGS.length] : n; };

  // ── Helper builders ──
  const pageHdr = () => `<div class="ph"><div class="phb"><div class="am">ABE</div><div><div class="abn">AI Revenue Infrastructure</div><div class="abs">Enterprise GTM Platform</div></div></div><div class="cb">Confidential</div></div>`;
  const pageFtr = renderPageFooter;

  const secHead = (num, title) => renderPageHeader(num, title, '', SECTION_ICONS[num] || 'grid');
  const secCtx = text => text ? `<div class="sc">${e(text)}</div>` : '';
  const tags = (items, cls = '') => arr(items).slice(0, 15).map(t => `<span class="tg ${cls}">${e(String(t))}</span>`).join('');
  const fieldRow = (label, val) => { const v = safe(val); return v ? `<tr><th>${e(label)}</th><td>${e(v)}</td></tr>` : ''; };

  // ── SWOT ──
  const swotCell = (label, items, color) => { const a = arr(items); return a.length ? `<div class="sc2" style="border-top:3px solid ${color}"><div class="sl" style="color:${color}">${label}</div><ul>${a.slice(0, 4).map(i => `<li>${e(String(i))}</li>`).join('')}</ul></div>` : ''; };
  const swotGrid = () => { const sw = s1.swot; if (!sw || typeof sw !== 'object') return ''; const h = swotCell('STRENGTHS', sw.strengths, 'var(--green)') + swotCell('WEAKNESSES', sw.weaknesses, 'var(--red)') + swotCell('OPPORTUNITIES', sw.opportunities, 'var(--blue)') + swotCell('THREATS', sw.threats, 'var(--amber)'); return h ? `<div class="sg swot-grid">${h}</div>` : ''; };

  // ── TAM Waterfall with math ──
  const wfBar = (label, value, w, cls) => value ? `<div class="wb"><div class="wv">${e(safe(value))}</div><div class="wftrack"><div class="wf ${cls}" style="width:${w}"></div></div><span style="margin-left:2mm;font-size:9px;color:var(--muted)">${label}</span></div>` : '';
  const waterfall = () => {
    const wf = s2.waterfall || {}; const tam = safe(s2.tam_size_estimate); if (!tam && !wf.tam_value) return '';
    const tamV = wf.tam_value || tam, samV = wf.sam_value || safe(s2.sam_estimate) || '—', somV = wf.som_value || '5–10% of TAM';
    const tamSrc = samV && samV !== '—' ? 'Market estimate' : 'AI estimate ⚠️';
    // Dynamic factors — pull from strategy data when available, else default
    const geoRaw = wf.geography_eligibility || s2.geography_eligibility;
    const slRaw = wf.service_line_fit || s2.service_line_fit;
    const wrRaw = wf.win_rate || wf.capture_rate || s2.win_rate;
    const geoVal = geoRaw ? safe(geoRaw) : '60–70%';
    const slVal = slRaw ? safe(slRaw) : '30–40%';
    const wrVal = wrRaw ? safe(wrRaw) : '8–12%';
    const geoSrc = geoRaw ? 'Company data' : 'AI estimate ⚠️ (default)';
    const slSrc = slRaw ? 'Company data' : 'AI estimate ⚠️ (default)';
    const wrSrc = wrRaw ? 'Company data' : 'AI estimate ⚠️ (default)';

    const tamFmt = formatCurrency(tamV, 'Requires validation');
    const samFmt = formatCurrency(samV, 'Requires validation');
    const somFmt = formatCurrency(somV, 'Requires validation');

    return `<div class="ww keep-together">${wfBar('TAM (Total Addressable)', tamFmt, '80%', 'wfb')}${wfBar('SAM (Serviceable Addressable)', samFmt, '50%', 'wfa')}${wfBar('SOM (Serviceable Obtainable)', somFmt, '20%', 'wfm')}</div>
    ${h3('tam-mapping', '2b', 'TAM Derivation Formula')}
    ${renderDarkTable({
      headers: ['Step', 'Factor', 'Value', 'Source'],
      rows: [
        ['Global TAM', 'Total market size', `<span class="num">${e(tamFmt)}</span>`, tamSrc],
        ['× Geography eligibility', 'Addressable regions', `<span class="num">${e(geoVal)}</span>`, geoSrc],
        ['× Service-line fit', 'Relevant segments', `<span class="num">${e(slVal)}</span>`, slSrc],
        ['× Capture / win rate', 'Realistic close rate', `<span class="num">${e(wrVal)}</span>`, wrSrc],
        ['<strong>= Obtainable opportunity</strong>', '', `<span class="num ha">${e(somFmt)}</span>`, 'Derived']
      ]
    }, 'Factors marked "AI estimate" use conservative defaults. When company-specific data is available, it is used automatically.', 'ABE GTMS Engine v1.0')}`;
  };

  // ── Pain-Solution Map ──
  const painMap = () => { const m = s3.pain_solution_map; if (!Array.isArray(m) || !m.length) return ''; return `${h3('icp-modeling', '3', 'Pain → Impact → Intervention')}${renderDarkTable({ headers: ['Operational Friction', 'Business Impact', 'Intervention'], rows: m.slice(0, 5).map(p => [e(safe(p.operational_friction || '—')), `<span style="color:var(--amber)">${e(safe(p.business_impact || '—'))}</span>`, `<span style="color:var(--green)">${e(safe(p.recommended_intervention || '—'))}</span>`]) }, '', 'ABE GTMS Engine v1.0')}`; };

  // ── Account Targets (sanitized) ──
  const acctTable = () => { const t = s4.account_targets; if (!Array.isArray(t) || !t.length) return ''; return `${h3('account-sourcing', '5', 'High-Fit Account Analogs')}${renderDarkTable({ headers: ['Account Profile', 'Fit', 'Trigger'], rows: t.slice(0, 5).map((a, i) => [`${e(cleanAcct(a.account_name, i))}`, `<span class="num" style="color:${(a.fit_score || 0) >= 80 ? 'var(--green)' : 'var(--amber)'}">${a.fit_score || '—'}</span>`, e(safe(a.actionable_trigger || '—'))]) }, '', 'Account names are anonymized analogs representing target archetypes — AI-generated profile matching')}`; };

  // ── Keyword Taxonomy ──
  const kwTaxonomy = () => { const kt = s5.keyword_taxonomy; if (!kt || typeof kt !== 'object') return ''; const ef = arr(kt.early_funnel), lf = arr(kt.late_funnel); if (!ef.length && !lf.length) return ''; return `${h3('keywords-intent', '2', 'Funnel Taxonomy')}<div class="keep-together" style="display:grid;grid-template-columns:1fr 1fr;gap:3mm"><div><div class="bl">Early Funnel (Problem-Aware)</div>${tags(ef, 'blue')}</div><div><div class="bl">Late Funnel (Solution-Aware)</div>${tags(lf, 'green')}</div></div>`; };

  // ── Segments Table ──
  const segTable = () => { const sg = s2.market_segments; if (!Array.isArray(sg) || !sg.length) return ''; return `${h3('tam-mapping', '3', 'Market Segments')}${renderDarkTable({ headers: ['Segment', 'Est. Size', 'Priority', 'Growth'], rows: sg.slice(0, 6).map(s => [e(safe(s.name || s.segment_name || '—')), `<span class="num">${e(safe(s.size || s.market_size || '—'))}</span>`, e(safe(s.priority || '—')), `<span class="num">${e(safe(s.growth_rate || '—'))}</span>`]) }, '', 'AI market estimate — validate with industry reports')}`; };

  // ── Emails — SDR Timeline ──
  const emailBlock = (k, i) => {
    const em = s6[k]; if (!em) return '';
    const icons = ['✉', '✉', '✉', '🔗', '📞'];
    const labels = ['Touch 1', 'Touch 2', 'Touch 3', 'Touch 4', 'Touch 5'];
    
    // Clean placeholders
    const cleanStr = (s) => String(s || '—')
      .replace(/\[Name\]/gi, '{{First Name}}')
      .replace(/\[HName\]/gi, 'Hi {{First Name}}')
      .replace(/\[Your Name\]/gi, 'AB Enterprise Team')
      .replace(/\b(undefined|null|NaN)\b/gi, '')
      .replace(/\[object Object\]/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || '—';

    const safeBody = cleanStr(em.body);
    const safeSubj = cleanStr(em.subject);
    const safeAngle = cleanStr(em.angle);
    const safeCta = cleanStr(em.cta);
    
    return `<div class="sdr-step keep-together">
      <div class="sdr-num">${icons[i] || i + 1}</div>
      <div class="sdr-body" style="background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5mm">
          <div class="sdr-angle" style="margin-bottom:0;color:var(--accent);font-weight:800;font-size:9px;text-transform:uppercase;letter-spacing:.12em">${labels[i] || 'Touch ' + (i + 1)}</div>
          <span style="font-size:7.5px;color:var(--muted);font-style:italic">Intent/Pain Angle: ${e(safeAngle)}</span>
        </div>
        <div class="sdr-subject" style="border-bottom:1px solid rgba(255,255,255,.05);padding-bottom:1.5mm"><strong>Subject:</strong> ${e(safeSubj)}</div>
        <div class="sdr-preview" style="margin-top:2mm;white-space:pre-wrap;font-size:10.5px;color:var(--text);line-height:1.65">${e(safeBody)}</div>
        <div style="margin-top:3mm;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,.05);padding-top:2mm">
          <span class="tg green" style="margin:0;display:inline-block">CTA: ${e(safeCta)}</span>
          <span style="font-size:7.5px;color:var(--amber);font-style:italic">Validation pending</span>
        </div>
      </div>
    </div>`;
  };

  // ── ICP Repair Logic ──
  const icpRepair = () => {
    const pm = s3.persona_map; if (!pm || typeof pm !== 'object') return '';
    const rows = [pm.primary_role ? ['Primary Contact', e(safe(pm.primary_role.title || '—')), e(safe(pm.primary_role.key_responsibility || '—'))] : null, pm.economic_buyer ? ['Economic Buyer', e(safe(pm.economic_buyer.title || '—')), e(safe(pm.economic_buyer.key_responsibility || '—'))] : null, pm.champion ? ['Internal Champion', e(safe(pm.champion.title || '—')), e(safe(pm.champion.key_responsibility || '—'))] : null].filter(Boolean);
    if (!rows.length) return '';
    return `${h3('icp-modeling', '4', 'ICP Persona Map (Repair Logic)')}${renderDarkTable({ headers: ['Role', 'Title', 'Key Responsibility'], rows }, '', 'ABE GTMS Engine v1.0')}`;
  };

  // ── Decision Engine (Step 7) ──
  const decisionEngineSummary = () => {
    if (!score && !confScore) return '';
    const hasS7 = s7 && Object.keys(s7).length > 1;
    const triggers = arr(s3.buying_triggers);
    const dms = arr(s3.decision_makers);
    const whyNow = hasS7 && s7.why_now_analysis ? s7.why_now_analysis : `Market conditions and active ${(triggers[0] || 'operational pressure').toLowerCase()} dynamics create a time-sensitive engagement window.`;
    const hook = hasS7 && s7.strategic_hook ? s7.strategic_hook : (triggers.length >= 2 ? `${triggers[0]} paired with ${triggers[1]}` : `Lead with: ${triggers[0] || 'Operational pressure'}`);
    const reason = s7.go_no_go?.reasoning || s7.verdict_rationale || 'Score exceeds required threshold for market entry.';
    return `
  ${secHead('07', 'Revenue Intelligence — Decision Engine')}
  ${secCtx('Final strategic audit. Validates execution viability and dictates immediate next steps.')}
  ${h3('revenue-intelligence', '1', 'Go / No-Go Validation')}
  <div class="card keep-together" style="border-left:4px solid ${recColor}">
    <div style="display:flex;align-items:center;gap:5mm">
      <svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
        <circle cx="26" cy="26" r="24" fill="rgba(168,85,247,.06)" stroke="${recColor}" stroke-width="1.5"/>
        ${/no/i.test(rec) ? `<path d="M18 18L34 34M34 18L18 34" stroke="${recColor}" stroke-width="3" stroke-linecap="round"/>` : /go$/i.test(rec) && !/no/i.test(rec) ? `<path d="M15 27L22 34L37 18" stroke="${recColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : `<path d="M26 18v10M26 32v2" stroke="${recColor}" stroke-width="3" stroke-linecap="round"/>`}
      </svg>
      <div>
        <div style="font-family:'Space Mono',monospace;font-size:26px;font-weight:900;color:${recColor};line-height:1">${e(recUp)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:1.5mm"><strong style="color:var(--text)">Verdict Rationale:</strong> ${e(reason)}</div>
      </div>
    </div>
  </div>
  ${srcNote(hasS7 ? 'Source: Step 7 AI intelligence layer — algorithmic composite' : 'Source: derived from GTM relevance score (' + score + '/100) — algorithmic')}
  ${h3('revenue-intelligence', '2', 'Why Now')}
  <div class="card keep-together"><p style="font-size:12px">${e(whyNow)}</p></div>
  ${srcNote(hasS7 && s7.why_now_analysis ? 'Source: Step 7 AI analysis of market signals' : 'Source: AI inference from buying triggers and market context — validate timing independently')}
  ${h3('revenue-intelligence', '3', 'Strategic Hook')}
  <div class="ac keep-together"><strong>"${e(hook)}"</strong></div>
  ${srcNote(hasS7 && s7.strategic_hook ? 'Source: Step 7 AI strategic analysis' : 'Source: derived from buying triggers — AI estimate')}`;
  };

  const decisionEngineRisk = () => {
    return `
  ${h3('revenue-intelligence', '4', 'Risk &amp; Constraint Analysis')}
  ${renderRiskScoreCards(s7.risk_factors)}
  ${srcNote('30–60 day cycle estimate is an industry benchmark (AI estimate) — validate with CRM data')}
  ${charts.risk
        ? `<div class="keep-together chart-block" style="margin:2mm 0 4mm"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2mm">RISK SEVERITY ASSESSMENT</div>${renderChartOrFallback('Risk Severity', charts.risk, '', { width: 480, height: 180 })}<p class="figure-caption" style="font-size:10px; font-weight:bold; color:#f5f5f5; margin:1mm 0 0.5mm;">Figure 4: Risk Severity Assessment</p><p class="figure-source" style="font-size:8px; font-style:italic; color:#aaa; margin:0;">Source: ABE GTMS Engine v1.0</p></div>`
        : ''
      }
  ${h3('revenue-intelligence', '5', 'Execution Priority & Next Best Action')}
  ${renderNextBestActionBlock(s7.next_best_action)}
  ${safe(s2.growth_rate) ? srcNote('CAGR (' + safe(s2.growth_rate) + ') is an AI market estimate — cross-reference with analyst reports') : ''}`;
  };

  // ── Weighted Confidence Matrix ──
  const confidenceMatrix = () => {
    if (!confScore) return '';
    const cmBar = (label, sc, max, cls = '') => `<div class="cmrow ${cls}">
      <div class="cmhdr"><span class="cmlbl">${label}</span><span class="cmscore">${sc}<span style="font-size:8px;font-weight:400;color:var(--muted)">/${max}</span></span></div>
      <div class="cmtrack"><div class="cmfill" style="width:${Math.round((sc / max) * 100)}%"></div></div>
    </div>`;
    // SVG donut: r=28, circumference=176
    const circ = 176;
    const filled = Math.round((confScore / 100) * circ);
    const gaugeColor = confScore >= 75 ? 'var(--green)' : confScore >= 50 ? 'var(--amber)' : 'var(--red)';
    return `
  ${h3('revenue-intelligence', '6', 'Weighted Confidence Matrix')}
  <div class="keep-together" style="display:flex;gap:6mm;align-items:flex-start">
    <svg width="90" height="90" viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
      <circle cx="45" cy="45" r="28" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="9"/>
      <circle cx="45" cy="45" r="28" fill="none" stroke="${gaugeColor}" stroke-width="9"
        stroke-dasharray="${filled} ${circ}" stroke-dashoffset="${Math.round(circ * 0.25)}"
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

  // ── Phase 21C: Gotenberg-specific print profile ────────────────────────
  // When Gotenberg renders, we use headless Chromium with print media.
  // Rules: NO transform:scale(), NO fixed-height containers, allow report to flow freely.
  // Minimum readable font sizes enforced. Section headings kept with content.
  const gotenbergPrintCss = `
@page { size: A4; margin: 10mm 12mm; }
html, body {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  background: #0B0F1A !important;
  font-size: 12px;
  line-height: 1.6;
  orphans: 3;
  widows: 3;
}
/* Sections flow naturally — Gotenberg Chromium handles pagination */
${p}.page {
  width: 100%;
  box-sizing: border-box;
  background: transparent !important;
  padding: 0 !important;
  margin: 0 !important;
  min-height: unset !important;
  height: auto !important;
  display: block !important;
}
${p}.page.section-break {
  break-before: page !important;
  page-break-before: always !important;
  padding-top: 4mm !important;
}
/* Headings always stay with at least first content block */
${p}h1, ${p}h2, ${p}h3, ${p}.section-header, ${p}.ph {
  break-after: avoid !important;
  page-break-after: avoid !important;
  orphans: 4;
  widows: 4;
}
/* Keep content blocks together */
${p}.card, ${p}.table-wrap, ${p}.chart-block, ${p}.ac,
${p}.swot-grid, ${p}.page-insight, ${p}.page-insight-expanded,
${p}.sdr-step, ${p}tr, ${p}.keep-together,
${p}.kpi-strip, ${p}.icp-grid, ${p}.droc-grid,
${p}.evolution-stage, ${p}.scope-grid, ${p}.tier-cards,
${p}.sourcing-funnel, ${p}.findings-grid, ${p}.triangulation-grid {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
  orphans: 3;
  widows: 3;
}
${p}.pf, ${p}.pf-wrap, ${p}.page-insight, ${p}.figure-caption, ${p}.figure-source {
  break-before: avoid !important;
  page-break-before: avoid !important;
}
/* Phase 21C: Readability — minimum font sizes */
${p}.dt th { font-size: 10px !important; }
${p}.dt td { font-size: 10px !important; }
${p}table th { font-size: 10px !important; }
${p}table td { font-size: 10px !important; }
${p}.sc2 li { font-size: 10px !important; }
${p}.card p { font-size: 11.5px !important; }
${p}.tg { font-size: 9px !important; }
${p}.pf { font-size: 10px !important; color:#FFFFFF !important; opacity:1 !important; }
${p}.pf-tagline { font-size: 10px !important; opacity: 1 !important; color: #FFFFFF !important; }
${p}.figure-caption { font-size: 10px !important; color: #f5f5f5 !important; }
${p}.figure-source { font-size: 8.5px !important; color: #aaa !important; }
/* Phase 21C: Remove height-induced blank gaps */
${p}.page { overflow: visible !important; }
/* Phase 21C: Edu-filler hidden for Gotenberg (content flows, no fixed-height pages) */
${p}.edu-filler { display: none !important; }
/* Remove excessive spacer breaks */
${p}.section-continuation { display: block !important; padding: 0 !important; margin: 0 !important; }
`;

  const paginationCss = renderMode === 'gotenberg' ? gotenbergPrintCss : renderMode === 'browser-pdf' ? `
${!isViewer ? '@page { size: A4; margin: 12mm; } body { padding: 0 !important; height: auto !important; }' : ''}
/* browser-pdf: content flows naturally — Chromium handles pagination. */
${p}.page {
  width: 100%;
  box-sizing: border-box;
  background: transparent !important;
  padding: 0 !important;
  margin: 0 !important;
}
${p}.page.section-break {
  break-before: page !important;
  page-break-before: always !important;
}
${p}.card, ${p}.table-wrap, ${p}.chart-block, ${p}.ac, ${p}.swot-grid,
${p}.page-insight, ${p}.page-insight-expanded, ${p}.sdr-step, ${p}tr {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}
${p}.page-insight, ${p}.page-insight-expanded, ${p}.pf {
  break-before: avoid !important;
  page-break-before: avoid !important;
}
${p}h1, ${p}h2, ${p}h3, ${p}.section-header, ${p}.ph {
  break-after: avoid !important;
  page-break-after: avoid !important;
}
${p}table th{font-size:10.5px!important;line-height:1.35!important;padding:6px 7px!important}
${p}table td{font-size:10px!important;line-height:1.45!important;padding:6px 7px!important}
${p}.pf, ${p}.pf *{font-size:10px!important;color:#fff!important;opacity:1!important}
${p}.pf-tagline{font-size:10px!important;color:#fff!important;opacity:1!important}
${p}.edu-filler {
  margin-top: auto;
  padding-top: 6mm;
  border-top: 1px dashed rgba(168,85,247,.2);
  border-left: 3px solid rgba(168,85,247,.4);
  border-right: 1px dashed rgba(168,85,247,.12);
  border-bottom: 1px dashed rgba(168,85,247,.12);
  border-radius: 0 8px 8px 0;
  padding: 4mm 5mm 4.5mm 5mm;
  background: linear-gradient(135deg, rgba(168,85,247,.035), rgba(18,24,39,.45));
  break-inside: avoid;
  page-break-inside: avoid;
}
${p}.page{min-height:auto;display:block}
` : `
${p}.page{width:210mm;min-height:297mm;overflow:visible;margin:0;background:var(--bg);padding:12mm 15mm 15mm;position:relative;page-break-after:always;box-sizing:border-box;display:flex;flex-direction:column}
`;
  const styles = `
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0B0F1A;--bg2:#0D1120;--card:#121827;--border:#1F2937;--accent:#a855f7;--accent2:#7c3aed;--green:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#3b82f6;--text:#E5E7EB;--muted:#6B7280;--faint:#374151;--white:#fff}
${isViewer ? '.abe-viewer-wrapper, .abe-viewer-wrapper * { box-sizing:border-box }' : '*{box-sizing:border-box}'}
${isViewer ? '.abe-viewer-wrapper * { margin:0; padding:0 }' : '*{margin:0;padding:0}'}
${isViewer ? '.abe-viewer-wrapper' : 'body'}{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);font-size:12px;line-height:1.65;-webkit-print-color-adjust:exact;print-color-adjust:exact;orphans:3;widows:3}
${paginationCss}
/* ── PHASE 21D READABILITY LOCK — applies to both fallback and server-rendered PDFs ── */
${p}table{font-size:10px!important;line-height:1.45!important;border-collapse:collapse;page-break-inside:auto;break-inside:auto}
${p}thead{display:table-header-group}
${p}tfoot{display:table-footer-group}
${p}tr{page-break-inside:avoid!important;break-inside:avoid!important}
${p}th{font-size:10.5px!important;line-height:1.35!important;padding:6px 7px!important;color:#f8fafc!important}
${p}td{font-size:10px!important;line-height:1.45!important;padding:6px 7px!important;color:#e5e7eb!important}
${p}p, ${p}li{font-size:11.5px;line-height:1.6}
${p}.table-note, ${p}.table-source, ${p}.figure-source{font-size:9px!important;line-height:1.35!important;color:#cbd5e1!important}
${p}.figure-caption{font-size:10.5px!important;color:#fff!important}
${p}.status-pill{font-size:9.5px!important;line-height:1.2!important}
${p}h1,${p}h2,${p}h3,${p}.section-header,${p}.ph{break-after:avoid!important;page-break-after:avoid!important}
${p}.section-start,${p}.keep-with-next{break-inside:avoid!important;page-break-inside:avoid!important}
${p}.page,${p}.section-continuation{break-inside:auto;page-break-inside:auto}
${p}.pf-wrap{break-before:avoid!important;page-break-before:avoid!important;color:#fff!important;opacity:1!important}
${p}.pf,${p}.pf *{font-size:10px!important;color:#fff!important;opacity:1!important}
${p}.pf-tagline{font-size:10px!important;color:#fff!important;opacity:1!important}
/* ── ENTERPRISE TABLE ENHANCEMENTS ── */
${p}.dt tr:hover td{background:rgba(168,85,247,.03)}
${p}.dt tbody tr:last-child td{border-bottom:none}
${p}.dt th:first-child,${p}.dt td:first-child{padding-left:3mm}
/* ── SECTION DIVIDERS ── */
${p}.sec-divider{height:1px;background:linear-gradient(90deg,var(--accent2),transparent);margin:5mm 0 4mm;opacity:.3}
${p}.stat-row{display:flex;gap:3mm;margin:3mm 0 4mm}
${p}.stat-item{flex:1;background:linear-gradient(135deg,rgba(168,85,247,.05),rgba(18,24,39,.7));border:1px solid rgba(168,85,247,.12);border-radius:8px;padding:3mm 4mm;text-align:center}
${p}.stat-v{font-family:'Space Mono',monospace;font-size:16px;font-weight:900;color:var(--accent)}
${p}.stat-l{font-size:7.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-top:1mm}
${p}.sc2{border:1px solid var(--border);border-radius:8px;padding:3mm 4mm;background:rgba(255,255,255,.015)}
${p}.score-badge{display:inline-flex;align-items:center;gap:2mm;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);border-radius:20px;padding:2mm 4mm;font-family:'Space Mono',monospace;font-size:12px;font-weight:900;color:white}
/* ── SECTION HEADER LINE ── */
${p}h3{font-size:12.5px;font-weight:700;color:var(--text);margin-top:3.5mm;margin-bottom:1.5mm;padding-bottom:1mm;border-bottom:1px solid rgba(255,255,255,.05);break-after:avoid;page-break-after:avoid}
/* ── PAGE HEADER ── */
${p}.ph{display:flex;justify-content:space-between;align-items:center;padding:0 0 3mm;border-bottom:1px solid var(--border);margin-bottom:4mm;break-after:avoid;page-break-after:avoid}
${p}.phb{display:flex;align-items:center;gap:8px}
${p}.abn{font-size:9px;font-weight:800;color:white;line-height:1.2}
${p}.abs{font-size:7.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
${p}.cb{font-size:8px;font-weight:700;color:var(--accent);letter-spacing:.12em;text-transform:uppercase}
/* ── ABE MONOGRAM ── */
${p}.am{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--accent2),var(--accent));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:white;letter-spacing:-.5px;flex-shrink:0}
/* ── PAGE FOOTER — tagline on every page ── */
${p}.pf{display:flex;justify-content:space-between;align-items:flex-end;margin-top:auto;padding-top:3mm;border-top:1px solid var(--border);font-size:8px;color:var(--muted);break-before:avoid;page-break-before:avoid}
${p}.pf-tagline{font-style:italic;color:var(--faint);font-size:7.5px;letter-spacing:.03em}
/* ── CARDS ── */
${p}.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:4mm 5mm;margin-bottom:3mm}
${p}.card p{font-size:11px;line-height:1.7;color:var(--text);margin:0}
/* ── METRIC NUMBER ── */
${p}.mn{font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:white;line-height:1.1;margin-bottom:1mm}
/* ── BLOCK LABEL ── */
${p}.bl{font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-weight:600}
/* ── ANALYST CALLOUT ── */
${p}.ac{background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.18);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:3mm 4mm;margin:3mm 0;font-size:10.5px;color:var(--text);line-height:1.6}
${p}.ac.amber{background:rgba(245,158,11,.05);border-color:rgba(245,158,11,.25);border-left-color:var(--amber)}
/* ── SECTION CONTEXT ── */
${p}.sc{font-size:10.5px;color:var(--muted);font-style:italic;margin-bottom:4mm;line-height:1.6;border-left:2px solid rgba(168,85,247,.3);padding-left:3mm}
/* ── SECTION HEADER ── */
${p}.section-header{display:flex;align-items:center;gap:3mm;font-size:16px;font-weight:900;color:white;margin:0 0 2mm;letter-spacing:-.3px;break-after:avoid;page-break-after:avoid}
${p}.sa{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
/* ── TAG PILLS ── */
${p}.tg{display:inline-block;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);border-radius:20px;padding:1.5mm 3mm;font-size:8.5px;font-weight:600;color:#c4b5fd;margin:1.5mm 1.5mm 0 0;white-space:nowrap}
${p}.tg.green{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.25);color:#86efac}
${p}.tg.blue{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.25);color:#93c5fd}
${p}.tg.amber{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.25);color:#fcd34d}
${p}.tg.red{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.25);color:#fca5a5}
/* ── SWOT GRID ── */
${p}.sg{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm;margin-bottom:4mm}
${p}.sc2{border:1px solid var(--border);border-radius:8px;padding:3mm 4mm;background:rgba(255,255,255,.015)}
${p}.sl{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;margin-bottom:1.5mm}
${p}.sc2 ul{padding-left:4mm;margin:0}
${p}.sc2 li{font-size:9.5px;color:var(--text);line-height:1.6;margin-bottom:.5mm}
/* ── TAM WATERFALL ── */
${p}.ww{margin:3mm 0 4mm}
${p}.wb{display:flex;align-items:center;gap:3mm;margin-bottom:2.5mm}
${p}.wv{width:90px;font-family:'Space Mono',monospace;font-size:10px;font-weight:700;text-align:right;color:white;flex-shrink:0}
${p}.wftrack{flex:1;background:rgba(255,255,255,.07);border-radius:6px;height:12px;overflow:hidden}
${p}.wf{height:100%;border-radius:6px}
${p}.wfb{background:linear-gradient(90deg,#7c3aed,#a855f7)}
${p}.wfa{background:linear-gradient(90deg,#8b5cf6,#c084fc)}
${p}.wfm{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
/* ── CONFIDENCE MATRIX ── */
${p}.cmrow{margin-bottom:2.5mm}
${p}.cmrow-overall .cmfill{background:linear-gradient(90deg,#5b21b6,#7c3aed,#a855f7,#c084fc)}
${p}.cmhdr{display:flex;justify-content:space-between;margin-bottom:1mm}
${p}.cmlbl{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
${p}.cmscore{font-family:'Space Mono',monospace;font-size:12px;font-weight:900;color:var(--accent)}
${p}.cmtrack{background:rgba(255,255,255,.07);border-radius:5px;height:8px;overflow:hidden}
${p}.cmfill{height:100%;border-radius:5px;background:linear-gradient(90deg,var(--accent2),var(--accent));min-width:3px}
/* ── SDR STEPS ── */
${p}.sdr-step{display:flex;gap:3.5mm;margin-bottom:5mm;break-inside:avoid;page-break-inside:avoid}
${p}.sdr-num{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent2),var(--accent));display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;margin-top:1mm}
${p}.sdr-body{flex:1}
${p}.sdr-angle{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:1.5mm}
${p}.sdr-subject{font-size:12px;font-weight:700;color:white;margin-bottom:2mm;line-height:1.4}
${p}.sdr-preview{font-size:10.5px;color:var(--text);line-height:1.65;white-space:pre-wrap}
/* ── PAGE INSIGHT ── */
${p}.page-insight{background:rgba(168,85,247,.04);border:1px solid rgba(168,85,247,.14);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:3mm 4mm;margin:4mm 0 2mm;break-inside:avoid;page-break-inside:avoid}
${p}.page-insight-title{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.15em;color:var(--accent);margin-bottom:1.5mm}
${p}.page-insight-text{font-size:10px;color:var(--text);line-height:1.6}
${p}.page-insight-expanded{background:rgba(168,85,247,.04);border:1px solid rgba(168,85,247,.14);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:3.5mm 4mm;margin:4mm 0 2mm;break-inside:avoid;page-break-inside:avoid}
${p}.page-insight-grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin-top:2mm}
${p}.mini-label{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm}
${p}.page-insight-demo{font-size:8px;font-style:italic;color:var(--muted);margin-top:2mm;border-top:1px solid var(--border);padding-top:1.5mm}
/* ── NUM HIGHLIGHT ── */
${p}.num{font-family:'Space Mono',monospace;font-weight:700}
${p}.ha{color:var(--amber)}
/* ── DARK TABLE ── */
${p}.dt{width:100%;border-collapse:collapse;font-family:inherit;margin-top:1.5mm;margin-bottom:1.5mm;break-inside:avoid;page-break-inside:avoid}
${p}.dt th{background:#2a2a2a;color:#f0f0f0;font-weight:700;text-align:center;border:.5px solid #444;padding:5px 6px;font-size:9.5px;word-break:break-word;overflow-wrap:anywhere}
${p}.dt td{border:.5px solid #444;padding:5px 6px;font-size:9.5px;vertical-align:top;word-break:break-word;overflow-wrap:anywhere}
${p}.table-wrap{break-inside:avoid;page-break-inside:avoid}
/* ── EDU FILLER ── */
${p}.edu-filler{margin-top:auto;padding:4mm 5mm 4.5mm;background:linear-gradient(135deg,rgba(168,85,247,.035),rgba(18,24,39,.45));border-top:1px dashed rgba(168,85,247,.2);border-left:3px solid rgba(168,85,247,.4);border-right:1px dashed rgba(168,85,247,.12);border-bottom:1px dashed rgba(168,85,247,.12);border-radius:0 8px 8px 0;break-inside:avoid;page-break-inside:avoid}
${p}.edu-filler__badge{display:inline-block;background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.25);border-radius:20px;padding:1mm 3mm;font-size:7.5px;font-weight:700;color:var(--accent);letter-spacing:.08em;margin-bottom:2mm}
${p}.edu-filler__term{font-size:11px;font-weight:800;color:white;margin-bottom:1.5mm}
${p}.edu-filler__definition{font-size:9.5px;color:var(--muted);line-height:1.6;margin-bottom:2mm}
${p}.edu-filler__points{padding-left:4mm;margin:0 0 2mm;font-size:9px;color:var(--text);line-height:1.65}
${p}.edu-filler__protip{font-size:9px;color:var(--amber);border-top:1px solid rgba(245,158,11,.2);padding-top:1.5mm;margin-top:1.5mm}
/* ── FIGURE CAPTIONS ── */
${p}.figure-caption{font-size:9.5px;font-weight:700;color:#f5f5f5;margin:1mm 0 .5mm;break-before:avoid;page-break-before:avoid}
${p}.figure-source{font-size:8px;font-style:italic;color:#aaa;margin:0 0 3mm;break-before:avoid;page-break-before:avoid}
${p}.chart-block{break-inside:avoid;page-break-inside:avoid}
/* ── TABLE NOTE / SOURCE ── */
${p}.table-note,${p}.table-source{font-size:8px;font-style:italic;color:#aaa}
/* ── APPENDIX SECTIONS ── */
${p}.appendix-section{margin-bottom:5mm}
/* ── KEEP TOGETHER ── */
${p}.keep-together{break-inside:avoid;page-break-inside:avoid}
/* ── PHASE 20C VISUAL COMPONENTS ── */
/* KPI Card strip */
${p}.kpi-strip{display:flex;gap:3mm;margin:3mm 0 4mm;break-inside:avoid;page-break-inside:avoid}
${p}.kpi-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:3.5mm 4.5mm;text-align:center;min-width:32mm}
${p}.kpi-value{font-family:'Space Mono',monospace;font-size:17px;font-weight:900;line-height:1.1;margin-bottom:1mm}
${p}.kpi-label{font-size:7px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-top:0.5mm}
${p}.kpi-sub{font-size:8px;color:var(--muted);margin-top:1mm;font-style:italic}
/* Insight box */
${p}.insight-box{background:rgba(168,85,247,.04);border:1px solid rgba(168,85,247,.14);border-radius:0 8px 8px 0;padding:3mm 4mm;margin:3mm 0;break-inside:avoid;page-break-inside:avoid}
${p}.insight-box__title{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.15em;margin-bottom:1.5mm}
${p}.insight-box__body{font-size:10px;color:var(--text);line-height:1.6}
/* Validation note */
${p}.validation-note{font-size:8.5px;font-weight:600;padding:2mm 3.5mm;margin:2mm 0;border-radius:0 6px 6px 0;background:rgba(168,85,247,.04);break-inside:avoid;page-break-inside:avoid}
/* ── PHASE 20D/20E SEGMENTATION ── */
${p}.scope-grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:3mm 0}
${p}.scope-cell{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
${p}.scope-cell__label{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm}
${p}.scope-cell__value{font-size:10px;color:var(--text);line-height:1.55}
${p}.stakeholder-row{display:grid;grid-template-columns:22% 22% 22% 34%;gap:2mm;margin-bottom:2mm;break-inside:avoid;page-break-inside:avoid}
${p}.stakeholder-cell{background:var(--card);border:1px solid var(--border);border-radius:7px;padding:2.5mm 3mm}
${p}.stakeholder-role{font-size:7px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:1mm}
${p}.stakeholder-val{font-size:9px;color:var(--text);line-height:1.45}
/* ── PHASE 20F/20G METHODOLOGY & INSIGHTS ── */
${p}.triangulation-grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:3mm 0}
${p}.triangulation-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3.5mm 4mm}
${p}.triangulation-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.5mm}
${p}.triangulation-title{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
${p}.triangulation-score{font-family:'Space Mono',monospace;font-size:14px;font-weight:900}
${p}.triangulation-status{font-size:7px;font-style:italic;margin-bottom:2.5mm}
${p}.triangulation-items{margin:0;padding:0 0 0 3.5mm;font-size:9px;color:var(--text);line-height:1.5}
${p}.triangulation-items li{margin-bottom:1mm}
${p}.truth-ledger{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm;margin:3mm 0;display:grid;grid-template-columns:1fr 1fr;gap:2.5mm}
${p}.truth-ledger-row{display:flex;flex-direction:column;gap:.5mm}
${p}.truth-ledger-label{font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
${p}.truth-ledger-val{font-size:10px;font-weight:600;color:var(--text)}
/* ── PHASE 20H MARKET OVERVIEW & EVOLUTION ── */
${p}.droc-grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:3mm 0}
${p}.droc-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
${p}.droc-title{font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;margin-bottom:1.5mm}
${p}.droc-items{margin:0;padding:0 0 0 3.5mm;font-size:9px;color:var(--text);line-height:1.5}
${p}.droc-items li{margin-bottom:1.5mm}
${p}.evolution-timeline{position:relative;margin:4mm 0;padding-left:6mm}
${p}.evolution-timeline::before{content:'';position:absolute;top:0;bottom:0;left:13px;width:2px;background:var(--border);border-radius:1px}
${p}.evolution-stage{position:relative;margin-bottom:4mm;break-inside:avoid;page-break-inside:avoid}
${p}.evolution-node{position:absolute;left:-6mm;top:0;width:14px;height:14px;border-radius:50%;background:var(--accent);color:white;font-size:7.5px;font-weight:900;display:flex;align-items:center;justify-content:center;border:2px solid #0B0F1A;z-index:1}
${p}.evolution-content{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm;margin-left:4mm}
${p}.evolution-name{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:white;margin-bottom:1.5mm}
${p}.evolution-change, ${p}.evolution-implication, ${p}.evolution-relevance{font-size:9px;color:var(--text);line-height:1.5;margin-bottom:1mm}
${p}.findings-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:3mm;margin:3mm 0}
${p}.findings-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
${p}.findings-label{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1mm}
${p}.findings-value{font-size:10px;font-weight:600;color:white;line-height:1.4}
/* ── PHASE 20I/20J UPGRADES ── */
${p}.icp-grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:3mm 0}
${p}.icp-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
${p}.icp-label{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm}
${p}.icp-value{font-size:10px;color:var(--text);line-height:1.5}
${p}.sourcing-funnel{display:flex;flex-direction:column;gap:2mm;margin:3mm 0}
${p}.funnel-tier{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
${p}.funnel-label{font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;margin-bottom:1mm}
${p}.funnel-value{font-size:9.5px;color:var(--text);line-height:1.4}
${p}.tier-cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:3mm;margin:3mm 0}
${p}.tier-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
${p}.tier-title{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:1.5mm}
${p}.tier-body{font-size:9.5px;color:var(--text);line-height:1.4}
/* SECTION CONTINUATION (browser-pdf) ── */
${p}.section-continuation{width:100%;box-sizing:border-box;padding:0;margin:0;background:transparent;display:block}
/* ── A4 PRINT DISCIPLINE ── */
@media print {
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  ${p}.page { background: #0B0F1A !important; }
  ${p}.card, ${p}.table-wrap, ${p}.chart-block, ${p}.sdr-step, ${p}.keep-together,
  ${p}.page-insight, ${p}.page-insight-expanded, ${p}.swot-grid, ${p}.ww {
    break-inside: avoid !important; page-break-inside: avoid !important;
    orphans: 3; widows: 3;
  }
  ${p}h1, ${p}h2, ${p}h3, ${p}.section-header { break-after: avoid !important; page-break-after: avoid !important; }
  ${p}.pf, ${p}.figure-caption, ${p}.figure-source { break-before: avoid !important; page-break-before: avoid !important; }
  ${p}tr { break-inside: avoid !important; page-break-inside: avoid !important; }
}
</style>`;

  const bodyContent = `
<div class="${isViewer ? 'abe-viewer-wrapper' : ''}">
<!-- COVER -->
<div class="page" style="position:relative;display:flex;flex-direction:column;justify-content:flex-start;align-items:center;text-align:center;padding:0;overflow:hidden">
<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(168,85,247,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,.025) 1px,transparent 1px);background-size:28px 28px;pointer-events:none"></div>
<div style="position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,var(--accent2),var(--accent),#c084fc)"></div>
<div style="position:absolute;top:-80px;right:-80px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,rgba(124,58,237,.1),transparent 70%);pointer-events:none"></div>
<div style="position:absolute;bottom:40px;left:-60px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(168,85,247,.07),transparent 70%);pointer-events:none"></div>
<div style="position:relative;z-index:1;width:100%;padding:14mm 18mm 0">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10mm">
    <div style="display:flex;align-items:center;gap:8px">
      <div class="am" style="width:38px;height:38px;font-size:13px">ABE</div>
      <div style="text-align:left"><div style="font-size:11px;font-weight:800;color:white">AI Revenue Infrastructure</div><div style="font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">Enterprise GTM Platform</div></div>
    </div>
    <div style="text-align:right">
      <div style="font-size:9px;color:var(--muted)">${date}</div>
      <div style="font-size:8px;font-weight:700;color:var(--accent);letter-spacing:.12em;text-transform:uppercase;margin-top:1mm">Confidential</div>
    </div>
  </div>
  <div style="margin-bottom:5mm">
    <h1 style="font-size:54px;font-weight:900;color:white;letter-spacing:-2px;line-height:1;margin-bottom:3mm">${e(co)}</h1>
    <div style="font-size:13px;font-weight:300;color:var(--muted);letter-spacing:4px;text-transform:uppercase">GTM Intelligence Report</div>
    ${ind ? `<div style="margin-top:3mm"><span class="tg blue" style="font-size:9px">${e(ind)}</span></div>` : ''}
  </div>
  <div class="keep-together chart-block" style="text-align:center; margin-bottom:4mm">
    <div style="display:flex;justify-content:center;">
      ${renderGaugeChart(charts.gauge, score, rec, { width: 280, height: 170 })}
    </div>
    <p class="figure-caption" style="font-size:10px; font-weight:bold; color:#f5f5f5; margin:1mm 0 0.5mm;">Figure 1: GTM Score Gauge</p>
    <p class="figure-source" style="font-size:8px; font-style:italic; color:#aaa; margin:0;">Source: ABE GTMS Engine v1.0</p>
  </div>
  ${renderMetricStrip([
    { label: 'TAM Size',   value: safe(s2.tam_size_estimate) || '—', opts: { color: 'var(--accent)' } },
    { label: 'CAGR',      value: safe(s2.growth_rate) || '—',        opts: { color: 'var(--green)' } },
    { label: 'Verdict',   value: recUp,                               opts: { color: recColor } },
    { label: 'GTM Score', value: (score || '—') + '/100',             opts: { color: 'white' } },
    { label: 'Confidence',value: (confScore || '—') + '/100',         opts: { color: 'var(--amber)' } },
  ], 'cover-kpi')}
  ${(s1.company_overview || s7.strategic_hook) ? `<div class="keep-together" style="max-width:148mm;margin:0 auto 4mm;background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.2);border-left:3px solid var(--accent);border-radius:10px;padding:4mm 5.5mm;text-align:left">
    <div style="font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.2em;color:var(--accent);margin-bottom:2mm">Strategic Positioning</div>
    <div style="font-size:10.5px;color:var(--text);line-height:1.65">${e(strategicPositioning)}.</div>
  </div>`: ''}
  <div class="keep-together" style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:3mm 4mm;max-width:148mm;margin:0 auto;text-align:left">
    <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:1.5mm">Report Sections</div>
    <div style="display:flex;flex-wrap:wrap;gap:1.5mm;align-items:center">
      ${['01 Market', '02 TAM', '03 ICP', '04 Sourcing', '05 Keywords', '06 SDR'].map(s => `<span style="font-size:7.5px;color:var(--green);font-weight:700">${s}</span><span style="color:var(--faint);font-size:8px">·</span>`).join('')}
      <span style="font-size:7.5px;color:var(--amber);font-weight:700">07 Intelligence</span>
    </div>
  </div>
</div>
<div style="position:absolute;bottom:12mm;left:0;right:0;font-size:8px;color:var(--faint);text-align:center;z-index:1;letter-spacing:.05em">Classification: CONFIDENTIAL — Not for External Distribution</div>
</div>
<!-- EXECUTIVE SUMMARY -->
<div class="page section-break" id="exec-summary">
${pageHdr()}
${secHead('ES', 'Executive Summary')}
${secCtx('Establishes the macro-opportunity and win-probability. Provides the highest-leverage vector for outbound strategy.')}
<div class="card" style="border-left:3px solid var(--accent)"><p style="font-size:12px;line-height:1.85;color:var(--text)">${e(s7.executive_brief || s1.company_overview || 'Strategic evaluation of market conditions and buyer readiness.')}</p></div>
${renderMetricStrip([
  { label: 'TAM Size',    value: safe(s2.tam_size_estimate) || '—', opts: { color: 'var(--accent)' } },
  { label: 'CAGR',       value: safe(s2.growth_rate) || '—',        opts: { color: 'var(--green)' } },
  { label: 'Confidence', value: (confScore || '—') + '/100',         opts: { color: 'var(--amber)' } },
  { label: 'Verdict',    value: recUp,                               opts: { color: recColor } },
  { label: 'GTM Score',  value: (score || '—') + '/100',             opts: { color: 'white' } },
])}
${srcNote('TAM/CAGR: AI market estimate; Relevance: algorithmic scoring; Verdict: composite signal analysis')}
${callout(s1.gtm_relevance_reasoning || s1.analyst_insight || '')}
${renderPageInsightBlock('executive_summary', strategy, isDemoMode)}
${buildFillerBlock('exec', renderMode)}
${pageFtr('Executive Summary', 1)}
</div>

<!-- PHASE 20D: STUDY OBJECTIVE & REPORT SCOPE -->
<div class="page section-break" id="study-objective">
${pageHdr()}
${secHead('RS', 'Study Objective & Report Scope')}
${secCtx('Defines the analytical boundaries, evidence claims, and validation limitations of this GTM Intelligence Report.')}
${h3('appendix', '1', 'What This Report Analyses')}
<div class="scope-grid keep-together">
  <div class="scope-cell"><div class="scope-cell__label">GTM Opportunity Scope</div><div class="scope-cell__value">${e(safe(s1.market_position) || safe(ind) || 'Requires source validation')} — commercial opportunity sizing based on available market signals.</div></div>
  <div class="scope-cell"><div class="scope-cell__label">ICP / Buyer Analysis Scope</div><div class="scope-cell__value">${e(primaryICP || 'Requires source validation')} — decision-maker identification from strategy inputs.</div></div>
  <div class="scope-cell"><div class="scope-cell__label">TAM / SAM / SOM Scope</div><div class="scope-cell__value">${e(safe(s2.tam_size_estimate) || 'AI estimate')} TAM — derived using geography eligibility, service-line fit, and win-rate factors.</div></div>
  <div class="scope-cell"><div class="scope-cell__label">Competitive / Market Interpretation</div><div class="scope-cell__value">SWOT and growth signals inferred from available data. Not a substitute for primary analyst research.</div></div>
</div>
${h3('appendix', '2', 'What This Report Does Not Claim')}
${renderInsightBox('Validation Limitations',
  'This report does not guarantee market share, close rates, or revenue outcomes. TAM/SAM/SOM are AI estimates unless company data overrides defaults. Buying committee map is inferred from ICP inputs. All figures require independent validation before boardroom use.',
  { accent: 'var(--amber)' })}
${renderValidationNote('All AI-estimated fields are marked. Validate with primary analyst data before decisioning.', 'warn')}
${pageFtr('Study Objective \u2014 Report Scope', 2)}
</div>

<!-- PHASE 20D: MARKET DEFINITION -->
<div class="page section-break" id="market-definition">
${pageHdr()}
${secHead('MD', 'Market Definition')}
${secCtx('Establishes the precise market category, adjacent spaces, and the analytical lens applied to this GTM assessment.')}
${renderDarkTable({
  headers: ['Dimension', 'Detail'],
  rows: [
    ['Target Market Category', safe(s1.market_position) || safe(ind) || 'Requires source validation'],
    ['Adjacent Markets',       safe(s1.products_services) || 'Requires source validation'],
    ['Included Scope',         safe(s1.company_overview)  || 'Products and services within the defined ICP universe'],
    ['Excluded Scope',         safe(s4.exclusion_criteria) || 'Pre-revenue, non-B2B, outside target geography'],
    ['Market Lens Selected',   safe(s2.market_maturity) ? 'Maturity stage: ' + safe(s2.market_maturity) : 'AI-assessed market stage'],
    ['GTM Implication',        score >= 75 ? 'High-readiness market — initiate outbound now' : score >= 50 ? 'Watch-and-validate — monitor for catalyst event' : 'Limited fit — re-evaluate in 90 days']
  ]
}, '', 'ABE GTMS Engine v1.0')}
${h3('appendix', '2', 'GTM Implication by Market Position')}
${renderDarkTable({
  headers: ['GTM Motion', 'When to Use', 'Evidence Required'],
  rows: [
    ['Land & Expand',      'Established buyer category; proven TAM',       'Win-rate data + case studies'],
    ['Category Creation',  'Emerging need; low awareness',                 'Intent signals + SWOT threats'],
    ['Competitive Displacement', 'Incumbent relationships identified',     'Differentiation proof + objection map'],
    ['Harvest Existing',   'High maturity; retention focus',               'NRR data + expansion triggers']
  ]
}, 'Select the motion matching this report\'s market definition.', 'ABE GTMS Engine v1.0')}
${renderValidationNote('Market definition is AI-inferred from strategy inputs. Validate with primary market research.', 'info')}
${pageFtr('Market Definition', 3)}
</div>

<!-- PHASE 20D: YEARS CONSIDERED / FORECAST WINDOW -->
<div class="page section-break" id="forecast-window">
${pageHdr()}
${secHead('FW', 'Years Considered / Forecast Window')}
${secCtx('Establishes the temporal boundaries of market signals, baseline assumptions, and the GTM execution horizon.')}
${renderDarkTable({
  headers: ['Period', 'Window', 'Confidence / Validation Note'],
  rows: [
    ['Historical Signal Window', '12–24 months prior to report date', 'Based on available strategy inputs — extend if richer signal data exists'],
    ['Base Year',                new Date().getFullYear().toString(),  'Report generated: ' + date],
    ['Estimated Year',           String(new Date().getFullYear() + 1), 'TAM / market estimates anchored to this horizon'],
    ['Projected GTM Window',     '12–36 months',                       'AI forecast — validate with CRM pipeline and analyst reports'],
    ['30-Day Execution',         'Immediate outbound initiation',      score >= 75 ? 'Recommended — strong signals present' : 'Conditional — validate ICP fit first'],
    ['60-Day Execution',         'Sequence optimisation + follow-up',  'Monitor reply rates and adjust targeting'],
    ['90-Day Execution',         'Pipeline qualification review',      'Re-score accounts; escalate high-fit signals to AE']
  ]
}, 'Forecast windows are directional. All projections require validation against live pipeline data.', 'ABE GTMS Engine v1.0')}
${renderMetricStrip([
  { label: 'Base Year',    value: String(new Date().getFullYear()),        opts: { color: 'var(--accent)' } },
  { label: 'GTM Horizon', value: '12-36 months',                           opts: { color: 'var(--green)' } },
  { label: 'CAGR Est.',   value: safe(s2.growth_rate) || 'Pending',        opts: { color: 'var(--amber)' } },
  { label: 'GTM Score',   value: (score || '—') + '/100',                  opts: { color: recColor } },
  { label: 'Confidence',  value: (confScore || '—') + '/100',              opts: { color: 'var(--muted)' } },
])}
${renderValidationNote('All forecast windows are AI-estimated. Validate with CRM, analyst, and market data before committing execution resources.', 'warn')}
${pageFtr('Forecast Window', 4)}
</div>

<!-- PHASE 20D: STAKEHOLDER & BUYING COMMITTEE MAP -->
<div class="page section-break" id="stakeholder-map">
${pageHdr()}
${secHead('BC', 'Stakeholder & Buying Committee Map')}
${secCtx('Maps the decision-making unit, messaging angles, and proof requirements for each stakeholder role.')}
${(() => {
  const dms   = arr(s3.decision_makers);
  const trigs = arr(s3.buying_triggers);
  const roles = [
    { role: 'Economic Buyer',     value: dms[0] || 'Requires source validation',          msg: 'ROI recovery, cost of delay, CFO-level framing',     proof: 'Business case with quantified efficiency gain' },
    { role: 'Technical Buyer',    value: dms[1] || 'Requires source validation',          msg: 'Integration depth, security posture, architecture fit', proof: 'Technical spec sheet, security certification' },
    { role: 'Functional Buyer',   value: safe(s3.primary_icp) || 'Requires source validation', msg: 'Workflow reduction, productivity lift, ease of use', proof: 'Case study from peer organisation' },
    { role: 'Influencer',         value: trigs[0] ? 'Champion aligned to: ' + trigs[0] : 'Requires source validation', msg: 'Internal advocacy; peer referral', proof: 'Social proof, community endorsement' },
    { role: 'Gatekeeper',         value: 'Executive assistant / CoS',                    msg: 'Brevity, credibility, pre-vetted agenda',             proof: 'One-page brief, warm intro' },
    { role: 'Procurement / Legal',value: 'Procurement lead',                             msg: 'Risk mitigation, SLA compliance, contract terms',     proof: 'Vendor risk assessment, compliance docs' },
    { role: 'End User',           value: dms[2] || 'Operational team',                   msg: 'Ease of adoption, training burden, daily UX',        proof: 'Demo, trial, peer testimonial' },
  ];
  return roles.map(r => `<div class="stakeholder-row keep-together">
    <div class="stakeholder-cell"><div class="stakeholder-role">${escapeHtml(r.role)}</div><div class="stakeholder-val" style="color:var(--accent);font-weight:700">${escapeHtml(r.value)}</div></div>
    <div class="stakeholder-cell" style="grid-column:span 1"><div class="stakeholder-role">Messaging Angle</div><div class="stakeholder-val">${escapeHtml(r.msg)}</div></div>
    <div class="stakeholder-cell" style="grid-column:span 2"><div class="stakeholder-role">Proof Required</div><div class="stakeholder-val">${escapeHtml(r.proof)}</div></div>
  </div>`).join('');
})()}
${arr(s3.objections).length ? `${h3('icp-modeling', '2', 'Common Objections by Role')}${renderDarkTable({ headers: ['Objection', 'Typical Stakeholder', 'Counter'], rows: arr(s3.objections).slice(0, 4).map(o => [e(String(o)), 'Economic or Technical Buyer', 'Quantify the cost of inaction and lead with peer proof']) }, '', 'ABE GTMS Engine v1.0')}` : ''}
${renderValidationNote('Buying committee roles are inferred from ICP and decision-maker inputs. Validate role map with discovery calls.', 'info')}
${pageFtr('Stakeholder Map', 5)}
</div>

<!-- PHASE 20E: MARKET SEGMENTATION FRAMEWORK -->
<div class="page section-break" id="segmentation-framework">
${pageHdr()}
${secHead('SF', 'Market Segmentation Framework')}
${secCtx('Defines the multi-dimensional segmentation view for prioritised GTM targeting and resource allocation.')}
${(() => {
  const offeringItems  = safe(s1.products_services) || 'Requires source validation';
  const serviceItems   = safe(s4.filter_criteria)    || 'Requires source validation';
  const buyerItems     = primaryICP                  || 'Requires source validation';
  const geoItems       = safe(s4.estimated_universe) || safe(ind) || 'Requires source validation';
  const motionVerdict  = score >= 75 ? 'Land & Expand' : score >= 50 ? 'Watch & Validate' : 'Re-evaluate';
  return renderSegmentationGrid([
    { dimension: 'By Offering / Product Type',    items: offeringItems,                                             primaryFit: safe(s1.market_position) || 'AI inferred',       secondaryFit: safe(s2.market_maturity) || 'AI inferred',    status: offeringItems !== 'Requires source validation' ? 'Partial — validate' : 'Validation pending' },
    { dimension: 'By Service Type / Capability',  items: serviceItems,                                              primaryFit: safe(s4.recommended_databases) || 'AI inferred',  secondaryFit: 'Requires source validation',                  status: serviceItems  !== 'Requires source validation' ? 'Partial — validate' : 'Validation pending' },
    { dimension: 'By Buyer Type / End User',       items: buyerItems + (secondaryICP ? '; ' + secondaryICP : ''),   primaryFit: safe(s3.firmographics) || 'AI inferred',          secondaryFit: safe(s3.deal_cycle) || 'AI inferred',          status: !isPhICP(s3.primary_icp) ? 'Partial — validate' : 'Validation pending' },
    { dimension: 'By Organisation Size',           items: safe(s3.firmographics) || 'Requires source validation',  primaryFit: '200-800 employees (default ICP band)',           secondaryFit: '800-5000 enterprise',                         status: safe(s3.firmographics) ? 'Partial — validate' : 'Validation pending' },
    { dimension: 'By Business Function',           items: arr(s3.decision_makers).slice(0,3).join('; ') || 'Requires source validation', primaryFit: 'Revenue Operations', secondaryFit: 'Sales & Marketing', status: arr(s3.decision_makers).length ? 'Partial — validate' : 'Validation pending' },
    { dimension: 'By Geography',                   items: geoItems,                                                 primaryFit: safe(s4.estimated_universe) || 'AI inferred',    secondaryFit: 'Requires source validation',                  status: safe(s4.estimated_universe) ? 'Partial — validate' : 'Validation pending' },
    { dimension: 'By GTM Motion',                  items: motionVerdict,                                            primaryFit: recUp + ' — ' + (score || 0) + '/100',           secondaryFit: 'Watch for trigger event',                     status: score ? 'Validated — algorithmic' : 'Validation pending' },
  ]);
})()}
${renderValidationNote('Segmentation framework is AI-derived from available strategy inputs. Each dimension should be cross-referenced with primary research before resource allocation.', 'warn')}
${pageFtr('Segmentation Framework', 6)}
</div>

<!-- PHASE 20F: RESEARCH METHODOLOGY -->
<div class="page section-break" id="research-methodology">
${pageHdr()}
${secHead('RM', 'Research Methodology & Evidence Ledger')}
${secCtx('Documents the provenance of assertions, data constraints, and validation boundaries applied to the report.')}
${h3('appendix', '1', 'Evidence Ledger')}
${renderMethodologyLedger([
  { category: 'Company Evidence',    dataUsed: safe(s1.company_overview) ? 'Provided strategy description' : 'Requires source validation', notValidated: 'Financials, historic revenue growth' },
  { category: 'Market Evidence',     dataUsed: safe(s1.market_position) ? 'Provided market categorization' : 'Requires source validation',  notValidated: 'Primary analyst share metrics' },
  { category: 'GTM Evidence',        dataUsed: safe(s3.deal_cycle) ? 'Provided deal cycle metrics' : 'Requires source validation',          notValidated: 'Win rates, NRR, CAC' },
  { category: 'Competitive Evidence',dataUsed: safe(s2.priority_opportunities) ? 'Provided differentiation notes' : 'Validation pending',    notValidated: 'Head-to-head win/loss analysis' },
  { category: 'Signal Evidence',     dataUsed: arr(s5.intent_signals).length ? 'Provided intent signals' : 'Requires source validation',    notValidated: 'Live 30-day intent volume' }
])}
${h3('appendix', '2', 'Validation Layer')}
${renderInsightBox('Confidence Architecture',
  'All conclusions operate within a determinist scoring cap. AI inferences cannot supersede missing baseline data. Confidence is inherently limited until CRM pipeline integration validates target engagement.',
  { accent: 'var(--amber)' })}
${renderValidationNote('This is an indicative intelligence document. Boardroom-level reliance requires corroborating the unvalidated items listed above.', 'warn')}
${pageFtr('Research Methodology', 7)}
</div>

<!-- PHASE 20F: DATA TRIANGULATION -->
<div class="page section-break" id="data-triangulation">
${pageHdr()}
${secHead('DT', 'Data Triangulation & Confidence')}
${secCtx('Assesses the cross-validation strength of the primary data pillars and overall systemic risk.')}
${h3('appendix', '1', 'Pillar Assessment')}
${renderTriangulationGrid([
  { title: 'Company Evidence', score: safe(s1.company_overview) ? 'High' : 'Low',  status: safe(s1.company_overview) ? 'Validated' : 'Estimate risk', items: ['Core value proposition', 'Offering definition', 'Pricing tiering (missing)'] },
  { title: 'Market Evidence',  score: safe(s2.tam_size_estimate) ? 'Med' : 'Low',  status: safe(s2.tam_size_estimate) ? 'Partial Validation' : 'High estimate risk', items: ['TAM boundaries', 'CAGR directionality', 'Competitor matrix (missing)'] },
  { title: 'GTM Evidence',     score: arr(s3.buying_triggers).length ? 'Med' : 'Low', status: arr(s3.buying_triggers).length ? 'Partial Validation' : 'Estimate risk', items: ['Buying triggers', 'Sales cycle length', 'Historical win-rate (missing)'] },
  { title: 'Signal Quality',   score: confScore + '/100',                          status: confScore >= 75 ? 'Validated' : confScore >= 50 ? 'Partial Validation' : 'High risk', items: ['Algorithmically scored', 'Capped by data completeness', 'Veracity check applied'] }
])}
${h3('appendix', '2', 'Truth Ledger Summary')}
${renderTruthLedgerSummary({
  richness: (s7._data_quality?.richness_score || 'Low') + ' — ' + (strategy.steps_completed || 6) + '/7 steps complete',
  freshness: 'Point-in-time generation (' + date + ')',
  risk: safe(s3.deal_cycle) && safe(s4.estimated_universe) ? 'Moderate — baseline parameters supplied' : 'High — reliant on AI interpolation',
  priority: !safe(s3.primary_icp) ? 'Immediate: Define primary buyer persona' : !safe(s4.estimated_universe) ? 'Immediate: Map actual universe size' : 'Pipeline conversion validation'
})}
${renderValidationNote('Systemic risk is elevated where cross-validation between pillars cannot occur due to missing source data.', 'warn')}
${pageFtr('Data Triangulation', 8)}
</div>

<!-- PHASE 20G: PREMIUM GTM INSIGHTS -->
<div class="page section-break" id="premium-insights">
${pageHdr()}
${secHead('PI', 'Premium GTM Insights')}
${secCtx('Distilled, high-leverage strategic vectors derived from the cross-pillar triangulation.')}
<div class="scope-grid keep-together">
  <div class="scope-cell"><div class="scope-cell__label">Most Attractive GTM Opportunity</div><div class="scope-cell__value" style="color:var(--accent);font-weight:600">${e(safe(s2.priority_opportunities) || 'Requires source validation')}</div></div>
  <div class="scope-cell"><div class="scope-cell__label">Recommended GTM Motion</div><div class="scope-cell__value" style="color:var(--green);font-weight:600">${score >= 75 ? 'Land & Expand (High Readiness)' : score >= 50 ? 'Watch & Validate' : 'Re-evaluate'}</div></div>
  <div class="scope-cell"><div class="scope-cell__label">Best-Fit Business Function</div><div class="scope-cell__value">${e(arr(s3.decision_makers)[0] || 'Requires source validation')}</div></div>
  <div class="scope-cell"><div class="scope-cell__label">Highest-Intent Signal</div><div class="scope-cell__value">${e(arr(s5.intent_signals)[0] || 'Requires source validation')}</div></div>
</div>
${h3('appendix', '1', 'Strategic Drivers & Restraints')}
${renderDarkTable({
  headers: ['Vector', 'Insight', 'Action Priority'],
  rows: [
    ['Main Growth Driver', safe(s1.growth_signals) ? String(arr(s1.growth_signals)[0]) : 'Validation pending', 'High'],
    ['Main GTM Restraint', safe(s3.objections) ? String(arr(s3.objections)[0]) : 'Validation pending', 'Critical'],
    ['Fastest-Growing Buyer', secondaryICP || primaryICP || 'Validation pending', 'Medium'],
    ['Target Geography', safe(s4.estimated_universe) || 'Validation pending', 'High']
  ]
}, 'Derived from step 1, 3, and 4 telemetry.', 'ABE GTMS Engine v1.0')}
${renderMetricStrip([
  { label: 'Verdict',      value: recUp,                       opts: { color: recColor, flex: '2' } },
  { label: 'GTM Score',    value: (score || '—') + '/100',     opts: { color: 'white' } },
  { label: 'Risk Profile', value: confScore >= 75 ? 'Low' : confScore >= 50 ? 'Medium' : 'High', opts: { color: confScore >= 75 ? 'var(--green)' : confScore >= 50 ? 'var(--amber)' : 'var(--red)' } }
])}
${renderValidationNote('Premium insights synthesize the core findings of the report. They represent the highest-probability path based strictly on the provided evidence.', 'info')}
${pageFtr('Premium GTM Insights', 9)}
</div>

<!-- PHASE 20H: MARKET OVERVIEW & DYNAMICS -->
<div class="page section-break" id="market-overview">
${pageHdr()}
${secHead('MO', 'Market Overview & Dynamics')}
${secCtx('Assesses fundamental market forces, demand/supply imbalances, and macroeconomic pressure points.')}
${h3('appendix', '1', 'Market Context')}
<div class="card keep-together">
  <p style="font-size:10.5px;line-height:1.6">${e(safe(s1.company_overview) || 'Market overview and context require source validation. System assumes standard B2B SaaS dynamics in absence of direct input.')}</p>
</div>
${h3('appendix', '2', 'Market Forces')}
${renderDarkTable({
  headers: ['Force', 'Observation', 'GTM Implication'],
  rows: [
    ['Demand-side movement', safe(s1.growth_signals) ? String(arr(s1.growth_signals)[0]) : 'Validation pending', score >= 50 ? 'Tailwind present' : 'Stagnant demand'],
    ['Supply-side movement', safe(s2.priority_opportunities) ? 'Emerging differentiation' : 'Validation pending', 'Requires clear positioning'],
    ['Enterprise buying pressure', safe(s3.objections) ? String(arr(s3.objections)[0]) : 'Validation pending', 'Budget scrutiny increasing']
  ]
}, 'Observations are derived from available strategy telemetry.', 'ABE GTMS Engine v1.0')}
${h3('appendix', '3', 'DROC Analysis (Drivers, Restraints, Opportunities, Challenges)')}
${renderDrocGrid({
  drivers: arr(s1.growth_signals).slice(0,2).map(g => ({ title: 'Growth Driver', explanation: String(g), implication: 'Accelerates deal velocity' })),
  restraints: arr(s3.objections).slice(0,2).map(o => ({ title: 'Market Restraint', explanation: String(o), implication: 'Lengthens sales cycle' })),
  opportunities: [{ title: 'Strategic Opening', explanation: safe(s2.priority_opportunities) || 'Requires validation', implication: 'Primary target segment' }],
  challenges: [{ title: 'Macro Challenge', explanation: safe(s1.market_position) ? 'Establishing share in ' + safe(s1.market_position) : 'Requires validation', implication: 'Requires strong differentiation' }]
})}
${renderValidationNote('DROC dynamics are synthesised from provided strategy inputs. Validate via primary analyst research.', 'info')}
${pageFtr('Market Overview', 10)}
</div>

<!-- PHASE 20H: MARKET EVOLUTION -->
<div class="page section-break" id="market-evolution">
${pageHdr()}
${secHead('ME', 'Market Evolution Timeline')}
${secCtx('Traces the structural shifts in the market to determine the current maturity phase and required GTM approach.')}
${h3('appendix', '1', 'Evolutionary Stages')}
${renderMarketEvolutionTimeline([
  { name: 'Traditional Selling', change: 'Relationship-led, field sales dependency.', implication: 'Inefficient scale, high CAC.', relevance: 'Low (Legacy)' },
  { name: 'Digital-First GTM', change: 'Inbound marketing, marketing automation.', implication: 'Volume over quality, declining conversion.', relevance: 'Low (Commoditized)' },
  { name: 'CRM / RevOps Era', change: 'Centralised data, specialised SDR/AE roles.', implication: 'Process efficiency, siloed intelligence.', relevance: 'Medium (Baseline)' },
  { name: 'Data-Driven Outbound', change: 'Intent data, firmographic filtering.', implication: 'Better targeting, noisy execution.', relevance: 'High (Current standard)' },
  { name: 'AI-Assisted GTM', change: 'Personalisation at scale, predictive scoring.', implication: 'Higher relevance, lower manual effort.', relevance: 'High (Emerging standard)' },
  { name: 'Agentic Revenue Intelligence', change: 'Autonomous reasoning, dynamic triangulation.', implication: 'Deterministic execution, zero-hallucination.', relevance: 'Very High (Target state)' }
])}
${renderInsightBox('Maturity Assessment',
  'The target market is currently transitioning between Data-Driven Outbound and AI-Assisted GTM. Outbound strategies must move beyond simple intent filtering to multi-signal triangulation to achieve breakout conversion rates.',
  { accent: 'var(--accent)' })}
${renderValidationNote('Evolutionary timeline represents standard B2B SaaS progression. Industry-specific nuances require validation.', 'info')}
${pageFtr('Market Evolution', 11)}
</div>

<!-- PHASE 20H: KEY FINDINGS -->
<div class="page section-break" id="key-findings">
${pageHdr()}
${secHead('KF', 'Key Findings & Directives')}
${secCtx('Consolidated strategic directives and immediate execution priorities derived from the full intelligence assessment.')}
${h3('appendix', '1', 'Strategic Baseline')}
${renderKeyFindingsGrid([
  { label: 'Best-Fit ICP', value: primaryICP || 'Requires validation', color: 'var(--accent)' },
  { label: 'Highest Priority Segment', value: safe(s2.priority_opportunities) || 'Requires validation', color: 'var(--accent)' },
  { label: 'Strongest Buyer Pain', value: safe(s3.core_pain_points) || 'Requires validation', color: 'var(--accent)' },
  { label: 'Weakest Evidence Area', value: (s7._data_quality?.richness_score < 50) ? 'Platform Data' : 'Competitor Matrix', color: 'var(--amber)' },
  { label: 'Highest Potential GTM', value: score >= 75 ? 'Direct Outbound' : 'Nurture & Watch', color: 'var(--green)' },
  { label: 'Main Execution Blocker', value: arr(s3.objections)[0] || 'Requires validation', color: 'var(--red)' },
  { label: 'Competitive Gap', value: safe(s1.products_services) ? 'Feature parity' : 'Requires validation', color: 'var(--amber)' },
  { label: 'Segment to Avoid', value: safe(s4.exclusion_criteria) || 'Requires validation', color: 'var(--red)' },
  { label: '90-Day Recommendation', value: score >= 50 ? 'Launch pilot sequence' : 'Complete data validation', color: 'var(--green)' }
])}
${h3('appendix', '2', 'Go / No-Go Decision')}
<div class="keep-together" style="background:rgba(18,24,39,.9);border:1px solid rgba(245,158,11,.25);border-bottom:3px solid ${/go$/i.test(rec) && !/no/i.test(rec) ? 'var(--green)' : /no/i.test(rec) ? 'var(--red)' : 'var(--amber)'};border-radius:12px;padding:5mm 6mm;text-align:center;margin:4mm 0">
  <div style="font-family:'Space Mono',monospace;font-size:24px;font-weight:900;color:${recColor}">${e(recUp)}</div>
  <div style="font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:2mm">Algorithmic Verdict</div>
  <div style="font-size:10px;color:var(--text);margin-top:2.5mm;line-height:1.5">${e(safe(s1.gtm_relevance_reasoning) || 'Validation required prior to execution.')}</div>
</div>
${renderValidationNote('Findings reflect the algorithmic assessment of provided data. A final human-in-the-loop review is mandatory before committing execution resources.', 'warn')}
${pageFtr('Key Findings', 12)}
</div>

<!-- STEP 1: MARKET RESEARCH -->
<div class="page section-break" id="market-research">
${pageHdr()}
${secHead('01', 'Market Research — The Context')}
${secCtx(s1.section_context || 'Deconstructs market positioning and isolates specific macro-triggers.')}
${h3('market-research', '1', 'Company Overview')}
<div class="card keep-together"><p>${e(safe(s1.company_overview) || '—')}</p></div>
${h3('market-research', '2', 'Market Position & Stage')}
${renderDarkTable({
    headers: ['Attribute', 'Value'],
    rows: [
      ['Market Position', safe(s1.market_position)],
      ['Revenue Stage', safe(s1.revenue_stage)],
      ['Employee Count', safe(s1.employee_count)],
      ['Products/Services', safe(s1.products_services)]
    ].filter(r => r[1])
  }, '', 'ABE GTMS Engine v1.0')}
${h3('market-research', '3', 'SWOT Analysis')}
${swotGrid()}
${h3('market-research', '4', 'Strategic Growth Signals')}
<div class="keep-together" style="margin-bottom:3mm">${tags(s1.growth_signals, 'green')}</div>
${h3('market-research', '5', 'Tech Stack Indicators')}
<div class="keep-together" style="display:flex;flex-wrap:wrap;gap:2mm;margin-bottom:3mm">${arr(s1.tech_stack_hints).slice(0, 6).map(t => `<div style="display:inline-flex;align-items:center;gap:2mm;background:rgba(59,130,246,.07);border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:1.5mm 3mm"><svg width="8" height="8" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="2" stroke="#93c5fd" stroke-width="1.2"/><path d="M4 6h4M6 4v4" stroke="#93c5fd" stroke-width="1" stroke-linecap="round"/></svg><span style="font-size:8.5px;font-weight:600;color:#93c5fd">${e(String(t))}</span></div>`).join('')}</div>
${callout(s1.analyst_insight)}
${renderPageInsightBlock('market_research', strategy, isDemoMode)}
${buildFillerBlock('market', renderMode)}
${pageFtr('Market Research', 13)}
</div>

<!-- STEP 2: TAM MAPPING -->
<div class="page section-break" id="tam-mapping">
${pageHdr()}
${secHead('02', 'TAM Mapping — The Opportunity')}
${secCtx(s2.section_context || 'Quantifies total market velocity and filters it to actionable scope.')}
${h3('tam-mapping', '1', 'Market Sizing')}
${renderMetricStrip([
  { label: 'TAM',      value: formatCurrency(s2.tam_size_estimate, 'Requires market validation'), opts: { color: 'var(--accent)', sub: 'Total Addressable' } },
  { label: 'SAM',      value: formatCurrency(s2.sam_estimate, 'Requires market validation'),       opts: { color: '#8b5cf6',      sub: 'Serviceable' } },
  { label: 'SOM',      value: formatCurrency((s2.waterfall || {}).som_value, 'Requires market validation'), opts: { color: 'var(--amber)', sub: 'Obtainable' } },
  { label: 'CAGR',     value: formatPercent(s2.growth_rate, 'Requires market validation'),        opts: { color: 'var(--green)',  sub: 'Growth Rate' } },
  { label: 'Maturity', value: (() => { const mv = safe(s2.market_maturity) || 'Requires market validation'; return mv.length > 14 ? mv.split(/[,—]/)[0].trim() : mv; })(), opts: { color: 'var(--amber)', sub: 'Market Stage' } },
])}
${renderValidationNote('Market sizing is directional and requires source validation before commercial use.', 'warn')}
${h3('tam-mapping', '2', 'Market Sizing Formula & Assumptions')}
<div class="keep-together" style="display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin-bottom:3mm">
  <div class="card" style="border-top:3px solid var(--accent)">
    <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:2mm">Waterfall Logic</div>
    <ul style="margin:0;padding-left:4mm;font-size:9px;color:var(--text);line-height:1.6">
      <li><strong>TAM:</strong> Total market universe for this category.</li>
      <li><strong>SAM:</strong> Reachable market based on offering/geography fit.</li>
      <li><strong>SOM:</strong> Realistic capture zone based on fit, capacity, and execution window.</li>
    </ul>
  </div>
  <div class="card" style="border-top:3px solid var(--amber)">
    <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--amber);margin-bottom:2mm">Baseline Assumptions</div>
    <ul style="margin:0;padding-left:4mm;font-size:9px;color:var(--text);line-height:1.6">
      <li><strong>Market Sizing:</strong> Algorithmic industry estimate.</li>
      <li><strong>Geographic:</strong> Defaults to global unless specified.</li>
      <li><strong>Service/Product Fit:</strong> 30-40% conservative.</li>
      <li><strong>Capture Rate:</strong> 8-12% enterprise benchmark.</li>
      <li><strong>Limitations:</strong> Highly reliant on CRM validation.</li>
    </ul>
  </div>
</div>
${h3('tam-mapping', '3', 'Visual Waterfall')}
<div class="keep-together chart-block">
  ${renderChartOrFallback('TAM Waterfall', charts.waterfall, waterfall(), { width: 480, height: 180 })}
  <p class="figure-caption" style="font-size:10px; font-weight:bold; color:#f5f5f5; margin:1mm 0 0.5mm;">Figure 2: TAM → SAM → SOM Waterfall</p>
  <p class="figure-source" style="font-size:8px; font-style:italic; color:#aaa; margin:0;">Source: ABE GTMS Engine v1.0</p>
</div>
${h3('tam-mapping', '4', 'Segment Opportunity Prioritisation')}
${renderSegmentOpportunityTable([
  { segment: _cleanICP(safe(s2.priority_opportunities) || 'Primary Focus'), size: 'Requires market validation', growth: 'Validation pending', urgency: 'Moderate pending live validation', fit: 'Moderate confidence pending source validation', priority: 'Watch', status: 'Validation pending' }
])}
${callout(s2.analyst_insight, 'amber')}
${renderPageInsightBlock('tam_mapping', strategy, isDemoMode)}
${buildFillerBlock('tam', renderMode)}
${pageFtr('TAM Analysis', 14)}
</div>

<!-- STEP 3: ICP MODELING -->
<div class="page section-break" id="icp-modeling">
${pageHdr()}
${secHead('03', 'ICP Modeling — The Persona')}
${secCtx(s3.section_context || 'Identifies decision-makers and maps operational pain directly to solutions.')}
${h3('icp-modeling', '1', 'ICP Profile Breakdown')}
${renderIcpProfileGrid({
  primary: primaryICP,
  secondary: secondaryICP,
  firmographics: s3.firmographics,
  technographics: s1.tech_stack_hints ? arr(s1.tech_stack_hints).join(', ') : '',
  triggers: arr(s3.buying_triggers).join(', ')
})}
${h3('icp-modeling', '2', 'Decision Makers & Buying Committee')}
${renderBuyingCommitteeTable([
  { role: 'Economic Buyer', title: arr(s3.decision_makers)[0], focus: 'ROI recovery, CFO-level framing', proof: 'Business case' },
  { role: 'Technical Buyer', title: arr(s3.decision_makers)[1], focus: 'Integration depth, architecture fit', proof: 'Security certification' },
  { role: 'Functional Buyer', title: arr(s3.decision_makers)[2], focus: 'Workflow reduction, ease of use', proof: 'Peer case study' }
])}
${h3('icp-modeling', '3', 'Core Pain Points & Objections')}
<div class="keep-together" style="display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin-bottom:3mm">
  <div class="card" style="border-top:3px solid var(--amber)">
    <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--amber);margin-bottom:2mm">Buying Triggers</div>
    <ul style="margin:0;padding-left:4mm;font-size:9px;color:var(--text);line-height:1.6">
      ${arr(s3.buying_triggers).length ? arr(s3.buying_triggers).map(t => `<li>${e(String(t))}</li>`).join('') : '<li style="color:var(--muted);font-style:italic">Requires source validation</li>'}
    </ul>
  </div>
  <div class="card" style="border-top:3px solid var(--red)">
    <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--red);margin-bottom:2mm">Common Objections</div>
    <ul style="margin:0;padding-left:4mm;font-size:9px;color:var(--text);line-height:1.6">
      ${arr(s3.objections).length ? arr(s3.objections).map(o => `<li>${e(String(o))}</li>`).join('') : '<li style="color:var(--muted);font-style:italic">Requires source validation</li>'}
    </ul>
  </div>
</div>
${callout(s3.analyst_insight)}
${renderPageInsightBlock('icp_modeling', strategy, isDemoMode)}
${buildFillerBlock('icp', renderMode)}
${pageFtr('ICP Modeling', 15)}
</div>

<div class="page section-break" id="account-sourcing">
${pageHdr()}
${secHead('04', 'Account Sourcing — The Targets')}
${secCtx(s4.section_context || 'Translates persona into actionable technographic filters and sourcing logic.')}
${h3('account-sourcing', '1', 'Sourcing Architecture')}
${renderDarkTable({
  headers: ['Criteria', 'Configuration', 'Validation Status'],
  rows: [
    ['Recommended Channels', safe(s4.recommended_databases) || 'Crunchbase, LinkedIn Sales Nav', 'Requires source validation'],
    ['Inclusion Criteria', safe(s4.filter_criteria) || 'Company size 200–800 employees, B2B', 'Requires source validation'],
    ['Exclusion Criteria', safe(s4.exclusion_criteria) || 'Pre-revenue, non-B2B', 'Requires source validation'],
    ['Qualification Filters', 'Intent data cross-reference, CRM stage check', 'Validation pending'],
    ['Account Scoring Logic', 'Fit score + engagement recency', 'Validation pending']
  ]
}, '', 'ABE GTMS Engine v1.0')}
${h3('account-sourcing', '2', 'Account Tiering Funnel')}
${renderAccountSourcingFunnel({
  tier1: 'Enterprise target, matching firmographics, active intent signals, recognized tech stack.',
  tier2: 'Mid-market, matching firmographics, latent need, no active intent.',
  watchlist: 'Growth stage, incomplete tech stack, monitoring for trigger event.'
})}
${h3('account-sourcing', '3', 'Priority Sourcing Targets')}
${renderAccountTierCards(arr(s4.target_accounts))}
${callout(s4.analyst_insight)}
${renderPageInsightBlock('account_sourcing', strategy, isDemoMode)}
${buildFillerBlock('sourcing', renderMode)}
${pageFtr('Account Sourcing', 16)}
</div>

<!-- STEP 5: KEYWORDS & INTENT -->
<div class="page section-break" id="keywords-intent">
${pageHdr()}
${secHead('05', 'Keywords & Intent Intelligence')}
${secCtx(s5.section_context || 'Maps the semantic footprint before RFP issuance and decodes intent signals.')}
${h3('keywords-intent', '1', 'Keyword Arsenal')}
<div class="keep-together" style="margin-bottom:3mm"><strong style="font-size:9px;color:var(--muted)">PRIMARY KEYWORDS</strong><br>${tags(s5.primary_keywords, 'green')}</div>
<div class="keep-together" style="margin-bottom:3mm"><strong style="font-size:9px;color:var(--muted)">SECONDARY KEYWORDS</strong><br>${tags(s5.secondary_keywords, 'blue')}</div>
${kwTaxonomy()}
${s5.boolean_query ? `${h3('keywords-intent', '3', 'Boolean Query String')}<div class="card keep-together"><code style="font-family:'Space Mono',monospace;font-size:10px;color:#c4b5fd;word-break:break-all">${e(safe(s5.boolean_query))}</code></div>` : ''}
${s5.linkedin_search_strings ? `${h3('keywords-intent', '4', 'LinkedIn Search String')}<div class="card keep-together"><code style="font-family:'Space Mono',monospace;font-size:10px;color:#93c5fd;word-break:break-all">${e(safe(s5.linkedin_search_strings))}</code></div>` : ''}
<div class="keep-together" style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">INTENT SIGNALS</strong><br>${tags(s5.intent_signals, 'amber')}</div>
${charts.intent
      ? `<div class="keep-together chart-block" style="margin:3mm 0 5mm"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2mm">INTENT SIGNAL STRENGTH</div>${renderChartOrFallback('Intent Signal', charts.intent, '', { width: 480, height: 180 })}<p class="figure-caption" style="font-size:10px; font-weight:bold; color:#f5f5f5; margin:1mm 0 0.5mm;">Figure 3: Intent Signal Strength</p><p class="figure-source" style="font-size:8px; font-style:italic; color:#aaa; margin:0;">Source: ABE GTMS Engine v1.0</p></div>`
      : ''
    }
<div class="keep-together" style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">CONTENT TOPICS</strong><br>${tags(s5.content_topics, 'blue')}</div>
${callout(s5.analyst_insight)}
${renderPageInsightBlock('keywords_intent', strategy, isDemoMode)}
${buildFillerBlock('keywords', renderMode)}
${pageFtr('Keywords & Intent', 17)}
</div>

<!-- STEP 6: ENTERPRISE SDR SEQUENCE — PAGE 8: EMAILS -->
<div class="page section-break" id="sdr-emails">
${pageHdr()}
${secHead('06', 'Enterprise SDR Sequence — The Engagement')}
${secCtx(s6.section_context || 'Hyper-targeted sequences designed to agitate pain and validate scalability.')}
${h3('sdr-sequence', '1', '3-Touch Triggered Sequence')}
${emailBlock('email_1', 0)}
${emailBlock('email_2', 1)}
${emailBlock('email_3', 2)}
${renderPageInsightBlock('sdr_sequence', strategy, isDemoMode)}
${buildFillerBlock('sdr', renderMode)}
${pageFtr('Engagement Playbook — Emails', 18)}
</div>

<!-- STEP 6 CONTINUED — SDR FOLLOW-UP + SOCIAL -->
<div class="${renderMode === 'browser-pdf' ? 'section-continuation' : 'page'}" id="sdr-social">
${renderMode !== 'browser-pdf' ? pageHdr() : ''}
${renderMode !== 'browser-pdf' ? secHead('06', 'Enterprise SDR Sequence — Follow-up & Social') : h3('sdr-sequence', '2', 'Follow-up Cadence & Social')}
${renderMode !== 'browser-pdf' ? secCtx('Cadence continuation and LinkedIn direct outreach hook.') : ''}
${s6.follow_up_sequence ? `${h3('sdr-sequence', '2', 'Follow-up Cadence')}<div class="card keep-together"><p>${e(safe(s6.follow_up_sequence))}</p></div>` : `${h3('sdr-sequence', '2', 'Follow-up Cadence')}<div class="card keep-together"><p>Send Email 1 → wait 3 days → Email 2 → reach out on LinkedIn → follow-up call attempt.</p></div>`}
<!-- Visual cadence timeline -->
<div class="keep-together" style="margin:4mm 0 3mm">
  <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-bottom:3mm">ENGAGEMENT TIMELINE</div>
  <div style="display:flex;align-items:center;gap:0">
    ${[['Day 1', 'Email 1', 'var(--accent)'], ['Day 4', 'Email 2', 'var(--accent)'], ['Day 7', 'LinkedIn', '#3b82f6'], ['Day 10', 'Call', 'var(--green)'], ['Day 14', 'Final', 'var(--amber)']].map((item, i, arr) => `<div style="display:flex;align-items:center;flex:1">
      <div style="text-align:center;flex:1">
        <div style="width:32px;height:32px;border-radius:50%;background:${item[2]};border:2px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:white;margin:0 auto 2mm">${i + 1}</div>
        <div style="font-size:8px;font-weight:700;color:white">${item[1]}</div>
        <div style="font-size:7px;color:var(--muted)">${item[0]}</div>
      </div>
      ${i < 4 ? `<div style="flex:0 0 20px;height:1.5px;background:linear-gradient(90deg,${item[2]},${arr[i + 1][2]});opacity:.4"></div>` : ''}
    </div>`).join('')}
  </div>
</div>
${s6.linkedin_message ? `${h3('sdr-sequence', '3', 'LinkedIn Hook')}<div class="card keep-together" style="border-left:3px solid #3b82f6"><p style="font-size:11.5px"><strong>Direct Message:</strong><br><br>"${e(safe(s6.linkedin_message))}"</p></div>` : ''}
${s6.linkedin_follow_up ? `${h3('sdr-sequence', '4', 'LinkedIn Follow-up')}<div class="card keep-together"><p>${e(safe(s6.linkedin_follow_up))}</p></div>` : ''}
${h3('sdr-sequence', '5', 'Objection Handling')}
${renderObjectionHandlingTable(s6.objection_handling)}
${h3('sdr-sequence', '6', 'Call to Action Strategy')}
${renderCtaTable(s6.cta_strategy)}
<!-- Channel best-practice strip -->
<div class="keep-together" style="margin-top:4mm">
  <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-bottom:2.5mm">CHANNEL PERFORMANCE BENCHMARKS</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2.5mm">
    <div style="background:rgba(168,85,247,.05);border:1px solid rgba(168,85,247,.15);border-radius:8px;padding:3mm 3.5mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:var(--accent)">15–25%</div>
      <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:1mm">Email Open Rate<br>Enterprise B2B</div>
    </div>
    <div style="background:rgba(59,130,246,.05);border:1px solid rgba(59,130,246,.15);border-radius:8px;padding:3mm 3.5mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:#93c5fd">3–5%</div>
      <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:1mm">Reply Rate<br>Cold Outbound</div>
    </div>
    <div style="background:rgba(34,197,94,.05);border:1px solid rgba(34,197,94,.15);border-radius:8px;padding:3mm 3.5mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:var(--green)">3–5x</div>
      <div style="font-size:7.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:1mm">Multi-Touch Lift<br>vs Single Touch</div>
    </div>
  </div>
</div>
${callout(s6.analyst_insight)}
${renderPageInsightBlock('followup_social', strategy, isDemoMode)}
${buildFillerBlock('sdr', renderMode)}
${pageFtr('Engagement Playbook \u2014 Cadence', 19)}
</div>

<!-- PHASE 20K: COMPETITIVE LANDSCAPE -->
<div class="page section-break" id="competitive-landscape">
${pageHdr()}
${secHead('CL', 'Competitive Landscape')}
${secCtx((strategy.competitive_landscape?.section_context) || 'Mapping the competitive field: categories, relative strengths, and threat level by player.')}
${h3('competitive-landscape', '1', 'Competitor Category Table')}
${renderCompetitorCategoryTable(
  strategy.competitive_landscape?.competitors ||
  (() => {
    // Synthesise a lightweight fallback from market research data if available
    const s1data = s1;
    const raw = s1data.competitive_landscape || s1data.competitors || s1data.swot?.threats || [];
    if (!Array.isArray(raw) || !raw.length) return [];
    return raw.slice(0, 6).map((item, i) => ({
      name: typeof item === 'string' ? item : (item.name || `Competitor ${i + 1}`),
      category: 'Market Leader',
      strength: typeof item === 'object' ? (item.strength || 'Established market presence') : 'Established market presence',
      weakness: typeof item === 'object' ? (item.weakness || 'Requires source validation') : 'Requires source validation',
      threat_level: i === 0 ? 'High' : i <= 2 ? 'Medium' : 'Low',
      notes: ''
    }));
  })()
)}
${h3('competitive-landscape', '2', 'Competitive Positioning Summary')}
${renderInsightBox(
  'Competitive Context',
  strategy.competitive_landscape?.positioning_summary ||
  s1.competitive_landscape ||
  s7.competitive_context ||
  'Competitive data not provided. Add a competitive_landscape.positioning_summary field to include validated positioning intelligence.',
  { accent: 'var(--accent)' }
)}
${callout(strategy.competitive_landscape?.analyst_insight || s1.analyst_insight)}
${pageFtr('Competitive Landscape', 20)}
</div>

<!-- PHASE 20K: RIGHT-TO-WIN ANALYSIS -->
<div class="page section-break" id="right-to-win">
${pageHdr()}
${secHead('RW', 'Right-to-Win Analysis')}
${secCtx((strategy.competitive_landscape?.rtw_context) || 'Evaluating our advantage on each win dimension versus identified competitors. Used to prioritise competitive response and messaging.')}
${h3('right-to-win', '1', 'Right-to-Win Table')}
${renderRightToWinTable(
  strategy.competitive_landscape?.right_to_win ||
  (() => {
    // Auto-derive from Step 7 signals when no explicit data is available
    const derived = [];
    if (s1.value_proposition)   derived.push({ dimension: 'Value Proposition',   our_advantage: safeBusinessText(s1.value_proposition, ''), competitor_gap: 'Requires source validation', win_condition: 'Validate with deal win/loss data', confidence: 'Medium' });
    if (s7.icp_fit || s3.primary_icp) derived.push({ dimension: 'ICP Alignment',        our_advantage: safeBusinessText(s3.primary_icp || 'Defined ICP match', ''), competitor_gap: 'Broader, less targeted', win_condition: 'Outbound precision over volume', confidence: 'Medium' });
    if (s2.tam_size_estimate)   derived.push({ dimension: 'TAM Coverage',         our_advantage: safeBusinessText(s2.tam_size_estimate, ''), competitor_gap: 'Similar addressable universe', win_condition: 'SOM capture via niche focus', confidence: 'Low' });
    if (!derived.length)        derived.push({ dimension: 'Go-to-Market Fit',     our_advantage: 'Requires source validation', competitor_gap: 'Requires source validation', win_condition: 'Requires source validation', confidence: 'Low' });
    return derived;
  })()
)}
${h3('right-to-win', '2', 'Company / Account Evaluation Matrix')}
<div style="font-size:8.5px;color:var(--muted);margin-bottom:3mm">2×2 matrix: account fit on the X-axis, buyer urgency on the Y-axis. Classify each target account across four quadrants to prioritise sales motion.</div>
${render2x2EvalMatrix(strategy.competitive_landscape?.eval_matrix || [])}
${renderInsightBox(
  'Evaluation Guidance',
  strategy.competitive_landscape?.eval_notes ||
  'Populate competitive_landscape.eval_matrix with account objects (name, quadrant, fit_score, urgency, rationale) to classify your target accounts. Quadrant options: strategic · emerging · watchlist · low-fit.',
  { accent: 'var(--blue)' }
)}
${callout(strategy.competitive_landscape?.rtw_analyst_insight)}
${pageFtr('Right-to-Win Analysis', 21)}
</div>

<!-- PHASE 20L: PORTER'S FIVE FORCES: GTM LENS -->
<div class="page section-break" id="porter-five-forces">
${pageHdr()}
${secHead('P5', "Porter's Five Forces: GTM Lens")}
${secCtx((strategy.strategy_context?.porter_context) || "Porter's Five Forces mapped to the GTM lens: how each structural force shapes buyer behaviour, competitive positioning, and outbound strategy.")}
${h3('porter-five-forces', '1', 'Five Forces Analysis')}
${renderPorterForcesGrid(
  strategy.strategy_context?.porter_forces ||
  [
    {
      force: 'Threat of New Entrants',
      rating: 'Medium',
      explanation: safeBusinessText(s1.barriers_to_entry || s1.market_dynamics, 'Market entry barriers not evaluated — requires source validation.'),
      gtm_implication: 'New entrants may commoditise messaging — lead with differentiated proof points and switching cost narratives.',
      recommended_action: 'Validate barrier-to-entry evidence before finalising competitive positioning.',
      validation_status: 'Validation pending'
    },
    {
      force: 'Threat of Substitutes',
      rating: 'Medium',
      explanation: safeBusinessText(s1.substitutes || s1.alternative_solutions, 'Substitute products or services not evaluated — requires source validation.'),
      gtm_implication: 'Substitutes create alternative budget paths — anchor messaging on total cost of ownership and unique outcomes.',
      recommended_action: 'Map top 3 substitute categories and quantify switching cost per ICP segment.',
      validation_status: 'Validation pending'
    },
    {
      force: 'Supplier / Vendor Power',
      rating: 'Low',
      explanation: 'Vendor concentration and dependency levels not validated from source data. Inferred as low-to-medium based on typical SaaS / enterprise market structure.',
      gtm_implication: 'Low supplier power supports margin stability — position as preferred vendor with long-term partnership narrative.',
      recommended_action: 'Validate vendor lock-in and concentration risk from analyst sources before boardroom use.',
      validation_status: 'Validation pending'
    },
    {
      force: 'Buyer Power',
      rating: 'High',
      explanation: safeBusinessText(s3.buying_triggers || s7.icp_fit, 'Buyer power level not validated from source data. Enterprise buyers typically hold concentrated negotiating power.'),
      gtm_implication: 'High buyer power requires proof-led selling — lead with ROI case studies, references, and risk-reduction messaging.',
      recommended_action: 'Build a proof library anchored to the primary ICP segment. Validate before outbound execution.',
      validation_status: 'Validation pending'
    },
    {
      force: 'Competitive Rivalry',
      rating: 'High',
      explanation: safeBusinessText(s1.competitive_landscape || s7.competitive_context, 'Competitive rivalry level inferred from market context — validate with analyst data before use in exec decks.'),
      gtm_implication: 'High rivalry compresses decision timelines — urgency-led messaging and differentiation are critical to pipeline velocity.',
      recommended_action: 'Validate competitor count and deal-cycle benchmarks. Use Right-to-Win table to sharpen differentiation messaging.',
      validation_status: 'Validation pending'
    }
  ]
)}
${renderInsightBox(
  'Porter\'s Five Forces — GTM Interpretation',
  strategy.strategy_context?.porter_summary ||
  'These five forces determine the structural attractiveness of the market and directly shape outbound strategy. High buyer power and high competitive rivalry are the two forces most likely to compress deal cycles and require proof-led selling. Validate all force ratings with primary research before boardroom presentation.',
  { accent: 'var(--accent)' }
)}
${pageFtr("Porter's Five Forces", 22)}
</div>

<!-- PHASE 20L: BUYING CRITERIA MATRIX -->
<div class="page section-break" id="buying-criteria">
${pageHdr()}
${secHead('BC', 'Buying Criteria Matrix')}
${secCtx((strategy.strategy_context?.buying_criteria_context) || 'Enterprise buying decisions are evaluated across multiple criteria. This matrix maps each criterion to the buyer concern, proof required, and recommended GTM response.')}
${h3('buying-criteria', '1', 'Enterprise Buying Criteria')}
${renderBuyingCriteriaTable(
  strategy.strategy_context?.buying_criteria ||
  [
    { criteria: 'ROI',                   buyer_concern: 'Will this investment generate measurable return within the budget cycle?',               importance: 'Critical', proof_required: 'ROI case study, payback period model, before/after metric comparison', gtm_message: 'Lead with quantified ROI — time-to-value and cost-of-inaction framing', recommended_action: 'Build a 1-page ROI calculator for the primary ICP segment', validation_status: 'Validation pending' },
    { criteria: 'Time to Value',          buyer_concern: 'How quickly will we see results after deployment?',                                   importance: 'Critical', proof_required: 'Implementation timeline, customer ramp benchmarks, onboarding SLA',         gtm_message: 'Quantify time-to-first-value milestone in the first outreach touch',   recommended_action: 'Validate ramp timeline from customer success data before use',   validation_status: 'Validation pending' },
    { criteria: 'Integration Complexity', buyer_concern: 'Will this connect cleanly with our existing tech stack?',                            importance: 'High',     proof_required: 'Integration partner list, API documentation, certified connector evidence', gtm_message: 'Lead with native integrations relevant to the ICP\'s tech stack',       recommended_action: 'Map integrations to the top-5 tech stack combinations in the ICP', validation_status: 'Validation pending' },
    { criteria: 'Security',               buyer_concern: 'Does this meet our data security and access control requirements?',                  importance: 'Critical', proof_required: 'SOC 2 / ISO 27001 / relevant certifications — verify before claiming',      gtm_message: 'Reference security posture early in enterprise conversations',           recommended_action: 'Do not claim specific certifications without verification. Validate before use.', validation_status: 'Validation pending' },
    { criteria: 'Vendor Credibility',     buyer_concern: 'Is this vendor stable, reference-able, and backed by credible customers?',          importance: 'High',     proof_required: 'Logo references in the ICP segment, analyst mentions, funding signal',  gtm_message: 'Lead with relevant customer logos and measurable outcomes',              recommended_action: 'Curate a reference list of 5 accounts in the primary ICP segment', validation_status: 'Validation pending' },
    { criteria: 'Compliance',             buyer_concern: 'Does this solution support our regulatory and data residency obligations?',          importance: 'High',     proof_required: 'Compliance frameworks supported — validate before claiming in enterprise deals', gtm_message: 'Acknowledge compliance requirements proactively in discovery calls', recommended_action: 'Do not assert specific regulatory compliance without legal validation.', validation_status: 'Validation pending' },
    { criteria: 'Scalability',            buyer_concern: 'Will this scale with our growth plans over the next 3–5 years?',                   importance: 'High',     proof_required: 'Customer scale benchmarks, architecture evidence, enterprise tier capabilities', gtm_message: 'Frame scalability as a long-term partnership — not just a point solution', recommended_action: 'Validate scale benchmarks from product and CS teams before use', validation_status: 'Validation pending' },
    { criteria: 'Support Model',          buyer_concern: 'What level of ongoing support and SLA coverage is included?',                        importance: 'Medium',   proof_required: 'SLA documentation, support tier comparison, customer success model',   gtm_message: 'Position enterprise support as a differentiator vs point-solution vendors', recommended_action: 'Validate support SLA tier details before including in proposals', validation_status: 'Validation pending' },
    { criteria: 'Implementation Risk',    buyer_concern: 'What is the risk of project failure, scope creep, or resource drag?',               importance: 'High',     proof_required: 'Implementation methodology, project governance model, risk mitigation evidence', gtm_message: 'Reduce perceived risk with a structured onboarding commitment and milestone-based rollout', recommended_action: 'Validate implementation success rate data before use in exec presentations', validation_status: 'Validation pending' },
  ]
)}
${renderInsightBox(
  'Buying Criteria — GTM Activation',
  strategy.strategy_context?.buying_criteria_summary ||
  'Use this matrix to align outreach, demo structure, and proposal content to the highest-importance buying criteria for the primary ICP. Critical criteria (ROI, Security, Time to Value) must be addressed in the first outbound touch. All proof claims should be validated before use in boardroom or procurement contexts.',
  { accent: 'var(--blue)' }
)}
${pageFtr('Buying Criteria Matrix', 23)}
</div>

<!-- PHASE 20M: TECHNOLOGY / CAPABILITY ANALYSIS -->
<div class="page section-break" id="capability-analysis">
${pageHdr()}
${secHead('CA', 'Technology / Capability Analysis')}
${secCtx((strategy.strategy_context?.capability_context) || 'Mapping capabilities across core, complementary, and adjacent dimensions to identify where the offering creates buyer value and where evidence is still required.')}
${h3('capability-analysis', '1', 'Capability Landscape')}
${renderCapabilityLandscape(
  strategy.strategy_context?.capabilities ||
  [
    { group: 'Core',          capability: 'Primary Product Capability',       buyer_value: safeBusinessText(s1.value_proposition || s7.strategic_hook, 'Requires source validation — add value_proposition to Step 1 data.'), maturity_signal: 'Validation pending — requires customer evidence or analyst reference', gtm_implication: 'Lead messaging with core capability proof points for the primary ICP',              validation_status: 'Validation pending' },
    { group: 'Core',          capability: 'Data / Intelligence Layer',        buyer_value: 'Provides actionable signal for buyer decision-making cycles',                                                                          maturity_signal: 'Validation pending',                                                              gtm_implication: 'Frame data capability as a competitive moat in enterprise conversations',            validation_status: 'Validation pending' },
    { group: 'Core',          capability: 'Workflow Automation',              buyer_value: 'Reduces manual intervention and compresses operational timelines',                                                                     maturity_signal: 'Validation pending',                                                              gtm_implication: 'Quantify hours saved per week per ICP role in outreach personalisation',              validation_status: 'Validation pending' },
    { group: 'Complementary', capability: 'Integration Ecosystem',           buyer_value: 'Extends value by connecting to existing enterprise tech stack',                                                                        maturity_signal: 'Validation pending',                                                              gtm_implication: 'Reference native integrations in the ICP\'s preferred stack during outreach',         validation_status: 'Validation pending' },
    { group: 'Complementary', capability: 'Reporting & Analytics',           buyer_value: 'Enables executive-level visibility and ROI tracking',                                                                                  maturity_signal: 'Validation pending',                                                              gtm_implication: 'Use reporting capability to satisfy CFO and CRO buying criteria in enterprise deals', validation_status: 'Validation pending' },
    { group: 'Adjacent',      capability: 'AI / ML Augmentation',            buyer_value: 'Accelerates pattern recognition and reduces human error in key workflows',                                                            maturity_signal: 'Validation pending',                                                              gtm_implication: 'Position AI capability as a future-readiness signal — validate with product team first', validation_status: 'Validation pending' },
    { group: 'Adjacent',      capability: 'Partner / Channel Extensibility',  buyer_value: 'Enables ecosystem growth and reduces single-vendor dependency risk',                                                                    maturity_signal: 'Validation pending',                                                              gtm_implication: 'Reference partner network when selling to platform-oriented enterprise accounts',      validation_status: 'Validation pending' },
  ]
)}
${renderInsightBox(
  'Capability — GTM Guidance',
  strategy.strategy_context?.capability_summary ||
  'Core capabilities are the primary proof points for the first outbound touch. Complementary capabilities support the business case in evaluation. Adjacent capabilities reduce long-term risk and increase platform stickiness. All capability claims must be validated with product and customer success teams before use in enterprise proposals.',
  { accent: 'var(--green)' }
)}
${pageFtr('Technology / Capability Analysis', 24)}
</div>

<!-- PHASE 20M: REGULATORY & RISK LANDSCAPE -->
<div class="page section-break" id="regulatory-risk">
${pageHdr()}
${secHead('RR', 'Regulatory & Risk Landscape')}
${secCtx((strategy.strategy_context?.regulatory_context) || 'Mapping buyer-perceived regulatory and procurement risks. All items reflect inferred buyer concerns — not verified legal claims. Validate with legal counsel before boardroom use.')}
${h3('regulatory-risk', '1', 'Risk Landscape Table')}
${renderRegulatoryRiskTable(
  strategy.strategy_context?.regulatory_risks ||
  [
    { risk_area: 'Data Privacy',       buyer_concern: 'How is personal and sensitive data stored, processed, and transferred?',                          gtm_impact: 'Can block procurement in regulated sectors if not addressed early',             mitigation_message: 'Address data privacy posture in the first enterprise meeting — not in legal review', required_proof: 'Data processing agreement, privacy policy, data residency options — validate before claiming', validation_status: 'Validation pending' },
    { risk_area: 'Procurement',        buyer_concern: 'Does this vendor meet procurement approval thresholds and preferred vendor requirements?',         gtm_impact: 'Long procurement cycles compress deal velocity for mid-market and enterprise',   mitigation_message: 'Offer a structured procurement support package and pre-approved MSA templates',          required_proof: 'Preferred vendor status evidence or procurement process documentation',                     validation_status: 'Validation pending' },
    { risk_area: 'Compliance',         buyer_concern: 'Does this solution support our industry-specific compliance obligations?',                         gtm_impact: 'Compliance gaps can cause deal loss at legal review stage',                     mitigation_message: 'Do not assert specific compliance certifications without verification. Validate first.',  required_proof: 'Compliance framework documentation — validated by legal team',                              validation_status: 'Validation pending' },
    { risk_area: 'Security Review',    buyer_concern: 'Will this pass our InfoSec and penetration testing requirements?',                                 gtm_impact: 'Security delays are a common late-stage deal blocker in enterprise',            mitigation_message: 'Proactively share security questionnaire responses and architecture documentation',       required_proof: 'Security questionnaire, pen test summary, access control documentation',                     validation_status: 'Validation pending' },
    { risk_area: 'AI Governance',      buyer_concern: 'How is AI used in the product, and what controls exist over model outputs?',                      gtm_impact: 'AI governance concerns are increasing across regulated and large enterprise buyers', mitigation_message: 'Be transparent about AI use cases, explainability, and human-in-the-loop controls',   required_proof: 'AI governance policy, model card or explainability documentation — validate before use',    validation_status: 'Validation pending' },
    { risk_area: 'Vendor Lock-in',     buyer_concern: 'What is the exit cost if we need to migrate away from this vendor?',                              gtm_impact: 'Lock-in concerns increase in multi-year contract negotiations',                 mitigation_message: 'Offer data portability, open API access, and clear off-boarding terms upfront',          required_proof: 'Data export capability documentation, API access policy',                                    validation_status: 'Validation pending' },
    { risk_area: 'Budget Approval',    buyer_concern: 'What approval authority and finance sign-off is required for this purchase?',                     gtm_impact: 'Budget approval cycles extend deal timelines — especially above CFO thresholds', mitigation_message: 'Build a CFO-ready business case deck with ROI, payback, and risk-reduction narrative',  required_proof: 'Budget threshold data for the ICP segment — validate with sales team before use',          validation_status: 'Validation pending' },
  ]
)}
${renderInsightBox(
  'Risk — GTM Activation',
  strategy.strategy_context?.regulatory_summary ||
  'Address the highest-impact risks (Data Privacy, Security Review, Compliance) in discovery — not in legal review. Proactive risk mitigation can reduce friction in enterprise deal cycles when supported by validated proof. All claims in this section require independent validation before boardroom presentation.',
  { accent: 'var(--amber)' }
)}
${pageFtr('Regulatory & Risk Landscape', 25)}
</div>

<!-- STEP 7: REVENUE INTELLIGENCE — Decision Engine -->
<div class="page section-break" id="decision-engine">
${pageHdr()}
${renderMetricStrip([
  { label: 'GTM Score',  value: (score || '—') + '/100',    opts: { color: recColor } },
  { label: 'Verdict',   value: recUp,                       opts: { color: recColor } },
  { label: 'Confidence',value: (confScore || '—') + '/100', opts: { color: confScore >= 75 ? 'var(--green)' : confScore >= 50 ? 'var(--amber)' : 'var(--red)' } },
  { label: 'Signal Ver.',value: veracity + '/40',           opts: { color: 'var(--accent)' } },
  { label: 'ICP Fit',   value: icpFit + '/20',              opts: { color: 'var(--blue)' } },
])}
${decisionEngineSummary()}
${renderPageInsightBlock('decision_engine', strategy, isDemoMode)}
${buildFillerBlock('decision', renderMode)}
${pageFtr('Revenue Intelligence', 26)}
</div>

<!-- STEP 7: REVENUE INTELLIGENCE — Risk & Execution -->
<div class="page section-break" id="decision-engine-risk">
${pageHdr()}
${secHead('07', 'Revenue Intelligence — Risk & Execution')}
${secCtx('Assesses implementation risks and dictates the immediate strategic execution path.')}
${decisionEngineRisk()}
${renderPageInsightBlock('decision_engine_risk', strategy, isDemoMode)}
${buildFillerBlock('decision_risk', renderMode)}
${pageFtr('Risk & Execution', 27)}
</div>

<!-- STEP 7 CONTINUED: CONFIDENCE MATRIX -->
<div class="${renderMode === 'browser-pdf' ? 'section-continuation' : 'page'}" id="confidence-matrix">
${renderMode !== 'browser-pdf' ? pageHdr() : ''}
${renderMode !== 'browser-pdf' ? secHead('07', 'Revenue Intelligence — Confidence Matrix') : h3('revenue-intelligence', '6', 'Weighted Confidence Matrix')}
${renderMode !== 'browser-pdf' ? secCtx('Weighted fidelity assessment of signal quality, market timing, and ICP alignment.') : ''}
<div class="confidence-matrix keep-together chart-block">
${renderChartOrFallback('Confidence Matrix', charts.confidence,
      `<div style="display:flex;gap:6mm;align-items:flex-start">${(() => {
        const circ = 176, filled = Math.round((confScore / 100) * circ);
        const gc = confScore >= 75 ? 'var(--green)' : confScore >= 50 ? 'var(--amber)' : 'var(--red)';
        return `<svg width="90" height="90" viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
      <circle cx="45" cy="45" r="28" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="9"/>
      <circle cx="45" cy="45" r="28" fill="none" stroke="${gc}" stroke-width="9" stroke-dasharray="${filled} ${circ}" stroke-dashoffset="${Math.round(circ * 0.25)}" stroke-linecap="round" transform="rotate(-90 45 45)"/>
      <text x="45" y="42" text-anchor="middle" font-family="monospace" font-size="16" font-weight="900" fill="white">${confScore}</text>
      <text x="45" y="54" text-anchor="middle" font-size="6.5" fill="#6B7280" letter-spacing="1">FIDELITY</text>
    </svg><div style="flex:1">${renderConfidenceFallback(veracity, timing, icpFit, completeness, confScore)}</div>`
      })()}</div>`,
      { width: 480, height: 200 }
    )}
<p class="figure-caption" style="font-size:10px; font-weight:bold; color:#f5f5f5; margin:1mm 0 0.5mm;">Figure 5: Weighted Confidence Matrix</p>
<p class="figure-source" style="font-size:8px; font-style:italic; color:#aaa; margin:0;">Source: ABE GTMS Engine v1.0</p>
</div>
${srcNote('Confidence score is algorithmic — weights fixed (40/25/20/15), capped by data richness')}
${renderPageInsightBlock('confidence_matrix', strategy, isDemoMode)}
${callout(s7.analyst_insight)}
${buildFillerBlock('confidence', renderMode)}
${pageFtr('Revenue Intelligence \u2014 Confidence', 28)}
</div>

<!-- APPENDIX — single flowing section, renders once, always last -->
<div class="page section-break" id="appendix">
${pageHdr()}
${secHead('A', 'Appendix — Methodology, Data Quality &amp; Truth Ledger')}
${secCtx('Transparency layer. Documents data provenance, scoring methodology, and known limitations.')}

${tm.validationWarnings?.length ? `
<div class="card" style="border-left:3px solid var(--amber); margin-bottom:5mm">
  <div class="label" style="color:var(--amber)">TRUTH VALIDATION WARNINGS</div>
  <ul style="font-size:10px; color:var(--text); margin:2mm 0 0 4mm; padding:0;">
    ${tm.validationWarnings.map(w => `<li>${e(w)}</li>`).join('')}
  </ul>
</div>` : ''}

<div class="appendix-section">
${h3('appendix', '1', 'Data Quality & Truth Audit')}
<div style="background:rgba(245,158,11,0.05);border-radius:6px;padding:12px;margin-bottom:14px;border:1px solid rgba(245,158,11,0.2)">
  <div style="display:flex;justify-content:space-between;margin-bottom:8px">
    <span style="font-size:11px;font-weight:700;color:var(--amber)">Truth Confidence: ${tm.truthConfidence || 0}/100</span>
    <span style="font-size:11px;font-weight:700;color:var(--amber)">Status: ${tm.truthConfidence >= 80 ? 'Validated' : 'Estimate'}</span>
  </div>
</div>

${h3('appendix', '2', 'Data Sources & Provenance')}
${renderProvenanceTable()}
</div>
<div class="appendix-section">
${h3('appendix', '3', 'TAM Calculation Methodology')}
${renderDarkTable({
      headers: ['Step', 'Method'],
      rows: [
        ['1. Global TAM', 'AI estimate from industry classification, public market reports, and comparable company analysis'],
        ['2. Geography filter', 'Uses company-provided geography_eligibility when available; defaults to conservative 60-70%'],
        ['3. Service-line fit', 'Uses company-provided service_line_fit when available; defaults to conservative 30-40%'],
        ['4. Win rate', 'Uses company-provided win_rate when available; defaults to 8-12% (enterprise benchmark)'],
        ['5. SOM derivation', 'Product of steps 1-4; dynamic values override defaults when strategy data provides them']
      ]
    }, '', 'ABE GTMS Engine v1.0')}
${h3('appendix', '4', 'Assumption Ledger')}
${renderAssumptionLedger()}
${h3('appendix', '5', 'Confidence Scoring Explanation')}
${renderDarkTable({
      headers: ['Dimension', 'Weight', 'Description'],
      rows: [
        ['Signal Veracity', '<span class="num">40%</span>', 'Verified source density, recency, and explicitness of buying signals observed. Unsourced or AI-inferred signals reduce the effective score.'],
        ['Market Timing', '<span class="num">25%</span>', 'Alignment with macro tailwinds, budget cycles, urgency triggers, and timing evidence. Weak timing evidence caps upside confidence.'],
        ['ICP Fit', '<span class="num">20%</span>', 'Firmographic, technographic, persona, and pain-to-solution fit against the defined ICP. Placeholder ICP data lowers the score.'],
        ['Data Completeness', '<span class="num">15%</span>', 'Coverage and quality of source data across market, TAM, ICP, account, keyword, and messaging sections.']
      ]
    }, 'Deterministic model: overall confidence is calculated from fixed weights — signal veracity 40%, market timing 25%, ICP fit 20%, and data completeness 15%. Confidence is capped by source quality and measured data richness; AI-generated assertions cannot exceed the evidence available.', 'ABE GTMS Engine v1.0')}
</div>
${s7._data_quality ? `<div class="appendix-section">${h3('appendix', '6', 'Data Quality Audit')}${renderDarkTable({
      headers: ['Metric', 'Value'],
      rows: [
        ['Data Richness Score', '<span class="num">' + (s7._data_quality.richness_score || '—') + '</span>'],
        ['Signals (Pre-filter)', '<span class="num">' + (s7._data_quality.signals_before_filter || '—') + '</span>'],
        ['Signals (Post-filter)', '<span class="num">' + (s7._data_quality.signals_after_filter || '—') + '</span>'],
        ['AI Confidence (Claimed)', '<span class="num">' + (s7._data_quality.confidence_ai_claimed || '—') + '</span>'],
        ['Confidence (After Cap)', '<span class="num">' + (s7._data_quality.confidence_after_cap || '—') + '</span>']
      ]
    }, '', 'ABE GTMS Engine v1.0')}</div>` : ''}
<div class="appendix-section">
${h3('appendix', '7', 'AI-Estimated Fields Disclaimer')}
<div class="ac amber keep-together"><strong>AI-Estimated Content:</strong> The following fields in this report are generated by AI and should be independently validated before use in strategic decisions:<br>
TAM / SAM / SOM sizing and growth rates · Market segment estimates and priorities · ICP persona derivations (when original data was placeholder) · Account target analogs and fit scores · Buying trigger identification and signal strength · Confidence score components.<br>
All competitive intelligence reflects publicly available data only. Manual validation of exact revenue figures, headcount, and funding data is recommended prior to boardroom presentation.</div>
${h3('appendix', '8', 'Report Metadata')}
${renderReportMetadata()}
<div style="text-align:center;margin-top:4mm;padding-top:3mm;border-top:1px solid var(--border)">
  <div class="am" style="margin:0 auto 3mm;width:28px;height:28px;font-size:9px">ABE</div>
  <p style="font-size:9px;color:var(--faint)">End of Report &middot; ${e(co)} &middot; ${date} &middot; Confidential</p>
  <p style="font-size:8.5px;color:var(--muted);margin-top:1.5mm;letter-spacing:.04em">Plan with clarity. Build with intent. Grow through trust.</p>
</div>
</div>
</div>
`;

  if (isViewer) return sanitizeVisibleHtml(styles + bodyContent);
  const fullDocumentHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${styles}</head><body>${bodyContent}</body></html>`;
  return sanitizeVisibleHtml(fullDocumentHtml);
}
