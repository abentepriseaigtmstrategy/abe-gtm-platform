/**
 * semantic-validator.js  —  Layer 2: Semantic Depth Validation
 * ABE GTM Platform  ·  Cloudflare Workers compatible
 *
 * Layer 1 (publication-validator.js) checks structural presence:
 *   "Is the field here and non-null?"
 *
 * Layer 2 (this module) checks semantic correctness:
 *   "Is the content actually meaningful, coherent, and non-hallucinated?"
 *
 * Gates run in this module:
 *   S1.  SWOT Substantive Content   — entries must be sentences, not one-word or identical
 *   S2.  TAM Coherence              — value range, TAM > SAM > SOM hierarchy
 *   S3.  Score Arithmetic           — sub-scores must sum to total_score (± tolerance)
 *   S4.  Confidence Calibration     — score can't contradict risk severity or data richness
 *   S5.  GTM Score Bounds           — flags implausible inflation or deflation
 *   S6.  Cross-Step ICP Coherence   — step 1/3/4 ICP descriptions must not contradict
 *   S7.  Hallucination Patterns     — TAM > $50T, all-identical arrays, absurd GTM scores
 *   S8.  Verdict Coherence          — step 3 and step 6 verdicts must not directly conflict
 *   S9.  Email Sequence Quality     — subject lines must be substantive
 *   S10. Go/No-Go Calibration       — recommendation must not contradict confidence + GTM score
 *
 * Returns:
 *   SemanticValidation {
 *     semanticReady:    boolean,     // all BLOCKING gates pass
 *     blockingIssues:   string[],    // prevent publication (added to missingFields)
 *     qualityIssues:    string[],    // degrade score but don't block (added to warnings)
 *     hallucinations:   string[],    // suspected AI hallucinations (blocking)
 *     incoherence:      string[],    // cross-step logic conflicts (blocking)
 *     semanticScore:    number,      // 0–100 semantic quality score
 *   }
 *
 * Blocking vs. Non-blocking:
 *   blockingIssues + hallucinations + incoherence → added to publication `missingFields` → BLOCKS export
 *   qualityIssues                                  → added to publication `warnings`    → does NOT block
 */

// ── Constants ─────────────────────────────────────────────────────

const MIN_SWOT_ENTRY_LENGTH   = 20;   // chars — shorter entries are likely one-liners
const MAX_SWOT_DUPLICATE_RATE = 0.5;  // >50% identical entries = hallucination loop
const MAX_PLAUSIBLE_TAM_USD   = 50_000_000_000_000; // $50T — nothing realistic exceeds this
const MIN_PLAUSIBLE_TAM_USD   = 100_000;             // $100K — sub-threshold for real market
const SCORE_SUM_TOLERANCE     = 2;    // allow ±2 pts rounding error in total_score
const MAX_GTM_SCORE_TYPICAL   = 92;   // above this = very suspicious inflation
const MIN_CONFIDENCE_HIGH_RISK = 30;  // confidence can't be >this if ALL risks are High

// Verdict direction groupings for cross-step coherence
const POSITIVE_VERDICTS = new Set([
  'STRONG GO', 'GO', 'GO (CONDITIONAL)', 'CONDITIONAL GO', 'QUALIFIED GO',
  'go', 'strong go', 'qualified go',
]);
const NEGATIVE_VERDICTS = new Set([
  'NO GO', 'NO-GO', 'PASS', 'HARD PASS', 'DEFER', 'NOT RECOMMENDED',
  'no go', 'no-go', 'pass', 'hard pass',
]);

// ── Utility helpers ────────────────────────────────────────────────

/**
 * parseTAMValue(raw) → number (USD) or null
 * Converts string formats like "$4.2B", "4.2 billion", "42M", "$420,000,000"
 * into a plain number for comparison.
 */
function parseTAMValue(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw).replace(/,/g, '').trim();

  const multipliers = { t: 1e12, b: 1e9, m: 1e6, k: 1e3 };
  const match = s.match(/\$?([\d.]+)\s*([tTbBmMkK])?/);
  if (!match) return null;

  const base = parseFloat(match[1]);
  if (isNaN(base)) return null;

  const suffix = (match[2] || '').toLowerCase();
  return base * (multipliers[suffix] || 1);
}

