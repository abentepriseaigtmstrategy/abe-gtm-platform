/**
 * ABE GTM Truth Layer - Enhanced Verification Engine
 * 
 * Purpose: Authenticate every factual claim in AI-generated GTM reports
 * against ground truth data sources (GA4, RAG, Apollo, Serper, User data).
 * 
 * Version: 2.0 - Production-ready verification system
 */

// ============================================================================
// CLASSIFICATION CATEGORIES
// ============================================================================

const CLASSIFICATIONS = {
  VERIFIED: 'verified',
  SOURCE_BACKED: 'source_backed',
  ENRICHED: 'enriched',
  ESTIMATE: 'estimate',
  AI_INFERENCE: 'ai_inference',
  ASSUMPTION: 'assumption',
  MISSING_DATA: 'missing_data',
  UNSUPPORTED_CLAIM: 'unsupported_claim',
  NEEDS_VALIDATION: 'needs_validation'
};

const SOURCE_TYPES = {
  GA4: 'GA4',
  RAG: 'RAG',
  APOLLO: 'Apollo',
  SERPER: 'Serper',
  USER: 'User',
  AI: 'AI',
  NONE: 'None'
};

// ============================================================================
// CORE VERIFICATION FUNCTIONS
// ============================================================================

/**
 * Main entry point: Verify an entire GTM report against ground truth
 */
export function verifyReport(report = {}, groundTruth = {}, options = {}) {
  const verificationMode = options.verification_mode || 'production';
  const isDemoMode = options.demo_mode === true;
  
  const claims = collectClaims(report);
  const verifiedClaims = claims.map(claim => verifyClaim(claim, groundTruth));
  
  let truthScore = calculateTruthScore(verifiedClaims);
  
  // Demo mode cap: max 85 to indicate "demo data"
  if (isDemoMode && truthScore > 85) {
    truthScore = 85;
  }
  
  const truthGrade = calculateTruthGrade(truthScore);
  const warnings = generateWarnings(verifiedClaims);
  const dataGaps = identifyDataGaps(verifiedClaims, groundTruth);
  
  return {
    truth_score: truthScore,
    truth_grade: truthGrade,
    claims: verifiedClaims,
    warnings,
    data_gaps: dataGaps,
    verification_mode: verificationMode,
    safe_disclosure: "This report was automatically verified against available ground truth. AI-generated strategic recommendations are marked as ai_inference and require human review. See per-claim classifications for trust levels."
  };
}

/**
 * Extract individual factual claims from a report (public export)
 */
export function collectClaims(report = {}) {
  const claims = [];
  
  if (report.step_1_market) {
    claims.push(...extractMarketClaims(report.step_1_market));
  }
  
  if (report.step_2_tam) {
    claims.push(...extractTAMClaims(report.step_2_tam));
  }
  
  if (report.step_3_icp) {
    claims.push(...extractICPClaims(report.step_3_icp));
  }
  
  if (report.step_4_sourcing) {
    claims.push(...extractAccountClaims(report.step_4_sourcing));
  }
  
  if (report.step_7_verdict) {
    claims.push(...extractVerdictClaims(report.step_7_verdict));
  }
  
  if (report.analytics) {
    claims.push(...extractAnalyticsClaims(report.analytics));
  }
  
  return claims;
}

/**
 * Verify a single claim against all available ground truth sources
 */
export function verifyClaim(claim = {}, groundTruth = {}) {
  const { text, type, value, context = {} } = claim;
  
  // Rule 1: GA4 data is highest authority
  const ga4Result = verifyAgainstGA4(claim, groundTruth.ga4 || {});
  if (ga4Result.verified) {
    return createVerifiedClaim(text, CLASSIFICATIONS.VERIFIED, 1.0, SOURCE_TYPES.GA4, ga4Result.reason);
  }
  if (ga4Result.contradicts) {
    return createVerifiedClaim(
      text, 
      CLASSIFICATIONS.UNSUPPORTED_CLAIM, 
      0.0, 
      SOURCE_TYPES.GA4,
      `Contradicts GA4 data. Correct value: ${ga4Result.correctValue}`
    );
  }
  
  // Rule 2: RAG documents with source citations
  const ragResult = verifyAgainstRAG(claim, groundTruth.rag || {});
  if (ragResult.verified) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.SOURCE_BACKED,
      ragResult.confidence,
      SOURCE_TYPES.RAG,
      `Supported by: ${ragResult.source}`
    );
  }
  
  // Rule 3: Apollo/Serper enrichment (lower confidence)
  const apolloResult = verifyAgainstApollo(claim, groundTruth.apollo || {});
  if (apolloResult.found) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.ENRICHED,
      0.7,
      SOURCE_TYPES.APOLLO,
      `Enriched data from Apollo: ${apolloResult.note}`
    );
  }
  
  const serperResult = verifyAgainstSerper(claim, groundTruth.serper || {});
  if (serperResult.found) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.ENRICHED,
      0.6,
      SOURCE_TYPES.SERPER,
      `Web search result: ${serperResult.note}`
    );
  }
  
  // Rule 4: User-provided data
  const userResult = verifyAgainstUserData(claim, groundTruth.user || {});
  if (userResult.verified) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.VERIFIED,
      0.95,
      SOURCE_TYPES.USER,
      'Matches user-provided data'
    );
  }
  
  // Rule 5-9: Classification based on claim type
  return classifyUnverifiedClaim(claim, context);
}

