/**
 * publication-validator.js  —  Publication Readiness Gate
 * ABE GTM Platform  ·  Cloudflare Workers compatible
 *
 * Layer 1 (Gates 1–10): structural presence — field exists and is non-null
 * Layer 2 (Gates 11–17): semantic depth — content is meaningful, coherent, non-hallucinated
 *
 * Contract:
 *   validatePublicationReadiness(strategy) → PublicationState
 *
 * PublicationState:
 *   {
 *     publicationReady: boolean,
 *     missingFields:    string[],   // render-critical undefined/null fields (Layer 1)
 *     invalidCharts:    string[],   // chart sections with non-numeric data (Layer 1)
 *     failedProviders:  string[],   // steps with only placeholder/fallback data (Layer 1)
 *     incompleteSteps:  number[],   // step numbers that did not complete (Layer 1)
 *     warnings:         string[],   // non-blocking quality warnings (both layers)
 *     semanticIssues:   string[],   // blocking semantic failures (Layer 2)
 *     hallucinations:   string[],   // detected AI hallucinations (Layer 2)
 *     incoherence:      string[],   // cross-step logic conflicts (Layer 2)
 *     score:            number,     // 0–100 combined structural + semantic score
 *     semanticScore:    number,     // 0–100 semantic quality score alone
 *   }
 *
 * Rules:
 *   - publicationReady = true  →  ALL Layer 1 + Layer 2 blocking gates pass
 *   - publicationReady = false →  export disabled; retry eligible for failed sections
 */

import { runSemanticValidation } from './semantic-validator.js';

// ── Render-critical fields per step ──────────────────────────────
// ANY undefined/null value in these fields blocks publication.
// Empty string ('') and empty array ([]) are acceptable.
const CRITICAL_FIELDS = {
  1: ['demand_signals', 'icp_fit', 'gtm_relevance_score'],
  2: ['tam_size_estimate', 'growth_rate'],
  3: ['verdict', 'verdict_reasoning'],
  4: ['target_roles', 'core_problem'],
  5: ['key_risks', 'confidence_score'],
  6: ['verdict', 'executive_brief'],
  7: ['signal_summary', 'go_no_go', 'executive_brief'],
};

// ── Numeric fields that must be parseable numbers ─────────────────
// Chart rendering depends on these; string placeholders block charts.
const NUMERIC_FIELDS = {
  1: ['gtm_relevance_score'],
  2: [],   // tam_size_estimate is string format ($xB) — validated via content check
  5: ['confidence_score'],
  7: ['confidence_score'],
};

// ── Placeholder detector patterns ─────────────────────────────────
// Steps containing ONLY placeholder data are treated as incomplete.
const PLACEHOLDER_PATTERNS = [
  /^AI-inferred — validate$/i,
  /^Demo placeholder — requires validation$/i,
  /^Source data missing$/i,
  /^missing data$/i,
  /^\[placeholder\]/i,
];

function isPlaceholder(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    return PLACEHOLDER_PATTERNS.some(p => p.test(value.trim()));
  }
  return false;
}

function isPlaceholderOnly(stepData, step) {
  if (!stepData || typeof stepData !== 'object') return true;
  const criticals = CRITICAL_FIELDS[step] || [];
  // A step is placeholder-only if ALL critical fields are placeholders
  return criticals.every(field => isPlaceholder(stepData[field]));
}

function isNumeric(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return !isNaN(value) && isFinite(value);
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return !isNaN(n) && isFinite(n);
  }
  return false;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, obj);
}

// ── SWOT validator ────────────────────────────────────────────────
function validateSWOT(s1) {
  if (!s1) return false;
  const swot = s1.swot || s1.swot_analysis;
  if (!swot) return false;
  if (Array.isArray(swot)) return swot.length > 0;
  if (typeof swot === 'object') {
    return !!(swot.strengths || swot.weaknesses || swot.opportunities || swot.threats);
  }
  return false;
}