/**
 * isSubstantiveText(value) → boolean
 * Returns true if the string is a proper sentence (≥ MIN_SWOT_ENTRY_LENGTH
 * chars, contains at least one space, is not a known placeholder).
 */
const PLACEHOLDER_SNIPPETS = [
  'AI-inferred', 'validate', 'placeholder', 'source data missing',
  'missing data', 'requires validation', 'no data',
];

function isSubstantiveText(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SWOT_ENTRY_LENGTH) return false;
  if (!trimmed.includes(' ')) return false; // single word
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_SNIPPETS.some(p => lower.includes(p))) return false;
  return true;
}

/**
 * arrayDuplicateRate(arr) → number (0–1)
 * Returns the proportion of duplicate strings in an array.
 */
function arrayDuplicateRate(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const strs = arr.map(e => (typeof e === 'string' ? e.trim().toLowerCase() : JSON.stringify(e)));
  const unique = new Set(strs);
  return 1 - unique.size / strs.length;
}

/**
 * verdictDirection(verdict) → 'positive' | 'negative' | 'neutral'
 */
function verdictDirection(verdict) {
  if (!verdict) return 'neutral';
  if (POSITIVE_VERDICTS.has(String(verdict).trim())) return 'positive';
  if (NEGATIVE_VERDICTS.has(String(verdict).trim())) return 'negative';
  return 'neutral';
}

// ═══════════════════════════════════════════════════════════════════
// GATE S1 — SWOT Substantive Content
// ═══════════════════════════════════════════════════════════════════

