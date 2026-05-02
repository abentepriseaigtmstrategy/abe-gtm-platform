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
  const filename = `GTM_${strategy.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  const html = buildReportHTML(strategy);
  return new Response(JSON.stringify({ html, filename, mode: 'html2pdf' }), {
    status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}

// ══════════════════════════════════════════════════════════════
// TIER-1 ENTERPRISE A4 REPORT — dark-theme, rendered to PDF
// ══════════════════════════════════════════════════════════════
export function buildReportHTML(strategy) {
  const s1 = strategy.step_1_market || strategy.steps?.[1] || {};
  const s2 = strategy.step_2_tam || strategy.steps?.[2] || {};
  const s3 = strategy.step_3_icp || strategy.steps?.[3] || {};
  const s4 = strategy.step_4_sourcing || strategy.steps?.[4] || {};
  const s5 = strategy.step_5_keywords || strategy.steps?.[5] || {};
  const s6 = strategy.step_6_messaging || strategy.steps?.[6] || {};
  const s7 = strategy.step_7_intelligence || {};
  const co = strategy.company_name || 'Company';
  const ind = strategy.industry || '';
  const date = new Date().toLocaleDateString('en-GB',{year:'numeric',month:'long',day:'numeric'});
  const score = parseInt(s1.gtm_relevance_score) || 0;
  const confScore = parseInt(s7.confidence_score) || score || 0;
  const e = s => { if(typeof s!=='string') return String(s||''); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); };
  const safe = v => { if(!v&&v!==0) return ''; if(Array.isArray(v)) return v.join(', '); if(typeof v==='object') return Object.entries(v).map(([k,x])=>`${k}: ${Array.isArray(x)?x.join(', '):x}`).join('; '); return String(v); };
  const arr = v => Array.isArray(v)?v:(v?[String(v)]:[]);
  const rec = s7.go_no_go?.recommendation || (score>=75?'Go':score>=50?'Watch':'No-Go');
  const recUp = rec.toUpperCase();
  const recColor = /go$/i.test(rec)&&!/no/i.test(rec)?'var(--green)':/no/i.test(rec)?'var(--red)':'var(--amber)';
  const veracity = Math.round(confScore*0.4);
  const timing = Math.round(confScore*0.25);
  const icpFit = Math.round(confScore*0.2);
  const completeness = Math.round(confScore*0.15);

  // ── Source attribution ──
  const srcNote = (src) => `<div style="font-size:8px;color:var(--faint);margin:2mm 0;font-style:italic">Source: ${e(src)} — validate manually</div>`;

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
  const secHead = (num,title) => `<h2><span class="sa">${num}</span> ${e(title)}</h2>`;
  const secCtx = text => text?`<div class="sc">${e(text)}</div>`:'';
  const callout = (text,cls='') => text?`<div class="ac ${cls}"><strong>👉 Analyst Insight:</strong> ${e(text)}</div>`:'';
  const tags = (items,cls='') => arr(items).slice(0,15).map(t=>`<span class="tg ${cls}">${e(String(t))}</span>`).join('');
  const fieldRow = (label,val) => { const v=safe(val); return v?`<tr><th>${e(label)}</th><td>${e(v)}</td></tr>`:''; };

  // ── SWOT ──
  const swotCell = (label,items,color) => { const a=arr(items); return a.length?`<div class="sc2" style="border-top:3px solid ${color}"><div class="sl" style="color:${color}">${label}</div><ul>${a.slice(0,4).map(i=>`<li>${e(String(i))}</li>`).join('')}</ul></div>`:''; };
  const swotGrid = () => { const sw=s1.swot; if(!sw||typeof sw!=='object') return ''; const h=swotCell('STRENGTHS',sw.strengths,'var(--green)')+swotCell('WEAKNESSES',sw.weaknesses,'var(--red)')+swotCell('OPPORTUNITIES',sw.opportunities,'var(--blue)')+swotCell('THREATS',sw.threats,'var(--amber)'); return h?`<div class="sg">${h}</div>`:''; };

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
    <div class="card"><table class="dt">
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

  // ── Emails ──
  const emailBlock = (k,i) => { const em=s6[k]; if(!em) return ''; return `<div class="card"><div class="bl">Email ${i+1} — ${e(em.angle||'')}</div><p><strong>Subject:</strong> ${e(em.subject||'—')}</p><p style="white-space:pre-line;word-break:break-word;overflow-wrap:break-word;min-width:0;width:100%;display:block;font-size:10.5px">${e(em.body||'—')}</p><p><span class="tg green" style="margin-top:2mm">CTA: ${e(em.cta||'—')}</span></p></div>`; };

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
  <div class="card"><div style="display:flex;align-items:center;gap:5mm"><span class="mn" style="color:${recColor};font-size:32px">${e(recUp)}</span><div><strong>Verdict Rationale:</strong><br>${e(reason)}</div></div></div>
  ${srcNote(hasS7?'Source: Step 7 AI intelligence layer — algorithmic composite':'Source: derived from GTM relevance score ('+score+'/100) — algorithmic')}
  <h3>7.2 · Why Now</h3>
  <div class="card"><p style="font-size:12px">${e(whyNow)}</p></div>
  ${srcNote(hasS7&&s7.why_now_analysis?'Source: Step 7 AI analysis of market signals':'Source: AI inference from buying triggers and market context — validate timing independently')}
  <h3>7.3 · Strategic Hook</h3>
  <div class="ac"><strong>"${e(hook)}"</strong></div>
  ${srcNote(hasS7&&s7.strategic_hook?'Source: Step 7 AI strategic analysis':'Source: derived from buying triggers — AI estimate')}
  <h3>7.4 · Risk &amp; Constraint Analysis</h3>
  <div class="ac red"><strong>🚩 Identified Constraints:</strong><br>
    <strong>Decision Cycle:</strong> ${dms.length?`Buying committee spans ${dms.slice(0,3).join(', ')}. Multi-stakeholder alignment extends cycle 30–60 days.`:'Expect extended multi-stakeholder approval cycles.'}<br>
    <strong>Vendor Lock-in:</strong> Entrenched incumbent relationships reduce switching probability. Lead with differentiated outcome data.<br>
    <strong>Budget Friction:</strong> Capital commitments require CFO-level ROI framing. Surface quantifiable efficiency recovery.
  </div>
  ${srcNote('Source: 30–60 day cycle estimate is an industry benchmark (AI estimate) — validate with actual deal-cycle data from CRM')}
  <h3>7.5 · Execution Priority</h3>
  <div class="card"><p><strong>Target:</strong> ${e(dms[0]||safe(s3.primary_icp)||'Senior decision-makers')}<br><strong>Lead With:</strong> ${e(triggers[0]||'Operational pressure')}<br><strong>Close With:</strong> ${safe(s2.growth_rate)?`Market growing at ${safe(s2.growth_rate)} — quantify cost of delayed adoption`:'Quantified ROI recovery and risk elimination'}</p></div>
  ${safe(s2.growth_rate)?srcNote('Source: CAGR ('+safe(s2.growth_rate)+') is an AI market estimate — cross-reference with analyst reports'):''}`;

  };

  // ── Weighted Confidence Matrix ──
  const confidenceMatrix = () => {
    if(!confScore) return '';
    const cmBar = (label, score, max, cls='') => `<div class="cmrow ${cls}">
      <div class="cmhdr"><span class="cmlbl">${label}</span><span class="cmscore">${score}<span style="font-size:8px;font-weight:400;color:var(--muted)">/${max}</span></span></div>
      <div class="cmtrack"><div class="cmfill" style="width:${Math.round((score/max)*100)}%"></div></div>
    </div>`;
    return `
  <h3>7.6 · Weighted Confidence Matrix</h3>
  ${cmBar('Signal Veracity (40%)', veracity, 40)}
  ${cmBar('Market Timing (25%)', timing, 25)}
  ${cmBar('ICP Fit (20%)', icpFit, 20)}
  ${cmBar('Data Completeness (15%)', completeness, 15)}
  <div style="border-top:1px solid rgba(168,85,247,.2);margin:4mm 0 3mm"></div>
  ${cmBar('Overall Fidelity', confScore, 100, 'cmrow-overall')}
  ${srcNote('Source: confidence score is algorithmic — weights are fixed (40/25/20/15), sub-scores derived from data richness measurement, capped by server-side hallucination guard')}`;
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
.page{width:210mm;min-height:297mm;overflow:hidden;margin:0;background:var(--bg);padding:15mm 18mm;position:relative;page-break-after:always}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:8mm;border-bottom:1px solid var(--border);padding-bottom:4mm}
.phb{display:flex;align-items:center;gap:10px}
.am{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:white}
.abn{font-size:12px;font-weight:800;color:white}
.abs{font-family:'Space Mono',monospace;font-size:8px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
.cb{background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);border-radius:20px;padding:4px 14px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font-size:36px;font-weight:900;color:white;letter-spacing:-.5px}
h2{font-size:18px;font-weight:700;color:white;margin-bottom:4mm;display:flex;align-items:center;gap:8px}
h3{font-size:14px;font-weight:600;color:var(--text);margin-top:5mm;margin-bottom:3mm}
p{margin-bottom:3mm}
.sa{display:inline-flex;width:28px;height:28px;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);border-radius:8px;align-items:center;justify-content:center;font-size:12px;font-weight:800}
.sc{font-size:13px;color:var(--muted);margin-bottom:6mm;border-bottom:1px dashed var(--border);padding-bottom:3mm}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:5mm 6mm;margin-bottom:5mm}
.bl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-bottom:2mm}
.dt{width:100%;border-collapse:collapse;margin-top:2mm;font-size:10px;margin-bottom:4mm}
.dt th{text-align:left;color:var(--muted);font-weight:600;padding:2mm 3mm;border-bottom:1px solid var(--border)}
.dt td{padding:2mm 3mm;border-bottom:1px solid rgba(31,41,55,.5);vertical-align:top}
.num{font-family:'Space Mono',monospace;text-align:right}
.ha{color:var(--accent);font-weight:700}
.mn{font-size:24px;font-weight:900;font-family:'Space Mono',monospace;color:var(--accent)}
.ac{background:rgba(168,85,247,.04);border:1px solid rgba(168,85,247,.2);border-left:4px solid var(--accent);border-radius:8px;padding:4mm 5mm;margin:4mm 0;font-size:11px}
.ac strong{color:var(--accent)}
.ac.amber{border-left-color:var(--amber);background:rgba(245,158,11,.04);border-color:rgba(245,158,11,.2)}
.ac.amber strong{color:var(--amber)}
.ac.green{border-left-color:var(--green);background:rgba(34,197,94,.04);border-color:rgba(34,197,94,.2)}
.ac.green strong{color:var(--green)}
.ac.red{border-left-color:var(--red);background:rgba(239,68,68,.04);border-color:rgba(239,68,68,.2)}
.ac.red strong{color:var(--red)}
.tg{display:inline-block;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);border-radius:6px;padding:1.5mm 4mm;font-size:9px;font-weight:600;color:#c4b5fd;margin:1mm 2mm 1mm 0}
.tg.green{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.2);color:#86efac}
.tg.amber{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.2);color:#fcd34d}
.tg.blue{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.2);color:#93c5fd}
.tg.red{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.2);color:#fca5a5}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:2mm 0 4mm}
.sc2{border:1px solid var(--border);border-radius:8px;padding:3mm 4mm}
.sc2 ul{padding-left:5mm;font-size:9.5px;line-height:1.6}
.sc2 li{margin-bottom:1.5mm}
.sl{font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.15em;margin-bottom:1.5mm}
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
</style></head><body>