// ── TAM/SAM/SOM validator ─────────────────────────────────────────
function validateTAM(s2) {
  if (!s2) return { valid: false, reason: 'Step 2 missing' };
  const tam = s2.tam_size_estimate;
  if (!tam) return { valid: false, reason: 'tam_size_estimate is null/undefined' };
  if (isPlaceholder(tam)) return { valid: false, reason: 'tam_size_estimate is placeholder' };
  // TAM is a string format ($xB, $xM, etc.) — must contain a digit
  if (typeof tam === 'string' && !/\d/.test(tam)) {
    return { valid: false, reason: `tam_size_estimate "${tam}" contains no numeric value` };
  }
  return { valid: true };
}

// ── GTM score validator ───────────────────────────────────────────
function validateGTMScore(s1) {
  if (!s1) return { valid: false, reason: 'Step 1 missing' };
  const score = s1.gtm_relevance_score;
  if (score === null || score === undefined) return { valid: false, reason: 'gtm_relevance_score is null/undefined' };
  const n = parseInt(score, 10);
  if (isNaN(n) || n < 0 || n > 100) {
    return { valid: false, reason: `gtm_relevance_score "${score}" is out of range (0–100)` };
  }
  return { valid: true, score: n };
}

// ── Confidence score validator ────────────────────────────────────
function validateConfidenceScore(s5, s7, bi) {
  // Confidence can come from multiple sources
  const raw = bi?.confScore ?? s7?.confidence_score ?? s5?.confidence_score;
  if (raw === null || raw === undefined) return { valid: false, reason: 'confidence_score not found in any step' };
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0 || n > 100) {
    return { valid: false, reason: `confidence_score "${raw}" is out of range (0–100)` };
  }
  return { valid: true, score: n };
}

// ── Main publication validation ───────────────────────────────────

/**
 * validatePublicationReadiness(strategy)
 *
 * @param {object} strategy - Full strategy object from DB or in-memory state
 * @returns {PublicationState}
 */