// ============================================================================
// GA4 VERIFICATION
// ============================================================================

function verifyAgainstGA4(claim = {}, ga4Data = {}) {
  if (!ga4Data || !ga4Data.data_available || !ga4Data.payload) {
    return { verified: false, contradicts: false };
  }
  
  const summary = ga4Data.payload.summary || {};
  const { type, value, metric } = claim;
  
  // CRITICAL FIX: GTM scores are NOT GA4 metrics
  const gtmScoreFields = ['gtm_relevance_score', 'gtm_score', 'confidence_score'];
  if (metric && gtmScoreFields.includes(metric)) {
    return { verified: false, contradicts: false };
  }
  
  // Match exact GA4 metrics
  if (metric && summary[metric] !== undefined) {
    const ga4Value = summary[metric];
    const claimValue = parseNumericValue(value);
    
    // Exact match or within 5% tolerance for floating point
    if (Math.abs(ga4Value - claimValue) <= Math.max(ga4Value * 0.05, 1)) {
      return {
        verified: true,
        reason: `Exact match with GA4 ${metric}: ${ga4Value}`
      };
    }
    
    // Contradiction
    return {
      verified: false,
      contradicts: true,
      correctValue: ga4Value
    };
  }
  
  // Check date range claims
  if (type === 'date_range' && ga4Data.payload.date_range) {
    const { startDate, endDate } = ga4Data.payload.date_range;
    if (value && value.includes(startDate) && value.includes(endDate)) {
      return {
        verified: true,
        reason: `Matches GA4 date range: ${startDate} to ${endDate}`
      };
    }
  }
  
  return { verified: false, contradicts: false };
}

// ============================================================================
// RAG VERIFICATION
// ============================================================================

function verifyAgainstRAG(claim = {}, ragData = {}) {
  if (!ragData || !ragData.documents || ragData.documents.length === 0) {
    return { verified: false };
  }
  
  const { text, keywords = [] } = claim;
  
  for (const doc of ragData.documents) {
    const relevanceScore = calculateTextRelevance(text, doc.content, keywords);
    
    if (relevanceScore > 0.8) {
      return {
        verified: true,
        confidence: relevanceScore,
        source: doc.title || doc.url || doc.source || 'RAG document'
      };
    }
  }
  
  return { verified: false };
}

// ============================================================================
// THIRD-PARTY ENRICHMENT VERIFICATION
// ============================================================================

function verifyAgainstApollo(claim = {}, apolloData = {}) {
  if (!apolloData || !apolloData.accounts) {
    return { found: false };
  }
  
  const { type, value, context = {} } = claim;
  
  if (type === 'account' || type === 'company') {
    const match = apolloData.accounts.find(acc => 
      acc.name === value || acc.domain === value
    );
    
    if (match) {
      return {
        found: true,
        note: `${match.name} verified in Apollo database`
      };
    }
  }
  
  if (type === 'firmographic' && apolloData.firmographics) {
    if (apolloData.firmographics[context.field] === value) {
      return {
        found: true,
        note: `${context.field}: ${value} from Apollo enrichment`
      };
    }
  }
  
  return { found: false };
}

function verifyAgainstSerper(claim = {}, serperData = {}) {
  if (!serperData || !serperData.results) {
    return { found: false };
  }
  
  const { text, keywords = [] } = claim;
  
  for (const result of serperData.results) {
    const relevanceScore = calculateTextRelevance(text, result.snippet, keywords);
    
    if (relevanceScore > 0.75) {
      return {
        found: true,
        note: `Supported by search result: ${result.title}`
      };
    }
  }
  
  return { found: false };
}