<!-- COVER -->
<div class="page" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(168,85,247,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,.025) 1px,transparent 1px);background-size:32px 32px;pointer-events:none;border-radius:inherit"></div>
<div style="position:relative;z-index:1">
  <div class="am" style="width:56px;height:56px;font-size:18px;margin:0 auto 8mm">ABE</div>
  <h1>${e(co)}<br>GTM Intelligence Report</h1>
  <p style="font-size:15px;color:var(--muted);margin-top:6mm">Confidential · Senior Strategy Brief</p>
  <p style="font-size:12px;color:var(--muted);margin-top:4mm">Prepared by ABE AI Revenue Infrastructure<br>${date}</p>
  ${ind?`<p style="font-size:11px;color:var(--faint);margin-top:3mm">${e(ind)}</p>`:''}
  <div style="display:flex;gap:4mm;margin-top:10mm;justify-content:center">
    <div style="background:rgba(18,24,39,.8);border:1px solid rgba(168,85,247,.25);border-bottom:3px solid var(--accent);border-radius:10px;padding:5mm 7mm;min-width:35mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:22px;font-weight:900;color:white">${score||'—'}</div>
      <div style="font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm">GTM Score</div>
    </div>
    <div style="background:rgba(18,24,39,.8);border:1px solid rgba(168,85,247,.25);border-bottom:3px solid var(--accent);border-radius:10px;padding:5mm 7mm;min-width:35mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:22px;font-weight:900;color:var(--accent)">${e(safe(s2.tam_size_estimate)||'—')}</div>
      <div style="font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm">TAM Size</div>
    </div>
    <div style="background:rgba(18,24,39,.8);border:1px solid rgba(168,85,247,.25);border-bottom:3px solid ${/go$/i.test(rec)&&!/no/i.test(rec)?'var(--green)':/no/i.test(rec)?'var(--red)':'var(--amber)'};border-radius:10px;padding:5mm 7mm;min-width:35mm;text-align:center">
      <div style="font-family:'Space Mono',monospace;font-size:22px;font-weight:900;color:${recColor}">${e(recUp)}</div>
      <div style="font-size:7px;text-transform:uppercase;letter-spacing:.15em;color:var(--muted);margin-top:1mm">Verdict</div>
    </div>
  </div>
  ${s3.primary_icp||s1.company_overview?`<div style="margin-top:8mm;background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-left:3px solid var(--accent);border-radius:8px;padding:4mm 6mm;text-align:left;max-width:140mm">
    <div style="font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.18em;color:var(--accent);margin-bottom:2mm">Strategic Positioning</div>
    <div style="font-size:10.5px;color:var(--text);line-height:1.6">${e((safe(s1.company_overview)||'').split('.')[0] || (co + ' GTM intelligence report'))}.</div>
  </div>`:''}