export function validatePublicationReadiness(strategy) {
  const missingFields   = [];
  const invalidCharts   = [];
  const failedProviders = [];
  const incompleteSteps = [];
  const warnings        = [];

  if (!strategy || typeof strategy !== 'object') {
    return {
      publicationReady: false,
      missingFields:    ['strategy object is null/undefined'],
      invalidCharts:    [],
      failedProviders:  [],
      incompleteSteps:  [1, 2, 3, 4, 5, 6, 7],
      warnings:         [],
      score:            0,
    };
  }

  // ── Extract step data ─────────────────────────────────────────
  const s1  = strategy.step_1_market         || null;
  const s2  = strategy.step_2_tam            || null;
  const s3  = strategy.step_3_icp            || null;
  const s4  = strategy.step_4_sourcing       || null;
  const s5  = strategy.step_5_keywords       || null;
  const s6  = strategy.step_6_messaging      || null;
  const s7  = strategy.step_7_intelligence   || null;
  const bi  = strategy.backend_intelligence  || null;

  const stepData = { 1: s1, 2: s2, 3: s3, 4: s4, 5: s5, 6: s6, 7: s7 };

  // ── GATE 1: All 7 steps must be present ──────────────────────
  for (let i = 1; i <= 7; i++) {
    const data = stepData[i];
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      incompleteSteps.push(i);
      missingFields.push(`step_${i}: no data`);
      continue;
    }

    // ── GATE 2: Critical fields must not be null/undefined ──────
    const criticals = CRITICAL_FIELDS[i] || [];
    for (const field of criticals) {
      const value = getNestedValue(data, field);
      if (value === undefined || value === null) {
        missingFields.push(`step_${i}.${field} is ${value === null ? 'null' : 'undefined'}`);
        if (!incompleteSteps.includes(i)) incompleteSteps.push(i);
      }
    }

    // ── GATE 3: Placeholder-only steps are not complete ─────────
    if (isPlaceholderOnly(data, i)) {
      failedProviders.push(`step_${i}: all critical fields are placeholders`);
      if (!incompleteSteps.includes(i)) incompleteSteps.push(i);
    }
  }

  // ── GATE 4: SWOT must exist ───────────────────────────────────
  if (s1 && !validateSWOT(s1)) {
    missingFields.push('step_1.swot: SWOT data missing or empty');
    warnings.push('SWOT section is missing — Step 1 market research may be incomplete');
  }

  // ── GATE 5: TAM must be numeric/valid ─────────────────────────
  const tamCheck = validateTAM(s2);
  if (!tamCheck.valid) {
    invalidCharts.push(`TAM chart: ${tamCheck.reason}`);
    warnings.push(`TAM/SAM/SOM chart will not render: ${tamCheck.reason}`);
  }

  // ── GATE 6: GTM score must be valid numeric ───────────────────
  const gtmCheck = validateGTMScore(s1);
  if (!gtmCheck.valid) {
    invalidCharts.push(`GTM Score: ${gtmCheck.reason}`);
    missingFields.push(`step_1.gtm_relevance_score: ${gtmCheck.reason}`);
  }

  // ── GATE 7: Confidence score must be valid numeric ────────────
  const confCheck = validateConfidenceScore(s5, s7, bi);
  if (!confCheck.valid) {
    invalidCharts.push(`Confidence Matrix: ${confCheck.reason}`);
    warnings.push(`Confidence matrix will not render: ${confCheck.reason}`);
  }

  // ── GATE 8: Steps completed count must be consistent ─────────
  const dbStepsCompleted = strategy.steps_completed || 0;
  const actualStepsWithData = Object.values(stepData).filter(d => d && Object.keys(d).length > 0).length;
  if (dbStepsCompleted !== actualStepsWithData) {
    warnings.push(
      `steps_completed mismatch: DB reports ${dbStepsCompleted} but ${actualStepsWithData} steps have data`
    );
  }

  // ── GATE 9: No undefined render-critical fields ───────────────
  // Check for undefined (not null, not empty — just undefined) in top-level render fields
  const renderCriticals = [
    { path: 'company_name', source: strategy },
    { path: 'industry',     source: strategy },
  ];
  for (const { path, source } of renderCriticals) {
    if (source[path] === undefined) {
      missingFields.push(`${path} is undefined`);
    }
  }

  // ── GATE 10: Numeric fields that power charts ─────────────────
  for (const [stepNum, fields] of Object.entries(NUMERIC_FIELDS)) {
    const data = stepData[parseInt(stepNum)];
    if (!data) continue;
    for (const field of fields) {
      const val = getNestedValue(data, field);
      if (val !== undefined && val !== null && !isNumeric(val)) {
        invalidCharts.push(`step_${stepNum}.${field}: "${val}" is not numeric`);
      }
    }
  }

  // ── Quality warnings (non-blocking) ──────────────────────────
  if (s1 && (!s1.growth_signals || (Array.isArray(s1.growth_signals) && s1.growth_signals.length === 0))) {
    warnings.push('Step 1: growth_signals is empty — market signals section will render blank');
  }
  if (s3 && (!s3.decision_makers || (Array.isArray(s3.decision_makers) && s3.decision_makers.length === 0))) {
    warnings.push('Step 3: decision_makers is empty — ICP persona table will be sparse');
  }
  if (s6 && !s6.email_1?.subject) {
    warnings.push('Step 6: email_1.subject missing — first outreach email header will be empty');
  }
  if (s7 && !s7.go_no_go?.recommendation) {
    warnings.push('Step 7: go_no_go.recommendation missing — verdict banner cannot render');
  }

  // ── LAYER 2: Semantic depth validation ───────────────────────
  // Only runs when Layer 1 structural gates pass for all steps
  // (no point running semantic checks on absent data)
  let semanticResult = {
    semanticReady:  true,
    blockingIssues: [],
    qualityIssues:  [],
    hallucinations: [],
    incoherence:    [],
    semanticScore:  100,
  };

  if (incompleteSteps.length === 0 && missingFields.length === 0) {
    // All 7 steps structurally present — run full semantic validation
    semanticResult = runSemanticValidation(strategy);

    // Semantic blocking issues → join missingFields (block publication)
    for (const issue of semanticResult.blockingIssues) {
      missingFields.push(`[semantic] ${issue}`);
    }

    // Hallucinations → join missingFields (blocking)
    for (const h of semanticResult.hallucinations) {
      missingFields.push(`[hallucination] ${h}`);
    }

    // Cross-step incoherence → join missingFields (blocking)
    for (const ic of semanticResult.incoherence) {
      missingFields.push(`[incoherence] ${ic}`);
    }

    // Quality issues → warnings only (non-blocking)
    warnings.push(...semanticResult.qualityIssues);
  } else {
    // Skip semantic validation — structural issues take priority
    semanticResult.semanticScore = 0;
    semanticResult.semanticReady = false;
  }

  // ── Combined publication score (0–100) ────────────────────────
  // Weighted: Layer 1 structural (60%) + Layer 2 semantic (40%)
  let structuralScore = 100;
  structuralScore -= incompleteSteps.length * 12;
  structuralScore -= missingFields.filter(f => !f.startsWith('[semantic]') && !f.startsWith('[hallucination]') && !f.startsWith('[incoherence]')).length * 3;
  structuralScore -= invalidCharts.length  * 4;
  structuralScore -= failedProviders.length * 5;
  structuralScore  = Math.max(0, Math.min(100, structuralScore));

  const score = Math.round(structuralScore * 0.6 + semanticResult.semanticScore * 0.4);

  // ── Final gate ────────────────────────────────────────────────
  const publicationReady = (
    incompleteSteps.length === 0 &&
    missingFields.length    === 0 &&   // includes semantic blocking issues
    invalidCharts.length    === 0 &&
    failedProviders.length  === 0 &&
    semanticResult.semanticReady
  );

  return {
    publicationReady,
    missingFields,
    invalidCharts,
    failedProviders,
    incompleteSteps,
    warnings,
    semanticIssues:  semanticResult.blockingIssues,
    hallucinations:  semanticResult.hallucinations,
    incoherence:     semanticResult.incoherence,
    score,
    semanticScore:   semanticResult.semanticScore,
  };
}