// ============================================================================
// USER DATA VERIFICATION
// ============================================================================

function verifyAgainstUserData(claim = {}, userData = {}) {
  if (!userData) {
    return { verified: false };
  }
  
  const { type, value } = claim;
  
  if (type === 'company' && userData.company) {
    if (userData.company.name === value || 
        userData.company.website === value) {
      return { verified: true };
    }
  }
  
  if (type === 'icp' && userData.icp) {
    if (JSON.stringify(userData.icp).includes(value)) {
      return { verified: true };
    }
  }
  
  if (userData.facts && Array.isArray(userData.facts) && userData.facts.includes(value)) {
    return { verified: true };
  }
  
  return { verified: false };
}

// ============================================================================
// UNVERIFIED CLAIM CLASSIFICATION
// ============================================================================

function classifyUnverifiedClaim(claim = {}, context = {}) {
  const { text, type, value } = claim;
  
  // Rule 5: TAM/SAM/SOM without citation = estimate
  if (type === 'market_size' && !context.source) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.ESTIMATE,
      0.4,
      SOURCE_TYPES.NONE,
      'Market size estimate without verifiable source'
    );
  }
  
  // Rule 6: Account lists without source
  // CRITICAL FIX: Analog account lists = assumption
  if (type === 'account_list') {
    if (context.isAnalog === true) {
      return createVerifiedClaim(
        text,
        CLASSIFICATIONS.ASSUMPTION,
        0.2,
        SOURCE_TYPES.NONE,
        'Anonymized analog accounts for illustration'
      );
    }
    if (!context.source) {
      return createVerifiedClaim(
        text,
        CLASSIFICATIONS.NEEDS_VALIDATION,
        0.3,
        SOURCE_TYPES.NONE,
        'Account list requires source validation'
      );
    }
  }
  
  // Rule 7: GO/WATCH/NO-GO with supporting rationale
  if (type === 'verdict') {
    if (context.rationale && context.signals) {
      return createVerifiedClaim(
        text,
        CLASSIFICATIONS.SOURCE_BACKED,
        0.7,
        SOURCE_TYPES.AI,
        'Decision supported by documented rationale and signals'
      );
    }
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.AI_INFERENCE,
      0.5,
      SOURCE_TYPES.AI,
      'Strategic recommendation without full signal documentation'
    );
  }
  
  // Rule 8: Explicit assumptions
  if (context.isAssumption) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.ASSUMPTION,
      0.2,
      SOURCE_TYPES.NONE,
      'Explicitly stated assumption'
    );
  }
  
  // Rule 9: Time-bound claims without matching data
  if (type === 'time_series' && !context.hasData) {
    return createVerifiedClaim(
      text,
      CLASSIFICATIONS.MISSING_DATA,
      0.0,
      SOURCE_TYPES.NONE,
      'Time-series data not available for specified period'
    );
  }
  
  // Default: AI inference
  return createVerifiedClaim(
    text,
    CLASSIFICATIONS.AI_INFERENCE,
    0.4,
    SOURCE_TYPES.AI,
    'AI-generated inference without primary source verification'
  );
}

// ============================================================================
// CLAIM EXTRACTION HELPERS
// ============================================================================

function extractMarketClaims(step1 = {}) {
  const claims = [];
  
  if (step1.market_overview) {
    claims.push({
      text: step1.market_overview,
      type: 'overview',
      value: step1.market_overview,
      keywords: extractKeywords(step1.market_overview),
      context: { section: 'market', sources: step1.sources || [] }
    });
  }
  
  if (step1.gtm_relevance_score !== undefined) {
    claims.push({
      text: `GTM Relevance Score: ${step1.gtm_relevance_score}`,
      type: 'score',
      value: step1.gtm_relevance_score,
      metric: 'gtm_relevance_score',
      keywords: ['score', 'relevance'],
      context: { section: 'market', isScore: true, isGTMScore: true }
    });
  }
  
  return claims;
}

