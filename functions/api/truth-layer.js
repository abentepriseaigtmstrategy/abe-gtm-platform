/**
 * truth-layer.js
 * 
 * Truth-Validation Layer for ABE GTM Platform
 * 
 * This file maintains backward compatibility with existing code while providing
 * access to the enhanced verification engine.
 * 
 * LEGACY EXPORTS (preserved for backward compatibility):
 * - classifyClaimType
 * - normalizeSources
 * - validateMarketClaim
 * - validateTAMClaim
 * - validateAccountClaims
 * - buildAssumptionLedger
 * - buildValidationWarnings
 * - calculateTruthConfidence
 * - generateTruthMetadata
 * 
 * NEW EXPORTS (enhanced engine):
 * - verifyReport
 * - verifyClaim
 * - collectClaims
 * - calculateTruthScore
 */

// Import enhanced engine
import { 
  verifyReport as enhancedVerifyReport,
  verifyClaim as enhancedVerifyClaim,
  collectClaims as enhancedCollectClaims,
  calculateTruthScore as enhancedCalculateTruthScore,
  CLASSIFICATIONS,
  SOURCE_TYPES
} from './abe-truth-layer-enhanced.js';

// ============================================================================
// LEGACY EXPORTS - PRESERVED FOR BACKWARD COMPATIBILITY
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
  if (hasSources) {
    return (sources.some(s => s.verified || s.is_primary)) ? 'validated_fact' : 'sourced_claim';
  }
  if (isNumeric) return 'estimate';
  return 'ai_inference';
}

/**
 * Normalizes source metadata from a strategy object.
 */
export function normalizeSources(strategy = {}) {
  const sources = [];
  const steps = [1, 2, 3, 4, 5, 6];
  
  steps.forEach(i => {
    const stepData = strategy[`step_${i}_${getStepName(i)}`] || {};
    if (Array.isArray(stepData.sources)) {
      sources.push(...stepData.sources.map(s => ({ step: i, source: s })));
    }
  });
  
  return sources;
}

/**
 * Validates a market-size or TAM claim.
 */
export function validateMarketClaim(claim, sources = []) {
  const type = classifyClaimType(claim, sources);
  return {
    claim,
    type,
    isValid: type === 'validated_fact' || type === 'sourced_claim',
    warning: type === 'estimate' ? 'Estimated value — requires source validation' : 
             type === 'ai_inference' ? 'AI-inferred claim — not verified' : null
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
  
  // If no source or explicit analog flag, treat as analogs
  const isAnalog = s4.is_analog || !s4.sources || s4.sources.length === 0;
  
  return {
    count: accounts.length,
    classification: isAnalog ? 'anonymized_analogs' : 'validated_fact',
    verification_status: isAnalog ? 'requires validation' : 'verified'
  };
}

/**
 * Builds a ledger of all assumptions made in the strategy.
 */
export function buildAssumptionLedger(strategy = {}) {
  const ledger = [];
  const s2 = strategy.step_2_tam || {};
  const s3 = strategy.step_3_icp || {};
  
  if (!s2.sources || s2.sources.length === 0) {
    ledger.push({ area: 'Market Size', assumption: 'TAM/SAM/SOM based on AI market sector heuristics' });
  }
  if (!s3.sources || s3.sources.length === 0) {
    ledger.push({ area: 'ICP', assumption: 'Ideal Customer Persona derived from company profile inference' });
  }
  
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
  if (acc.classification === 'anonymized_analogs') {
    warnings.push('Account lists are illustrative analogs — primary sourcing recommended');
  }
  
  return warnings;
}

/**
 * Calculates a Truth Confidence score (0-100).
 */
export function calculateTruthConfidence(strategy = {}) {
  const sources = normalizeSources(strategy);
  let score = 40; // Base score for AI structure
  
  if (sources.length > 10) score += 50;
  else if (sources.length > 5) score += 30;
  else if (sources.length > 0) score += 15;
  
  // Penalize for lack of TAM sources
  const s2 = strategy.step_2_tam || {};
  if (!s2.sources || s2.sources.length === 0) score -= 10;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Entry point to generate all truth metadata for backend_intelligence.
 */
export function generateTruthMetadata(strategy = {}) {
  return {
    truthConfidence: calculateTruthConfidence(strategy),
    sourceFootnotes: normalizeSources(strategy),
    assumptionLedger: buildAssumptionLedger(strategy),
    validationWarnings: buildValidationWarnings(strategy),
    accountClaims: validateAccountClaims(strategy),
    claimClassifications: {
      tam: validateTAMClaim(strategy).type,
      market: classifyClaimType(strategy.step_1_market?.market_overview)
    }
  };
}

// ============================================================================
// NEW EXPORTS - ENHANCED VERIFICATION ENGINE
// ============================================================================

/**
 * Verify an entire GTM report against ground truth sources.
 * 
 * @param {Object} report - The GTM strategy/report to verify
 * @param {Object} groundTruth - Available verification sources (GA4, RAG, Apollo, Serper, User)
 * @param {Object} options - Verification options (verification_mode, demo_mode)
 * @returns {Object} Verification result with truth_score, claims, warnings, data_gaps
 */
export function verifyReport(report = {}, groundTruth = {}, options = {}) {
  return enhancedVerifyReport(report, groundTruth, options);
}

/**
 * Verify a single claim against ground truth sources.
 * 
 * @param {Object} claim - The claim to verify
 * @param {Object} groundTruth - Available verification sources
 * @returns {Object} Verified claim with classification, confidence, source_type, reason
 */
export function verifyClaim(claim = {}, groundTruth = {}) {
  return enhancedVerifyClaim(claim, groundTruth);
}

/**
 * Extract all factual claims from a report.
 * 
 * @param {Object} report - The GTM strategy/report
 * @returns {Array} Array of claim objects
 */
export function collectClaims(report = {}) {
  return enhancedCollectClaims(report);
}

/**
 * Calculate truth score from verified claims.
 * 
 * @param {Array} verifiedClaims - Array of verified claim objects
 * @returns {Number} Truth score (0-100)
 */
export function calculateTruthScore(verifiedClaims = []) {
  return enhancedCalculateTruthScore(verifiedClaims);
}

/**
 * Export classification constants for external use
 */
export { CLASSIFICATIONS, SOURCE_TYPES };

// ============================================================================
// HELPER FUNCTIONS (INTERNAL)
// ============================================================================

function getStepName(i) {
  const names = ['', 'market', 'tam', 'icp', 'sourcing', 'keywords', 'messaging'];
  return names[i];
}