/**
 * buildPublicationReport(validationState)
 * Produces a human-readable publication state summary.
 */
export function buildPublicationReport(state) {
  if (state.publicationReady) {
    return `✅ Publication Ready (score: ${state.score}/100, semantic: ${state.semanticScore}/100) — all 7 steps complete, all critical fields validated, semantic quality confirmed.`;
  }

  const lines = [`❌ NOT Publication Ready (score: ${state.score}/100, semantic: ${state.semanticScore ?? '?'}/100)`];

  if (state.incompleteSteps.length > 0) {
    lines.push(`  Incomplete steps: ${state.incompleteSteps.map(s => `Step ${s}`).join(', ')}`);
  }
  if (state.missingFields.length > 0) {
    lines.push(`  Missing/blocking fields (${state.missingFields.length}):`);
    state.missingFields.forEach(f => lines.push(`    • ${f}`));
  }
  if (state.hallucinations?.length > 0) {
    lines.push(`  Detected hallucinations (${state.hallucinations.length}):`);
    state.hallucinations.forEach(h => lines.push(`    🚨 ${h}`));
  }
  if (state.incoherence?.length > 0) {
    lines.push(`  Cross-step incoherence (${state.incoherence.length}):`);
    state.incoherence.forEach(i => lines.push(`    ⚡ ${i}`));
  }
  if (state.invalidCharts.length > 0) {
    lines.push(`  Invalid chart data (${state.invalidCharts.length}):`);
    state.invalidCharts.forEach(c => lines.push(`    • ${c}`));
  }
  if (state.failedProviders.length > 0) {
    lines.push(`  Failed providers (${state.failedProviders.length}):`);
    state.failedProviders.forEach(p => lines.push(`    • ${p}`));
  }
  if (state.warnings.length > 0) {
    lines.push(`  Warnings (${state.warnings.length}):`);
    state.warnings.forEach(w => lines.push(`    ⚠ ${w}`));
  }

  return lines.join('\n');
}
