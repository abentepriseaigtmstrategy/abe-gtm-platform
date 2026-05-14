/**
 * truth-layer.js — ABE GTM Platform
 *
 * Self-contained Truth-Validation Layer.
 * ALL enhanced logic is inlined here — no cross-file imports —
 * so Cloudflare Pages Functions (esbuild) builds cleanly.
 *
 * LEGACY EXPORTS (9 — backward-compatible):
 *   generateTruthMetadata, calculateTruthConfidence, validateTAMClaim,
 *   validateAccountClaims, buildAssumptionLedger, buildValidationWarnings,
 *   classifyClaimType, normalizeSources, validateMarketClaim
 *
 * NEW EXPORTS (6 — enhanced engine):
 *   verifyReport, verifyClaim, collectClaims, calculateTruthScore,
 *   CLASSIFICATIONS, SOURCE_TYPES
 */

// ============================================================================
// CLASSIFICATION CONSTANTS
// ============================================================================

export const CLASSIFICATIONS = {
  VERIFIED:          'verified',
  SOURCE_BACKED:     'source_backed',
  ENRICHED:          'enriched',
  ESTIMATE:          'estimate',
  AI_INFERENCE:      'ai_inference',
  ASSUMPTION:        'assumption',
  MISSING_DATA:      'missing_data',
  UNSUPPORTED_CLAIM: 'unsupported_claim',
  NEEDS_VALIDATION:  'needs_validation',
};

export const SOURCE_TYPES = {
  GA4:    'GA4',
  RAG:    'RAG',
  APOLLO: 'Apollo',
  SERPER: 'Serper',
  USER:   'User',
  AI:     'AI',
  NONE:   'None',
};

// ============================================================================
// INTERNAL UTILITIES
// ============================================================================

function _createVerifiedClaim(claim, classification, confidence, sourceType, reason) {
  return { claim, classification, confidence: Math.round(confidence * 100) / 100, source_type: sourceType, reason };
}