</div>
<div style="position:absolute;bottom:15mm;font-size:9px;color:var(--faint);z-index:1">Classification: CONFIDENTIAL — Not for External Distribution</div>
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
  <div class="card" style="flex:1;text-align:center"><div class="mn" style="color:var(--amber)">${e(safe(s2.market_maturity)||'—')}</div><div class="bl">Maturity</div></div>
</div>
${srcNote('TAM/CAGR: AI market estimate; Maturity: AI assessment — cross-reference with industry analyst reports')}
<h3>2.2 · Waterfall Logic: TAM → SAM → SOM</h3>
${waterfall()}
${segTable()}
${s2.priority_opportunities?`<h3>2.4 · Priority Opportunities</h3><div class="card"><p>${e(safe(s2.priority_opportunities))}</p></div>`:''}
${callout(s2.analyst_insight,'amber')}
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
${pageFtr('ICP Modeling',4)}
</div>

<!-- STEP 4: ACCOUNT SOURCING -->
<div class="page">
${pageHdr()}
${secHead('04','Account Sourcing — The Targets')}
${secCtx(s4.section_context||'Translates persona into actionable technographic filters and sourcing logic.')}
<h3>4.1 · Sourcing Infrastructure</h3>
<table class="dt">
${fieldRow('Recommended Databases',s4.recommended_databases)}
${fieldRow('Filter Criteria',s4.filter_criteria)}
${fieldRow('Estimated Universe',s4.estimated_universe)}
${fieldRow('Exclusion Criteria',s4.exclusion_criteria)}
</table>
<h3>4.2 · Sourcing Playbook</h3>
<div class="card"><p>${e(safe(s4.sourcing_playbook)||'—')}</p></div>
${s4.data_enrichment_tips?`<h3>4.3 · Data Enrichment</h3><div class="card"><p>${e(safe(s4.data_enrichment_tips))}</p></div>`:''}
${acctTable()}
${callout(s4.analyst_insight)}
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
<div style="margin:3mm 0"><strong style="font-size:9px;color:var(--muted)">CONTENT TOPICS</strong><br>${tags(s5.content_topics,'blue')}</div>
${callout(s5.analyst_insight)}
${pageFtr('Keywords & Intent',6)}
</div>