function extractTAMClaims(step2 = {}) {
  const claims = [];
  
  if (step2.tam_size_estimate) {
    claims.push({
      text: `TAM: ${step2.tam_size_estimate}`,
      type: 'market_size',
      value: step2.tam_size_estimate,
      keywords: ['TAM', 'market', 'size'],
      context: { 
        section: 'tam',
        source: (step2.sources && step2.sources.length > 0) ? step2.sources[0] : null
      }
    });
  }
  
  if (step2.sam_size_estimate) {
    claims.push({
      text: `SAM: ${step2.sam_size_estimate}`,
      type: 'market_size',
      value: step2.sam_size_estimate,
      keywords: ['SAM', 'serviceable', 'market'],
      context: {
        section: 'tam',
        source: (step2.sources && step2.sources.length > 0) ? step2.sources[0] : null
      }
    });
  }
  
  if (step2.som_size_estimate) {
    claims.push({
      text: `SOM: ${step2.som_size_estimate}`,
      type: 'market_size',
      value: step2.som_size_estimate,
      keywords: ['SOM', 'obtainable', 'market'],
      context: {
        section: 'tam',
        source: (step2.sources && step2.sources.length > 0) ? step2.sources[0] : null
      }
    });
  }
  
  return claims;
}

function extractICPClaims(step3 = {}) {
  const claims = [];
  
  if (step3.persona_definition) {
    claims.push({
      text: step3.persona_definition,
      type: 'icp',
      value: step3.persona_definition,
      keywords: extractKeywords(step3.persona_definition),
      context: {
        section: 'icp',
        sources: step3.sources || []
      }
    });
  }
  
  if (step3.key_pain_points && Array.isArray(step3.key_pain_points)) {
    step3.key_pain_points.forEach(pain => {
      claims.push({
        text: pain,
        type: 'pain_point',
        value: pain,
        keywords: extractKeywords(pain),
        context: { section: 'icp', sources: step3.sources || [] }
      });
    });
  }
  
  return claims;
}

function extractAccountClaims(step4 = {}) {
  const claims = [];
  
  if (step4.target_accounts && Array.isArray(step4.target_accounts)) {
    claims.push({
      text: `${step4.target_accounts.length} target accounts identified`,
      type: 'account_list',
      value: step4.target_accounts,
      keywords: ['accounts', 'target', 'list'],
      context: {
        section: 'sourcing',
        source: (step4.sources && step4.sources.length > 0) ? step4.sources[0] : null,
        isAnalog: step4.is_analog === true
      }
    });
    
    step4.target_accounts.forEach(account => {
      if (account && account.name) {
        claims.push({
          text: account.name,
          type: 'account',
          value: account.name,
          keywords: [account.name],
          context: {
            section: 'sourcing',
            isAnalog: step4.is_analog === true
          }
        });
      }
    });
  }
  
  return claims;
}

function extractVerdictClaims(step7 = {}) {
  const claims = [];
  
  if (step7.go_no_go && step7.go_no_go.recommendation) {
    claims.push({
      text: `Verdict: ${step7.go_no_go.recommendation}`,
      type: 'verdict',
      value: step7.go_no_go.recommendation,
      keywords: ['verdict', 'decision', 'recommendation'],
      context: {
        section: 'verdict',
        rationale: step7.go_no_go.rationale,
        signals: step7.signal_summary
      }
    });
  }
  
  if (step7.gtm_score !== undefined) {
    claims.push({
      text: `GTM Score: ${step7.gtm_score}`,
      type: 'score',
      value: step7.gtm_score,
      metric: 'gtm_score',
      keywords: ['score', 'gtm'],
      context: { section: 'verdict', isScore: true, isGTMScore: true }
    });
  }
  
  if (step7.confidence_score !== undefined) {
    claims.push({
      text: `Confidence Score: ${step7.confidence_score}`,
      type: 'score',
      value: step7.confidence_score,
      metric: 'confidence_score',
      keywords: ['confidence', 'score'],
      context: { section: 'verdict', isScore: true, isGTMScore: true }
    });
  }
  
  return claims;
}