function validateSWOTSemantic(s1) {
  const issues = [];
  const warnings = [];

  if (!s1) return { issues, warnings };

  const swot = s1.swot || s1.swot_analysis;
  if (!swot || typeof swot !== 'object') return { issues, warnings };

  const quadrants = ['strengths', 'weaknesses', 'opportunities', 'threats'];

  for (const q of quadrants) {
    const entries = Array.isArray(swot[q]) ? swot[q] : [];

    if (entries.length === 0) {
      warnings.push(`SWOT.${q}: empty array — quadrant will render blank`);
      continue;
    }

    // Check for substantive content
    const substantive = entries.filter(e => isSubstantiveText(typeof e === 'string' ? e : e?.point || e?.text || ''));
    if (substantive.length === 0) {
      issues.push(`SWOT.${q}: all ${entries.length} entries are one-word or placeholders — not publication-grade`);
      continue;
    }

    if (substantive.length < entries.length) {
      warnings.push(`SWOT.${q}: ${entries.length - substantive.length} of ${entries.length} entries are too brief (< ${MIN_SWOT_ENTRY_LENGTH} chars)`);
    }

    // Check for hallucination loop (all identical)
    const dupRate = arrayDuplicateRate(entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)));
    if (dupRate > MAX_SWOT_DUPLICATE_RATE) {
      issues.push(`SWOT.${q}: ${Math.round(dupRate * 100)}% duplicate entries — likely hallucination loop`);
    }
  }

  // Cross-quadrant: strengths and weaknesses should not be identical lists
  if (swot.strengths && swot.weaknesses) {
    const strSet = new Set((swot.strengths || []).map(e => String(e).toLowerCase().trim()));
    const weakSet = new Set((swot.weaknesses || []).map(e => String(e).toLowerCase().trim()));
    const overlap = [...strSet].filter(x => weakSet.has(x));
    if (overlap.length > 0) {
      issues.push(`SWOT: ${overlap.length} identical item(s) appear in both Strengths and Weaknesses — incoherent`);
    }
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S2 — TAM Coherence
// ═══════════════════════════════════════════════════════════════════

function validateTAMCoherence(s2) {
  const issues   = [];
  const warnings = [];

  if (!s2) return { issues, warnings };

  const tamRaw = s2.tam_size_estimate;
  const samRaw = s2.sam_size_estimate;
  const somRaw = s2.som_size_estimate;

  const tam = parseTAMValue(tamRaw);
  const sam = parseTAMValue(samRaw);
  const som = parseTAMValue(somRaw);

  // TAM plausibility range
  if (tam !== null) {
    if (tam > MAX_PLAUSIBLE_TAM_USD) {
      issues.push(`TAM: "${tamRaw}" exceeds $50T — almost certainly hallucinated. Largest real markets are $5–15T.`);
    } else if (tam < MIN_PLAUSIBLE_TAM_USD) {
      warnings.push(`TAM: "${tamRaw}" is below $100K — may be too niche to chart meaningfully`);
    }
  }

  // TAM > SAM > SOM hierarchy
  if (tam !== null && sam !== null) {
    if (sam > tam) {
      issues.push(`TAM/SAM inversion: SAM "${samRaw}" > TAM "${tamRaw}" — mathematically impossible. SAM is a subset of TAM.`);
    }
  }

  if (sam !== null && som !== null) {
    if (som > sam) {
      issues.push(`SAM/SOM inversion: SOM "${somRaw}" > SAM "${samRaw}" — mathematically impossible. SOM is a subset of SAM.`);
    }
  }

  // Growth rate format
  const gr = s2.growth_rate;
  if (gr !== null && gr !== undefined) {
    const grStr = String(gr).trim();
    // Growth rate should contain a number, not be a prose paragraph
    if (grStr.length > 30 && !/\d+%?/.test(grStr)) {
      warnings.push(`growth_rate: "${grStr.slice(0, 50)}…" appears to be a prose description, not a percentage`);
    }
    // Suspiciously high growth (> 500% YoY is nearly impossible for an established market)
    const grNum = parseFloat(grStr);
    if (!isNaN(grNum) && grNum > 500) {
      warnings.push(`growth_rate: ${grNum}% seems implausibly high — verify source`);
    }
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S3 — Score Arithmetic Integrity
// ═══════════════════════════════════════════════════════════════════

function validateScoreArithmetic(s2) {
  const issues   = [];
  const warnings = [];

  if (!s2) return { issues, warnings };

  const getScore = (field) => {
    const obj = s2[field];
    if (!obj) return null;
    if (typeof obj === 'number') return obj;
    if (typeof obj?.score === 'number') return obj.score;
    const parsed = parseInt(obj?.score);
    return isNaN(parsed) ? null : parsed;
  };

  const getMax = (field, defaultMax) => {
    const obj = s2[field];
    if (!obj || typeof obj !== 'object') return defaultMax;
    return typeof obj.max === 'number' ? obj.max : defaultMax;
  };

  const demand  = getScore('demand_score');
  const timing  = getScore('market_timing_score');
  const icp     = getScore('icp_fit_score');
  const data    = getScore('data_completeness_score');
  const total   = typeof s2.total_score === 'number' ? s2.total_score : parseInt(s2.total_score);

  // Check each sub-score doesn't exceed its max
  const checks = [
    { field: 'demand_score',           score: demand, max: getMax('demand_score', 40) },
    { field: 'market_timing_score',    score: timing, max: getMax('market_timing_score', 25) },
    { field: 'icp_fit_score',          score: icp,    max: getMax('icp_fit_score', 20) },
    { field: 'data_completeness_score', score: data,  max: getMax('data_completeness_score', 15) },
  ];

  for (const { field, score, max } of checks) {
    if (score !== null && score > max) {
      issues.push(`Score arithmetic: ${field} = ${score} exceeds its max of ${max}`);
    }
    if (score !== null && score < 0) {
      issues.push(`Score arithmetic: ${field} = ${score} is negative`);
    }
  }

  // Sum check
  if (demand !== null && timing !== null && icp !== null && data !== null && !isNaN(total)) {
    const computedSum = demand + timing + icp + data;
    const diff = Math.abs(computedSum - total);
    if (diff > SCORE_SUM_TOLERANCE) {
      issues.push(
        `Score arithmetic: ${demand}+${timing}+${icp}+${data} = ${computedSum} but total_score = ${total} (diff: ${diff} > tolerance ${SCORE_SUM_TOLERANCE})`
      );
    }
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S4 — Confidence Score Calibration
// ═══════════════════════════════════════════════════════════════════

function validateConfidenceCalibration(s5, s7) {
  const issues   = [];
  const warnings = [];

  if (!s5 && !s7) return { issues, warnings };

  const conf5 = s5?.confidence_score !== undefined ? parseInt(s5.confidence_score) : null;
  const conf7 = s7?.confidence_score !== undefined ? parseInt(s7.confidence_score) : null;

  // Cross-step confidence divergence check
  if (conf5 !== null && conf7 !== null && !isNaN(conf5) && !isNaN(conf7)) {
    const divergence = Math.abs(conf5 - conf7);
    if (divergence > 25) {
      issues.push(
        `Confidence divergence: Step 5 reports ${conf5} but Step 7 reports ${conf7} (${divergence} pt gap > 25 pt threshold). Steps must be regenerated to align.`
      );
    }
  }

  // Confidence vs. risk severity: if ALL risks are High, confidence must be low
  if (s5?.key_risks && Array.isArray(s5.key_risks) && s5.key_risks.length > 0) {
    const allHigh = s5.key_risks.every(r => {
      const sev = String(r?.severity || '').toLowerCase();
      return sev === 'high' || sev === 'critical';
    });
    if (allHigh && conf5 !== null && !isNaN(conf5) && conf5 > 65) {
      issues.push(
        `Confidence calibration: confidence_score = ${conf5} but ALL ${s5.key_risks.length} risks have High/Critical severity. Score must be ≤ 65 when all risks are high.`
      );
    }
  }

  // Confidence vs. data richness cap (from Step 7 _data_quality if available)
  const richness = s7?._data_quality?.richness_score;
  if (richness !== undefined && conf7 !== null && !isNaN(conf7)) {
    if (conf7 > richness) {
      warnings.push(
        `Confidence calibration: confidence_score = ${conf7} exceeds data richness ceiling of ${richness}. Step 7 normalizer should have capped this.`
      );
    }
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S5 — GTM Score Bounds
// ═══════════════════════════════════════════════════════════════════

function validateGTMScoreBounds(s1) {
  const issues   = [];
  const warnings = [];

  if (!s1) return { issues, warnings };

  const raw = s1.gtm_relevance_score;
  const score = parseInt(raw, 10);

  if (isNaN(score)) return { issues, warnings };

  if (score > MAX_GTM_SCORE_TYPICAL) {
    warnings.push(
      `GTM score: ${score}/100 is implausibly high for a real company — scores above ${MAX_GTM_SCORE_TYPICAL} are extremely rare and may indicate score inflation`
    );
  }
  if (score < 10) {
    warnings.push(
      `GTM score: ${score}/100 is very low — verify this target is viable for GTM efforts at all`
    );
  }

  // Score must be integer (not 82.7)
  if (raw !== Math.floor(score) && String(raw).includes('.')) {
    warnings.push(`GTM score: "${raw}" is a decimal — should be an integer for chart rendering`);
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S6 — Cross-Step ICP Coherence
// ═══════════════════════════════════════════════════════════════════

function validateICPCoherence(s1, s3, s4) {
  const issues   = [];
  const warnings = [];

  // Step 3 decision_makers vs Step 4 target_roles — should have conceptual overlap
  if (s3?.decision_makers && s4?.target_roles) {
    const dm = Array.isArray(s3.decision_makers)
      ? s3.decision_makers.map(d => String(d?.role || d || '').toLowerCase())
      : [];
    const tr = Array.isArray(s4.target_roles)
      ? s4.target_roles.map(r => String(r || '').toLowerCase())
      : [];

    if (dm.length > 0 && tr.length > 0) {
      // Check for at least one shared keyword between the two lists
      const dmWords = new Set(dm.flatMap(r => r.split(/\s+/)));
      const trWords = tr.flatMap(r => r.split(/\s+/));
      const overlap = trWords.filter(w => w.length > 3 && dmWords.has(w));

      if (overlap.length === 0) {
        warnings.push(
          `ICP coherence: Step 3 decision_makers (${dm.slice(0,2).join(', ')}) share no keywords with Step 4 target_roles (${tr.slice(0,2).join(', ')}) — verify alignment`
        );
      }
    }
  }

  // Step 1 icp_fit.target_description should not be empty while step 3 has ICP
  if (s1?.icp_fit && s3?.primary_icp) {
    const desc = s1.icp_fit.target_description || '';
    if (!isSubstantiveText(desc) && s3.primary_icp) {
      warnings.push(
        `ICP coherence: Step 1 icp_fit.target_description is thin but Step 3 has primary_icp — Step 1 may need richer ICP context`
      );
    }
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S7 — Hallucination Pattern Detection
// ═══════════════════════════════════════════════════════════════════

function detectHallucinationPatterns(s1, s2, s3, s4, s5, s6, s7) {
  const hallucinations = [];
  const warnings       = [];

  // Absurd TAM
  const tam = parseTAMValue(s2?.tam_size_estimate);
  if (tam !== null && tam > MAX_PLAUSIBLE_TAM_USD) {
    hallucinations.push(
      `Hallucinated TAM: "${s2.tam_size_estimate}" ($${(tam/1e12).toFixed(0)}T) — no real market exceeds $50T. Regenerate Step 2.`
    );
  }

  // All SWOT entries identical across quadrants (copy-paste hallucination)
  if (s1?.swot) {
    const allEntries = [
      ...(s1.swot.strengths || []),
      ...(s1.swot.weaknesses || []),
      ...(s1.swot.opportunities || []),
      ...(s1.swot.threats || []),
    ].map(e => String(typeof e === 'string' ? e : e?.point || '').trim().toLowerCase());

    if (allEntries.length >= 4) {
      const uniqueCount = new Set(allEntries).size;
      if (uniqueCount < allEntries.length * 0.4) {
        hallucinations.push(
          `Hallucinated SWOT: ${allEntries.length - uniqueCount} of ${allEntries.length} entries are duplicated across quadrants — likely copy-paste loop`
        );
      }
    }
  }

  // Demand signals all identical
  if (s1?.demand_signals && Array.isArray(s1.demand_signals) && s1.demand_signals.length >= 3) {
    const signalTexts = s1.demand_signals.map(s => String(s?.signal || s || '').toLowerCase());
    const dupRate = arrayDuplicateRate(signalTexts);
    if (dupRate > 0.6) {
      hallucinations.push(
        `Hallucinated demand_signals: ${Math.round(dupRate * 100)}% are duplicates — likely provider loop. Regenerate Step 1.`
      );
    }
  }

  // GTM score 98–100 for any real company
  const gtmScore = parseInt(s1?.gtm_relevance_score);
  if (!isNaN(gtmScore) && gtmScore >= 98) {
    hallucinations.push(
      `Implausible GTM score: ${gtmScore}/100 — no real company scores this high. Score inflation detected. Regenerate Step 1.`
    );
  }

  // Step 7 signal_summary all with identical signal_type
  if (s7?.signal_summary && Array.isArray(s7.signal_summary) && s7.signal_summary.length >= 3) {
    const types = s7.signal_summary.map(s => s?.signal_type || '');
    const uniqueTypes = new Set(types);
    if (uniqueTypes.size === 1) {
      warnings.push(
        `Step 7 signal_summary: all ${s7.signal_summary.length} signals have the same signal_type "${types[0]}" — likely incomplete generation`
      );
    }
  }

  // key_risks all with identical severity
  if (s5?.key_risks && Array.isArray(s5.key_risks) && s5.key_risks.length >= 4) {
    const severities = s5.key_risks.map(r => String(r?.severity || '').toLowerCase());
    const uniqueSev = new Set(severities);
    if (uniqueSev.size === 1 && severities[0]) {
      warnings.push(
        `Step 5 key_risks: all ${s5.key_risks.length} risks have severity "${severities[0]}" — may indicate shallow risk analysis`
      );
    }
  }

  return { hallucinations, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S8 — Verdict Coherence (cross-step)
// ═══════════════════════════════════════════════════════════════════

function validateVerdictCoherence(s3, s6, s7) {
  const incoherence = [];
  const warnings    = [];

  const v3 = verdictDirection(s3?.verdict);
  const v6 = verdictDirection(s6?.verdict);
  const v7 = verdictDirection(s7?.go_no_go?.recommendation);

  // Step 3 vs Step 6: directly opposing verdicts
  if (v3 === 'positive' && v6 === 'negative') {
    incoherence.push(
      `Verdict incoherence: Step 3 verdict is positive ("${s3.verdict}") but Step 6 verdict is negative ("${s6.verdict}"). Steps 3 and 6 must align directionally.`
    );
  }
  if (v3 === 'negative' && v6 === 'positive') {
    incoherence.push(
      `Verdict incoherence: Step 3 verdict is negative ("${s3.verdict}") but Step 6 verdict is positive ("${s6.verdict}"). Steps 3 and 6 must align directionally.`
    );
  }

  // Step 6 vs Step 7 Go/No-Go
  if (v6 === 'positive' && v7 === 'negative') {
    incoherence.push(
      `Verdict incoherence: Step 6 is positive ("${s6.verdict}") but Step 7 Go/No-Go is negative ("${s7?.go_no_go?.recommendation}"). Final intelligence must be consistent with prior verdict.`
    );
  }
  if (v6 === 'negative' && v7 === 'positive') {
    incoherence.push(
      `Verdict incoherence: Step 6 is negative ("${s6.verdict}") but Step 7 recommends "${s7?.go_no_go?.recommendation}". Regenerate Step 7 with updated context.`
    );
  }

  return { incoherence, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S9 — Email Sequence Quality
// ═══════════════════════════════════════════════════════════════════

function validateEmailSequence(s6) {
  const issues   = [];
  const warnings = [];

  if (!s6) return { issues, warnings };

  // Check first email — this is the minimum bar
  const email1 = s6.email_1 || s6.emails?.[0];
  if (!email1) {
    warnings.push('Step 6: no email_1 found — outreach sequence will not render');
    return { issues, warnings };
  }

  const subject = email1.subject || email1.subject_line || '';
  const body    = email1.body    || email1.content || '';

  if (!subject || subject.trim().length < 10) {
    issues.push(
      `Step 6 email_1.subject: "${subject}" is too short (< 10 chars) — renders as blank email header`
    );
  }

  if (!body || body.trim().length < 50) {
    warnings.push(
      `Step 6 email_1.body: body is only ${body.trim().length} chars — likely truncated. Good emails are 100–250 words.`
    );
  }

  // Subject should not be a generic placeholder
  const genericSubjects = ['email subject', 'subject line', 'untitled', 'email 1', 'follow up'];
  if (genericSubjects.some(g => subject.toLowerCase().trim() === g)) {
    issues.push(`Step 6 email_1.subject: "${subject}" is a generic placeholder, not a real subject line`);
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// GATE S10 — Go/No-Go Calibration
// ═══════════════════════════════════════════════════════════════════

function validateGoNoGoCalibration(s1, s5, s7) {
  const issues   = [];
  const warnings = [];

  if (!s7?.go_no_go) return { issues, warnings };

  const rec     = String(s7.go_no_go.recommendation || '').trim();
  const conf    = parseInt(s7.confidence_score ?? s5?.confidence_score ?? 50);
  const gtm     = parseInt(s1?.gtm_relevance_score ?? 50);
  const isGo    = POSITIVE_VERDICTS.has(rec) || rec.toLowerCase() === 'go';
  const isNoGo  = NEGATIVE_VERDICTS.has(rec);

  // "Go" with very low confidence
  if (isGo && !isNaN(conf) && conf < 35) {
    issues.push(
      `Go/No-Go calibration: recommendation is "${rec}" but confidence_score is only ${conf}/100. A Go recommendation requires ≥ 35 confidence.`
    );
  }

  // "Go" with very low GTM score
  if (isGo && !isNaN(gtm) && gtm < 25) {
    issues.push(
      `Go/No-Go calibration: recommendation is "${rec}" but gtm_relevance_score is only ${gtm}/100. A Go recommendation is inconsistent with a score < 25.`
    );
  }

  // "No-Go" with high confidence (paradox — if we're confident, we should know why it's No-Go)
  if (isNoGo && !isNaN(conf) && conf > 85) {
    warnings.push(
      `Go/No-Go calibration: "${rec}" with confidence ${conf}/100 — if data confidence is high, a No-Go verdict should include explicit reasoning`
    );
  }

  return { issues, warnings };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SEMANTIC VALIDATOR
// ═══════════════════════════════════════════════════════════════════

/**
 * runSemanticValidation(strategy) → SemanticValidation
 *
 * @param {object} strategy — full strategy object
 * @returns {SemanticValidation}
 */
export function runSemanticValidation(strategy) {
  const blockingIssues = [];
  const qualityIssues  = [];
  const hallucinations = [];
  const incoherence    = [];

  if (!strategy || typeof strategy !== 'object') {
    return { semanticReady: false, blockingIssues: ['no strategy object'], qualityIssues: [], hallucinations: [], incoherence: [], semanticScore: 0 };
  }

  const s1 = strategy.step_1_market       || null;
  const s2 = strategy.step_2_tam          || null;
  const s3 = strategy.step_3_icp          || null;
  const s4 = strategy.step_4_sourcing     || null;
  const s5 = strategy.step_5_keywords     || null;
  const s6 = strategy.step_6_messaging    || null;
  const s7 = strategy.step_7_intelligence || null;

  // ── S1: SWOT ────────────────────────────────────────────────────
  const swot = validateSWOTSemantic(s1);
  blockingIssues.push(...swot.issues);
  qualityIssues.push(...swot.warnings);

  // ── S2: TAM coherence ───────────────────────────────────────────
  const tam = validateTAMCoherence(s2);
  blockingIssues.push(...tam.issues);
  qualityIssues.push(...tam.warnings);

  // ── S3: Score arithmetic ────────────────────────────────────────
  const scores = validateScoreArithmetic(s2);
  blockingIssues.push(...scores.issues);
  qualityIssues.push(...scores.warnings);

  // ── S4: Confidence calibration ──────────────────────────────────
  const conf = validateConfidenceCalibration(s5, s7);
  blockingIssues.push(...conf.issues);
  qualityIssues.push(...conf.warnings);

  // ── S5: GTM score bounds ────────────────────────────────────────
  const gtm = validateGTMScoreBounds(s1);
  blockingIssues.push(...gtm.issues);
  qualityIssues.push(...gtm.warnings);

  // ── S6: ICP coherence ───────────────────────────────────────────
  const icp = validateICPCoherence(s1, s3, s4);
  blockingIssues.push(...icp.issues);
  qualityIssues.push(...icp.warnings);

  // ── S7: Hallucination patterns ──────────────────────────────────
  const hall = detectHallucinationPatterns(s1, s2, s3, s4, s5, s6, s7);
  hallucinations.push(...hall.hallucinations);
  qualityIssues.push(...hall.warnings);

  // ── S8: Verdict coherence ───────────────────────────────────────
  const verdict = validateVerdictCoherence(s3, s6, s7);
  incoherence.push(...verdict.incoherence);
  qualityIssues.push(...verdict.warnings);

  // ── S9: Email sequence ──────────────────────────────────────────
  const email = validateEmailSequence(s6);
  blockingIssues.push(...email.issues);
  qualityIssues.push(...email.warnings);

  // ── S10: Go/No-Go calibration ───────────────────────────────────
  const gng = validateGoNoGoCalibration(s1, s5, s7);
  blockingIssues.push(...gng.issues);
  qualityIssues.push(...gng.warnings);

  // ── Semantic score ───────────────────────────────────────────────
  let semanticScore = 100;
  semanticScore -= blockingIssues.length  * 10;
  semanticScore -= hallucinations.length  * 15;
  semanticScore -= incoherence.length     * 12;
  semanticScore -= qualityIssues.length   * 2;
  semanticScore  = Math.max(0, Math.min(100, semanticScore));

  const semanticReady = (
    blockingIssues.length === 0 &&
    hallucinations.length === 0 &&
    incoherence.length    === 0
  );

  return {
    semanticReady,
    blockingIssues,
    qualityIssues,
    hallucinations,
    incoherence,
    semanticScore,
  };
}

/**
 * lightSemanticScan(step, data) → { flags: string[], suspicious: boolean }
 *
 * Lightweight per-step scan used INSIDE provider-router.js immediately
 * after normalization — catches hallucinations before data reaches the DB.
 * Does not require the full strategy object.
 */
export function lightSemanticScan(step, data) {
  const flags = [];

  if (!data || typeof data !== 'object') {
    return { flags: ['empty data object'], suspicious: true };
  }

  switch (step) {
    case 1: {
      // GTM score inflation
      const gtm = parseInt(data.gtm_relevance_score);
      if (!isNaN(gtm) && gtm >= 98) {
        flags.push(`gtm_relevance_score=${gtm} is implausibly high (≥98)`);
      }
      // SWOT quadrant duplication
      if (data.swot && typeof data.swot === 'object') {
        const all = [
          ...(data.swot.strengths || []),
          ...(data.swot.weaknesses || []),
        ].map(e => String(e).toLowerCase().trim());
        if (all.length >= 4 && new Set(all).size < all.length * 0.5) {
          flags.push('swot: >50% duplicate entries across quadrants');
        }
      }
      // Demand signals duplication
      if (Array.isArray(data.demand_signals) && data.demand_signals.length >= 3) {
        const texts = data.demand_signals.map(s => String(s?.signal || s || '').toLowerCase());
        if (arrayDuplicateRate(texts) > 0.6) {
          flags.push('demand_signals: >60% are duplicate strings');
        }
      }
      break;
    }

    case 2: {
      // Absurd TAM
      const tam = parseTAMValue(data.tam_size_estimate);
      if (tam !== null && tam > MAX_PLAUSIBLE_TAM_USD) {
        flags.push(`tam_size_estimate="${data.tam_size_estimate}" exceeds $50T`);
      }
      // SAM > TAM inversion
      const sam = parseTAMValue(data.sam_size_estimate);
      if (tam !== null && sam !== null && sam > tam) {
        flags.push(`SAM (${data.sam_size_estimate}) > TAM (${data.tam_size_estimate})`);
      }
      // Score sum
      const d  = data.demand_score?.score || 0;
      const ti = data.market_timing_score?.score || 0;
      const ic = data.icp_fit_score?.score || 0;
      const da = data.data_completeness_score?.score || 0;
      const tot = data.total_score;
      if (typeof tot === 'number' && Math.abs(d + ti + ic + da - tot) > SCORE_SUM_TOLERANCE) {
        flags.push(`score sum ${d}+${ti}+${ic}+${da}=${d+ti+ic+da} ≠ total_score=${tot}`);
      }
      break;
    }

    case 5: {
      // All risks same severity
      if (Array.isArray(data.key_risks) && data.key_risks.length >= 4) {
        const sevs = new Set(data.key_risks.map(r => String(r?.severity || '').toLowerCase()));
        if (sevs.size === 1) {
          flags.push(`key_risks: all ${data.key_risks.length} risks have identical severity "${[...sevs][0]}"`);
        }
      }
      break;
    }

    case 7: {
      // confidence_score vs go_no_go mismatch
      const conf = parseInt(data.confidence_score);
      const rec  = String(data.go_no_go?.recommendation || '');
      const isGo = POSITIVE_VERDICTS.has(rec) || rec.toLowerCase() === 'go';
      if (isGo && !isNaN(conf) && conf < 35) {
        flags.push(`go_no_go="${rec}" but confidence_score=${conf} (< 35)`);
      }
      break;
    }
  }

  return { flags, suspicious: flags.length > 0 };
}