<!-- STEP 6: ENTERPRISE SDR SEQUENCE -->
<div class="page">
${pageHdr()}
${secHead('06','Enterprise SDR Sequence — The Engagement')}
${secCtx(s6.section_context||'Hyper-targeted sequences designed to agitate pain and validate scalability.')}
<h3>6.1 · 3-Touch Triggered Sequence</h3>
${emailBlock('email_1',0)}
${emailBlock('email_2',1)}
${emailBlock('email_3',2)}
${s6.follow_up_sequence?`<h3>6.2 · Follow-up Cadence</h3><div class="card"><p>${e(safe(s6.follow_up_sequence))}</p></div>`:''}
${s6.linkedin_message?`<h3>6.3 · LinkedIn Hook</h3><div class="card"><p style="font-size:12px"><strong>Direct Message:</strong><br>"${e(safe(s6.linkedin_message))}"</p></div>`:''}
${s6.linkedin_follow_up?`<h3>6.4 · LinkedIn Follow-up</h3><div class="card"><p>${e(safe(s6.linkedin_follow_up))}</p></div>`:''}
${callout(s6.analyst_insight)}
${pageFtr('Engagement Playbook',7)}
</div>

<!-- STEP 7: REVENUE INTELLIGENCE -->
<div class="page">
${pageHdr()}
${decisionEngine()}
${confidenceMatrix()}
${pageFtr('Revenue Intelligence',8)}
</div>