function _parseNumericValue(value) {
  if (typeof value === 'number') return value;
  const str = String(value).replace(/[,$%]/g, '');
  const match = str.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function _extractKeywords(text) {
  if (!text) return [];
  const words = String(text).toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  return [...new Set(words)].slice(0, 10);
}

function _calcRelevance(claimText = '', sourceText = '', keywords = []) {
  if (!sourceText) return 0;
  const cl = String(claimText).toLowerCase();
  const sl = String(sourceText).toLowerCase();
  if (sl.includes(cl)) return 1.0;
  if (!keywords.length) return 0;
  const hits = keywords.filter(kw => sl.includes(String(kw).toLowerCase())).length;
  return hits / keywords.length;
}

function _getStepName(i) {
  return ['', 'market', 'tam', 'icp', 'sourcing', 'keywords', 'messaging'][i] || '';
}

// ============================================================================
// VERIFICATION — GA4
// ============================================================================

function _verifyGA4(claim = {}, ga4 = {}) {
  if (!ga4.data_available || !ga4.payload) return { verified: false, contradicts: false };
  const summary = ga4.payload.summary || {};
  const { type, value, metric } = claim;
  const gtmFields = ['gtm_relevance_score', 'gtm_score', 'confidence_score'];
  if (metric && gtmFields.includes(metric)) return { verified: false, contradicts: false };
  if (metric && summary[metric] !== undefined) {
    const ga4Val = summary[metric];
    const claimVal = _parseNumericValue(value);
    if (Math.abs(ga4Val - claimVal) <= Math.max(ga4Val * 0.05, 1))
      return { verified: true, reason: `Exact match with GA4 ${metric}: ${ga4Val}` };
    return { verified: false, contradicts: true, correctValue: ga4Val };
  }
  if (type === 'date_range' && ga4.payload.date_range) {
    const { startDate, endDate } = ga4.payload.date_range;
    if (value && value.includes(startDate) && value.includes(endDate))
      return { verified: true, reason: `Matches GA4 date range: ${startDate} to ${endDate}` };
  }
  return { verified: false, contradicts: false };
}

function _verifyRAG(claim = {}, rag = {}) {
  if (!rag.documents || !rag.documents.length) return { verified: false };
  const { text, keywords = [] } = claim;
  for (const doc of rag.documents) {
    const score = _calcRelevance(text, doc.content, keywords);
    if (score > 0.8)
      return { verified: true, confidence: score, source: doc.title || doc.url || doc.source || 'RAG document' };
  }
  return { verified: false };
}

function _verifyApollo(claim = {}, apollo = {}) {
  if (!apollo.accounts) return { found: false };
  const { type, value, context = {} } = claim;
  if (type === 'account' || type === 'company') {
    const match = apollo.accounts.find(a => a.name === value || a.domain === value);
    if (match) return { found: true, note: `${match.name} verified in Apollo database` };
  }
  if (type === 'firmographic' && apollo.firmographics && apollo.firmographics[context.field] === value)
    return { found: true, note: `${context.field}: ${value} from Apollo enrichment` };
  return { found: false };
}

function _verifySerper(claim = {}, serper = {}) {
  if (!serper.results) return { found: false };
  const { text, keywords = [] } = claim;
  for (const r of serper.results) {
    if (_calcRelevance(text, r.snippet, keywords) > 0.75)
      return { found: true, note: `Supported by search result: ${r.title}` };
  }
  return { found: false };
}

function _verifyUser(claim = {}, userData = {}) {
  if (!userData) return { verified: false };
  const { type, value } = claim;
  if (type === 'company' && userData.company)
    if (userData.company.name === value || userData.company.website === value) return { verified: true };
  if (type === 'icp' && userData.icp && JSON.stringify(userData.icp).includes(value)) return { verified: true };
  if (userData.facts && Array.isArray(userData.facts) && userData.facts.includes(value)) return { verified: true };
  return { verified: false };
}

function _classifyUnverified(claim = {}, context = {}) {
  const { text, type } = claim;
  if (type === 'market_size' && !context.source)
    return _createVerifiedClaim(text, CLASSIFICATIONS.ESTIMATE, 0.4, SOURCE_TYPES.NONE, 'Market size estimate without verifiable source');
  if (type === 'account_list') {
    if (context.isAnalog === true)
      return _createVerifiedClaim(text, CLASSIFICATIONS.ASSUMPTION, 0.2, SOURCE_TYPES.NONE, 'Anonymized analog accounts for illustration');
    if (!context.source)
      return _createVerifiedClaim(text, CLASSIFICATIONS.NEEDS_VALIDATION, 0.3, SOURCE_TYPES.NONE, 'Account list requires source validation');
  }
  if (type === 'verdict') {
    if (context.rationale && context.signals)
      return _createVerifiedClaim(text, CLASSIFICATIONS.SOURCE_BACKED, 0.7, SOURCE_TYPES.AI, 'Decision supported by documented rationale and signals');
    return _createVerifiedClaim(text, CLASSIFICATIONS.AI_INFERENCE, 0.5, SOURCE_TYPES.AI, 'Strategic recommendation without full signal documentation');
  }
  if (context.isAssumption)
    return _createVerifiedClaim(text, CLASSIFICATIONS.ASSUMPTION, 0.2, SOURCE_TYPES.NONE, 'Explicitly stated assumption');
  if (type === 'time_series' && !context.hasData)
    return _createVerifiedClaim(text, CLASSIFICATIONS.MISSING_DATA, 0.0, SOURCE_TYPES.NONE, 'Time-series data not available for specified period');
  return _createVerifiedClaim(text, CLASSIFICATIONS.AI_INFERENCE, 0.4, SOURCE_TYPES.AI, 'AI-generated inference without primary source verification');
}

// ============================================================================
// CLAIM EXTRACTION HELPERS
// ============================================================================

function _extractMarketClaims(s1 = {}) {
  const claims = [];
  if (s1.market_overview) claims.push({ text: s1.market_overview, type: 'overview', value: s1.market_overview, keywords: _extractKeywords(s1.market_overview), context: { section: 'market', sources: s1.sources || [] } });
  if (s1.gtm_relevance_score !== undefined) claims.push({ text: `GTM Relevance Score: ${s1.gtm_relevance_score}`, type: 'score', value: s1.gtm_relevance_score, metric: 'gtm_relevance_score', keywords: ['score', 'relevance'], context: { section: 'market', isScore: true, isGTMScore: true } });
  return claims;
}

function _extractTAMClaims(s2 = {}) {
  const claims = [];
  const src = (s2.sources && s2.sources.length) ? s2.sources[0] : null;
  if (s2.tam_size_estimate) claims.push({ text: `TAM: ${s2.tam_size_estimate}`, type: 'market_size', value: s2.tam_size_estimate, keywords: ['TAM', 'market', 'size'], context: { section: 'tam', source: src } });
  if (s2.sam_size_estimate) claims.push({ text: `SAM: ${s2.sam_size_estimate}`, type: 'market_size', value: s2.sam_size_estimate, keywords: ['SAM', 'serviceable', 'market'], context: { section: 'tam', source: src } });
  if (s2.som_size_estimate) claims.push({ text: `SOM: ${s2.som_size_estimate}`, type: 'market_size', value: s2.som_size_estimate, keywords: ['SOM', 'obtainable', 'market'], context: { section: 'tam', source: src } });
  return claims;
}

function _extractICPClaims(s3 = {}) {
  const claims = [];
  if (s3.persona_definition) claims.push({ text: s3.persona_definition, type: 'icp', value: s3.persona_definition, keywords: _extractKeywords(s3.persona_definition), context: { section: 'icp', sources: s3.sources || [] } });
  if (Array.isArray(s3.key_pain_points)) s3.key_pain_points.forEach(pain => claims.push({ text: pain, type: 'pain_point', value: pain, keywords: _extractKeywords(pain), context: { section: 'icp', sources: s3.sources || [] } }));
  return claims;
}

function _extractAccountClaims(s4 = {}) {
  const claims = [];
  const src = (s4.sources && s4.sources.length) ? s4.sources[0] : null;
  if (Array.isArray(s4.target_accounts)) {
    claims.push({ text: `${s4.target_accounts.length} target accounts identified`, type: 'account_list', value: s4.target_accounts, keywords: ['accounts', 'target', 'list'], context: { section: 'sourcing', source: src, isAnalog: s4.is_analog === true } });
    s4.target_accounts.forEach(acc => { if (acc && acc.name) claims.push({ text: acc.name, type: 'account', value: acc.name, keywords: [acc.name], context: { section: 'sourcing', isAnalog: s4.is_analog === true } }); });
  }
  return claims;
}

function _extractVerdictClaims(s7 = {}) {
  const claims = [];
  if (s7.go_no_go && s7.go_no_go.recommendation) claims.push({ text: `Verdict: ${s7.go_no_go.recommendation}`, type: 'verdict', value: s7.go_no_go.recommendation, keywords: ['verdict', 'decision', 'recommendation'], context: { section: 'verdict', rationale: s7.go_no_go.rationale, signals: s7.signal_summary } });
  if (s7.gtm_score !== undefined) claims.push({ text: `GTM Score: ${s7.gtm_score}`, type: 'score', value: s7.gtm_score, metric: 'gtm_score', keywords: ['score', 'gtm'], context: { section: 'verdict', isScore: true, isGTMScore: true } });
  if (s7.confidence_score !== undefined) claims.push({ text: `Confidence Score: ${s7.confidence_score}`, type: 'score', value: s7.confidence_score, metric: 'confidence_score', keywords: ['confidence', 'score'], context: { section: 'verdict', isScore: true, isGTMScore: true } });
  return claims;
}

function _extractAnalyticsClaims(analytics = {}) {
  const claims = [];
  if (analytics.activeUsers !== undefined) claims.push({ text: `${analytics.activeUsers} active users`, type: 'analytics', value: analytics.activeUsers, metric: 'activeUsers', keywords: ['users', 'active'], context: { section: 'analytics', isGA4: true } });
  if (analytics.sessions !== undefined) claims.push({ text: `${analytics.sessions} sessions`, type: 'analytics', value: analytics.sessions, metric: 'sessions', keywords: ['sessions'], context: { section: 'analytics', isGA4: true } });
  if (analytics.conversions !== undefined) claims.push({ text: `${analytics.conversions} conversions`, type: 'analytics', value: analytics.conversions, metric: 'conversions', keywords: ['conversions'], context: { section: 'analytics', isGA4: true } });
  return claims;
}

function _generateWarnings(verifiedClaims = []) {
  const warnings = [];
  const unsupported = verifiedClaims.filter(c => c.classification === CLASSIFICATIONS.UNSUPPORTED_CLAIM).length;
  if (unsupported) warnings.push(`${unsupported} claims contradict available data or appear fabricated`);
  const estimates = verifiedClaims.filter(c => c.classification === CLASSIFICATIONS.ESTIMATE).length;
  if (estimates > 3) warnings.push(`${estimates} estimates without source verification — consider adding citations`);
  const needsVal = verifiedClaims.filter(c => c.classification === CLASSIFICATIONS.NEEDS_VALIDATION).length;
  if (needsVal) warnings.push(`${needsVal} claims require human validation before business use`);
  const missingData = verifiedClaims.filter(c => c.classification === CLASSIFICATIONS.MISSING_DATA).length;
  if (missingData > 2) warnings.push(`${missingData} claims reference unavailable data — check data sources`);
  return warnings;
}

function _identifyDataGaps(verifiedClaims = [], groundTruth = {}) {
  const gaps = [];
  if (!groundTruth.ga4 || !groundTruth.ga4.data_available) gaps.push({ source: 'GA4', gap: 'Analytics data not connected', impact: 'Cannot verify traffic, conversion, or engagement claims' });
  if (!groundTruth.rag || !groundTruth.rag.documents || !groundTruth.rag.documents.length) gaps.push({ source: 'RAG', gap: 'No document knowledge base', impact: 'Cannot verify claims against company documentation' });
  if (!groundTruth.apollo) gaps.push({ source: 'Apollo', gap: 'No account enrichment data', impact: 'Cannot verify firmographic or account-level claims' });
  if (!groundTruth.serper) gaps.push({ source: 'Serper', gap: 'No web search verification', impact: 'Cannot cross-reference claims against public information' });
  verifiedClaims.filter(c => c.classification === CLASSIFICATIONS.MISSING_DATA).forEach(c => gaps.push({ source: 'Report', gap: `Missing data for: ${c.claim}`, impact: 'Claim cannot be verified without additional data source' }));
  return gaps;
}

// ============================================================================
// NEW EXPORTS — ENHANCED VERIFICATION ENGINE
// ============================================================================

/**
 * Extract all factual claims from a report.
 */
export function collectClaims(report = {}) {
  const claims = [];
  if (report.step_1_market)  claims.push(..._extractMarketClaims(report.step_1_market));
  if (report.step_2_tam)     claims.push(..._extractTAMClaims(report.step_2_tam));
  if (report.step_3_icp)     claims.push(..._extractICPClaims(report.step_3_icp));
  if (report.step_4_sourcing) claims.push(..._extractAccountClaims(report.step_4_sourcing));
  if (report.step_7_verdict) claims.push(..._extractVerdictClaims(report.step_7_verdict));
  if (report.analytics)      claims.push(..._extractAnalyticsClaims(report.analytics));
  return claims;
}

/**
 * Verify a single claim against all available ground truth sources.
 */
export function verifyClaim(claim = {}, groundTruth = {}) {
  const { text, context = {} } = claim;
  const ga4r = _verifyGA4(claim, groundTruth.ga4 || {});
  if (ga4r.verified)    return _createVerifiedClaim(text, CLASSIFICATIONS.VERIFIED, 1.0, SOURCE_TYPES.GA4, ga4r.reason);
  if (ga4r.contradicts) return _createVerifiedClaim(text, CLASSIFICATIONS.UNSUPPORTED_CLAIM, 0.0, SOURCE_TYPES.GA4, `Contradicts GA4 data. Correct value: ${ga4r.correctValue}`);
  const ragr = _verifyRAG(claim, groundTruth.rag || {});
  if (ragr.verified) return _createVerifiedClaim(text, CLASSIFICATIONS.SOURCE_BACKED, ragr.confidence, SOURCE_TYPES.RAG, `Supported by: ${ragr.source}`);
  const apolr = _verifyApollo(claim, groundTruth.apollo || {});
  if (apolr.found) return _createVerifiedClaim(text, CLASSIFICATIONS.ENRICHED, 0.7, SOURCE_TYPES.APOLLO, `Enriched data from Apollo: ${apolr.note}`);
  const serpr = _verifySerper(claim, groundTruth.serper || {});
  if (serpr.found) return _createVerifiedClaim(text, CLASSIFICATIONS.ENRICHED, 0.6, SOURCE_TYPES.SERPER, `Web search result: ${serpr.note}`);
  const userr = _verifyUser(claim, groundTruth.user || {});
  if (userr.verified) return _createVerifiedClaim(text, CLASSIFICATIONS.VERIFIED, 0.95, SOURCE_TYPES.USER, 'Matches user-provided data');
  return _classifyUnverified(claim, context);
}

/**
 * Calculate truth score from verified claims (0-100).
 */
export function calculateTruthScore(verifiedClaims = []) {
  if (!verifiedClaims.length) return 0;
  const total = verifiedClaims.reduce((sum, c) => sum + (c.confidence || 0), 0);
  return Math.round((total / verifiedClaims.length) * 100);
}

/**
 * Verify an entire GTM report against ground truth sources.
 */
export function verifyReport(report = {}, groundTruth = {}, options = {}) {
  const isDemoMode = options.demo_mode === true;
  const verificationMode = options.verification_mode || 'production';
  const claims = collectClaims(report);
  const verifiedClaims = claims.map(c => verifyClaim(c, groundTruth));
  let truthScore = calculateTruthScore(verifiedClaims);
  if (isDemoMode && truthScore > 85) truthScore = 85;
  return {
    truth_score: truthScore,
    truth_grade: truthScore >= 80 ? 'High' : truthScore >= 50 ? 'Medium' : 'Low',
    claims: verifiedClaims,
    warnings: _generateWarnings(verifiedClaims),
    data_gaps: _identifyDataGaps(verifiedClaims, groundTruth),
    verification_mode: verificationMode,
    safe_disclosure: 'This report was automatically verified against available ground truth. AI-generated strategic recommendations are marked as ai_inference and require human review. See per-claim classifications for trust levels.',
  };
}

// ============================================================================
// LEGACY EXPORTS — BACKWARD COMPATIBLE (9 functions)
// ============================================================================

/**
 * Classifies a specific data claim into a truth category.
 */
export function classifyClaimType(claim, sources = [], isExplicitAssumption = false) {
  if (!claim || claim === '—' || /unknown|n\/a/i.test(String(claim))) return 'missing_data';
  if (isExplicitAssumption) return 'assumption';
  const hasSources = Array.isArray(sources) && sources.length > 0;
  const isNumeric = /\d+/.test(String(claim));
  const isSuspicious = /hallucinate|fake|placeholder/i.test(String(claim));
  if (isSuspicious) return 'unsupported_claim';
  if (hasSources) return sources.some(s => s.verified || s.is_primary) ? 'validated_fact' : 'sourced_claim';
  if (isNumeric) return 'estimate';
  return 'ai_inference';
}

/**
 * Normalizes source metadata from a strategy object.
 */
export function normalizeSources(strategy = {}) {
  const sources = [];
  [1, 2, 3, 4, 5, 6].forEach(i => {
    const stepData = strategy[`step_${i}_${_getStepName(i)}`] || {};
    if (Array.isArray(stepData.sources)) sources.push(...stepData.sources.map(s => ({ step: i, source: s })));
  });
  return sources;
}

/**
 * Validates a market-size or TAM claim.
 */
export function validateMarketClaim(claim, sources = []) {
  const type = classifyClaimType(claim, sources);
  return {
    claim, type,
    isValid: type === 'validated_fact' || type === 'sourced_claim',
    warning: type === 'estimate' ? 'Estimated value — requires source validation'
           : type === 'ai_inference' ? 'AI-inferred claim — not verified' : null,
  };
}

/**
 * Specifically validates TAM/SAM/SOM claims.
 */
export function validateTAMClaim(strategy = {}) {
  const s2 = strategy.step_2_tam || {};
  return validateMarketClaim(s2.tam_size_estimate, s2.sources || []);
}

/**
 * Classifies account data as verified prospects or anonymized analogs.
 */
export function validateAccountClaims(strategy = {}) {
  const s4 = strategy.step_4_sourcing || {};
  const accounts = s4.target_accounts || [];
  const isAnalog = s4.is_analog || !s4.sources || s4.sources.length === 0;
  return {
    count: accounts.length,
    classification: isAnalog ? 'anonymized_analogs' : 'validated_fact',
    verification_status: isAnalog ? 'requires validation' : 'verified',
  };
}

/**
 * Builds a ledger of all assumptions made in the strategy.
 */
export function buildAssumptionLedger(strategy = {}) {
  const ledger = [];
  const s2 = strategy.step_2_tam || {};
  const s3 = strategy.step_3_icp || {};
  if (!s2.sources || !s2.sources.length) ledger.push({ area: 'Market Size', assumption: 'TAM/SAM/SOM based on AI market sector heuristics' });
  if (!s3.sources || !s3.sources.length) ledger.push({ area: 'ICP', assumption: 'Ideal Customer Persona derived from company profile inference' });
  return ledger;
}

/**
 * Aggregates all validation warnings for the strategy.
 */
export function buildValidationWarnings(strategy = {}) {
  const warnings = [];
  const tam = validateTAMClaim(strategy);
  if (tam.warning) warnings.push(tam.warning);
  const acc = validateAccountClaims(strategy);
  if (acc.classification === 'anonymized_analogs') warnings.push('Account lists are illustrative analogs — primary sourcing recommended');
  return warnings;
}

/**
 * Calculates a Truth Confidence score (0-100).
 */
export function calculateTruthConfidence(strategy = {}) {
  const sources = normalizeSources(strategy);
  let score = 40;
  if (sources.length > 10) score += 50;
  else if (sources.length > 5) score += 30;
  else if (sources.length > 0) score += 15;
  const s2 = strategy.step_2_tam || {};
  if (!s2.sources || !s2.sources.length) score -= 10;
  return Math.max(0, Math.min(100, score));
}

/**
 * Entry point to generate all truth metadata for backend_intelligence.
 */
export function generateTruthMetadata(strategy = {}) {
  return {
    truthConfidence:      calculateTruthConfidence(strategy),
    sourceFootnotes:      normalizeSources(strategy),
    assumptionLedger:     buildAssumptionLedger(strategy),
    validationWarnings:   buildValidationWarnings(strategy),
    accountClaims:        validateAccountClaims(strategy),
    claimClassifications: {
      tam:    validateTAMClaim(strategy).type,
      market: classifyClaimType(strategy.step_1_market?.market_overview),
    },
  };
}