function extractAnalyticsClaims(analytics = {}) {
  const claims = [];
  
  if (analytics.activeUsers !== undefined) {
    claims.push({
      text: `${analytics.activeUsers} active users`,
      type: 'analytics',
      value: analytics.activeUsers,
      metric: 'activeUsers',
      keywords: ['users', 'active'],
      context: { section: 'analytics', isGA4: true }
    });
  }
  
  if (analytics.sessions !== undefined) {
    claims.push({
      text: `${analytics.sessions} sessions`,
      type: 'analytics',
      value: analytics.sessions,
      metric: 'sessions',
      keywords: ['sessions'],
      context: { section: 'analytics', isGA4: true }
    });
  }
  
  if (analytics.conversions !== undefined) {
    claims.push({
      text: `${analytics.conversions} conversions`,
      type: 'analytics',
      value: analytics.conversions,
      metric: 'conversions',
      keywords: ['conversions'],
      context: { section: 'analytics', isGA4: true }
    });
  }
  
  return claims;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function createVerifiedClaim(claim, classification, confidence, sourceType, reason) {
  return {
    claim,
    classification,
    confidence: Math.round(confidence * 100) / 100,
    source_type: sourceType,
    reason
  };
}

function calculateTextRelevance(claimText = '', sourceText = '', keywords = []) {
  if (!sourceText) return 0;
  
  const claimLower = String(claimText).toLowerCase();
  const sourceLower = String(sourceText).toLowerCase();
  
  if (sourceLower.includes(claimLower)) {
    return 1.0;
  }
  
  let keywordMatches = 0;
  keywords.forEach(kw => {
    if (sourceLower.includes(String(kw).toLowerCase())) {
      keywordMatches++;
    }
  });
  
  if (keywords.length > 0) {
    return keywordMatches / keywords.length;
  }
  
  return 0;
}

function parseNumericValue(value) {
  if (typeof value === 'number') return value;
  
  const str = String(value).replace(/[,$%]/g, '');
  const match = str.match(/[\d.]+/);
  
  return match ? parseFloat(match[0]) : 0;
}

function extractKeywords(text) {
  if (!text) return [];
  
  const words = String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3);
  
  return [...new Set(words)].slice(0, 10);
}

// ============================================================================
// SCORING AND GRADING
// ============================================================================

export function calculateTruthScore(verifiedClaims = []) {
  if (verifiedClaims.length === 0) return 0;
  
  const totalConfidence = verifiedClaims.reduce((sum, claim) => {
    return sum + (claim.confidence || 0);
  }, 0);
  
  return Math.round((totalConfidence / verifiedClaims.length) * 100);
}

function calculateTruthGrade(score) {
  if (score >= 80) return 'High';
  if (score >= 50) return 'Medium';
  return 'Low';
}

function generateWarnings(verifiedClaims = []) {
  const warnings = [];
  
  const unsupportedCount = verifiedClaims.filter(c => 
    c.classification === CLASSIFICATIONS.UNSUPPORTED_CLAIM
  ).length;
  
  if (unsupportedCount > 0) {
    warnings.push(`${unsupportedCount} claims contradict available data or appear fabricated`);
  }
  
  const estimateCount = verifiedClaims.filter(c =>
    c.classification === CLASSIFICATIONS.ESTIMATE
  ).length;
  
  if (estimateCount > 3) {
    warnings.push(`${estimateCount} estimates without source verification - consider adding citations`);
  }
  
  const needsValidationCount = verifiedClaims.filter(c =>
    c.classification === CLASSIFICATIONS.NEEDS_VALIDATION
  ).length;
  
  if (needsValidationCount > 0) {
    warnings.push(`${needsValidationCount} claims require human validation before business use`);
  }
  
  const missingDataCount = verifiedClaims.filter(c =>
    c.classification === CLASSIFICATIONS.MISSING_DATA
  ).length;
  
  if (missingDataCount > 2) {
    warnings.push(`${missingDataCount} claims reference unavailable data - check data sources`);
  }
  
  return warnings;
}

function identifyDataGaps(verifiedClaims = [], groundTruth = {}) {
  const gaps = [];
  
  if (!groundTruth.ga4 || !groundTruth.ga4.data_available) {
    gaps.push({
      source: 'GA4',
      gap: 'Analytics data not connected',
      impact: 'Cannot verify traffic, conversion, or engagement claims'
    });
  }
  
  if (!groundTruth.rag || !groundTruth.rag.documents || groundTruth.rag.documents.length === 0) {
    gaps.push({
      source: 'RAG',
      gap: 'No document knowledge base',
      impact: 'Cannot verify claims against company documentation'
    });
  }
  
  if (!groundTruth.apollo) {
    gaps.push({
      source: 'Apollo',
      gap: 'No account enrichment data',
      impact: 'Cannot verify firmographic or account-level claims'
    });
  }
  
  if (!groundTruth.serper) {
    gaps.push({
      source: 'Serper',
      gap: 'No web search verification',
      impact: 'Cannot cross-reference claims against public information'
    });
  }
  
  const missingDataClaims = verifiedClaims.filter(c =>
    c.classification === CLASSIFICATIONS.MISSING_DATA
  );
  
  missingDataClaims.forEach(claim => {
    gaps.push({
      source: 'Report',
      gap: `Missing data for: ${claim.claim}`,
      impact: 'Claim cannot be verified without additional data source'
    });
  });
  
  return gaps;
}

// ============================================================================
// EXPORT PUBLIC API
// ============================================================================

export {
  CLASSIFICATIONS,
  SOURCE_TYPES
};