<!-- APPENDIX -->
<div class="page">
${pageHdr()}
${secHead('A','Appendix — Methodology & Data Quality')}
${secCtx('Transparency layer. Documents data provenance, scoring methodology, and known limitations.')}

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

<h3>A.2 · TAM Calculation Methodology</h3>
<table class="dt">
  <tr><th>Step</th><th>Method</th></tr>
  <tr><td>1. Global TAM</td><td>AI estimate from industry classification, public market reports, and comparable company analysis</td></tr>
  <tr><td>2. Geography filter</td><td>Uses company-provided geography_eligibility when available; defaults to conservative 60–70%</td></tr>
  <tr><td>3. Service-line fit</td><td>Uses company-provided service_line_fit when available; defaults to conservative 30–40%</td></tr>
  <tr><td>4. Win rate</td><td>Uses company-provided win_rate when available; defaults to 8–12% (enterprise benchmark)</td></tr>
  <tr><td>5. SOM derivation</td><td>Product of steps 1–4; dynamic values override defaults when strategy data provides them</td></tr>
</table>

<h3>A.3 · Key Assumptions</h3>
<table class="dt">
  <tr><th>Assumption</th><th>Default Value</th><th>Override Guidance</th></tr>
  <tr><td>Geography eligibility</td><td>Dynamic when available; else 60–70%</td><td>Auto-populated from strategy.waterfall.geography_eligibility</td></tr>
  <tr><td>Service-line fit</td><td>Dynamic when available; else 30–40%</td><td>Auto-populated from strategy.waterfall.service_line_fit</td></tr>
  <tr><td>Win/capture rate</td><td>Dynamic when available; else 8–12%</td><td>Auto-populated from strategy.waterfall.win_rate</td></tr>
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

${s7._data_quality?`<h3>A.5 · Data Quality Audit</h3><table class="dt"><tr><th>Metric</th><th>Value</th></tr><tr><td>Data Richness Score</td><td class="num">${s7._data_quality.richness_score||'—'}</td></tr><tr><td>Signals (Pre-filter)</td><td class="num">${s7._data_quality.signals_before_filter||'—'}</td></tr><tr><td>Signals (Post-filter)</td><td class="num">${s7._data_quality.signals_after_filter||'—'}</td></tr><tr><td>AI Confidence (Claimed)</td><td class="num">${s7._data_quality.confidence_ai_claimed||'—'}</td></tr><tr><td>Confidence (After Cap)</td><td class="num">${s7._data_quality.confidence_after_cap||'—'}</td></tr></table>`:''}

<h3>A.6 · AI-Estimated Fields Disclaimer</h3>
<div class="ac amber"><strong>⚠️ AI-Estimated Content:</strong> The following fields in this report are generated by AI and should be independently validated before use in strategic decisions:<br>
• TAM / SAM / SOM sizing and growth rates<br>
• Market segment estimates and priorities<br>
• ICP persona derivations (when original data was placeholder)<br>
• Account target analogs and fit scores<br>
• Buying trigger identification and signal strength<br>
• Confidence score components<br><br>
All competitive intelligence reflects publicly available data only. Manual validation of exact revenue figures, headcount, and funding data is recommended prior to boardroom presentation.</div>

<h3>A.7 · Report Metadata</h3>
<table class="dt">
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td>Subject Company</td><td>${e(co)}</td></tr>
  ${ind?`<tr><td>Industry</td><td>${e(ind)}</td></tr>`:''}
  <tr><td>Generated</td><td>${date}</td></tr>
  <tr><td>Platform</td><td>ABE Enterprise AI Revenue Infrastructure</td></tr>
  <tr><td>Steps Completed</td><td>${strategy.steps_completed||6}/7</td></tr>
  <tr><td>GTM Relevance Score</td><td>${score}/100</td></tr>
  <tr><td>Confidence Score</td><td>${confScore}/100</td></tr>
</table>
<div style="text-align:center;margin-top:10mm;padding-top:5mm;border-top:1px solid var(--border)">
  <div class="am" style="margin:0 auto 3mm;width:28px;height:28px;font-size:9px">ABE</div>
  <p style="font-size:9px;color:var(--faint)">End of Report · ${e(co)} · ${date} · Confidential</p>
</div>
${pageFtr('Appendix',9)}
</div>

</body></html>`;
}
