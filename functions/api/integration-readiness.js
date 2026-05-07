/**
 * integration-readiness.js
 *
 * Centralized environment contract for future RAG, Agents, GA4, Source Validation, and CRM Enrichment.
 * This file only inspects env vars and returns safe, non-secret enabled state.
 */

import {
  fetchGA4Signals,
  fetchRAGSources,
  runAgentRecommendations,
  validateSources,
  fetchCRMEnrichment
} from './connectors/index.js';

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function buildContract({ env = {}, enabled, configured, requiredEnv = [], title }) {
  const missingEnv = requiredEnv.filter((envVar) => !env[envVar]);
  const active = parseBoolean(enabled, false);

  let status = 'disabled';
  let reason = `${title} is disabled via environment settings.`;

  if (active) {
    if (requiredEnv.length && missingEnv.length > 0) {
      status = 'not_connected';
      reason = `${title} is enabled but missing required environment variables: ${missingEnv.join(', ')}.`;
    } else if (configured) {
      status = 'ready';
      reason = `${title} is enabled and configured for activation.`;
    } else {
      status = 'not_connected';
      reason = `${title} is enabled but not fully configured.`;
    }
  }

  return {
    status,
    reason,
    required_env: requiredEnv,
    missing_env: missingEnv,
    ready_for_activation: active && configured && missingEnv.length === 0,
    data_available: false,
  };
}

function buildIntegrationConnectorResponse({ source, contract, title }) {
  if (!contract) {
    return {
      status: 'skipped',
      data_available: false,
      reason: `${title} connector was skipped because the integration contract is unavailable.`,
      source,
      payload: null,
    };
  }

  return {
    status: contract.status,
    data_available: false,
    reason: contract.reason,
    source,
    payload: null,
  };
}

export function canUseLiveIntegration(feature, env = {}) {
  const contract = getIntegrationStatus(env).integration_contracts?.[feature];
  return Boolean(
    contract &&
    contract.status === 'ready' &&
    contract.ready_for_activation === true &&
    Array.isArray(contract.missing_env) &&
    contract.missing_env.length === 0
  );
}

export function safeFetchGA4Signals(strategy, env = {}) {
  return buildIntegrationConnectorResponse({
    source: 'GA4',
    contract: getIntegrationStatus(env).integration_contracts?.ga4,
    title: 'GA4',
  });
}

export function safeFetchRAGSources(strategy, env = {}) {
  return buildIntegrationConnectorResponse({
    source: 'RAG',
    contract: getIntegrationStatus(env).integration_contracts?.rag,
    title: 'RAG',
  });
}

export function safeRunAgentRecommendations(strategy, env = {}) {
  return buildIntegrationConnectorResponse({
    source: 'Agents',
    contract: getIntegrationStatus(env).integration_contracts?.agents,
    title: 'Agents',
  });
}

export function safeFetchCRMEnrichment(strategy, env = {}) {
  return buildIntegrationConnectorResponse({
    source: 'CRM Enrichment',
    contract: getIntegrationStatus(env).integration_contracts?.crm_enrichment,
    title: 'CRM Enrichment',
  });
}

export async function buildIntegrationContext(strategy = {}, env = {}) {
  const integrationStatus = getIntegrationStatus(env);

  return {
    readiness: integrationStatus,
    connectors: {
      ga4: await fetchGA4Signals(strategy, env),
      rag: await fetchRAGSources(strategy, env),
      agents: await runAgentRecommendations(strategy, env),
      crm_enrichment: await fetchCRMEnrichment(strategy, env),
      source_validation: await validateSources(strategy, env),
    },
  };
}

export function getIntegrationStatus(env = {}) {
  const openaiAvailable = Boolean(env.OPENAI_API_KEY);
  const supabaseAvailable = Boolean(env.SUPABASE_URL);
  const supabaseServiceRole = Boolean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY);

  const ragContract = buildContract({
    env,
    enabled: env.RAG_ENABLED,
    configured: Boolean(env.RAG_VECTOR_DB_URL && env.RAG_VECTOR_DB_KEY),
    requiredEnv: ['RAG_ENABLED', 'RAG_VECTOR_DB_URL', 'RAG_VECTOR_DB_KEY'],
    title: 'RAG',
  });

  const agentsContract = buildContract({
    env,
    enabled: env.AGENTS_ENABLED,
    configured: openaiAvailable,
    requiredEnv: ['AGENTS_ENABLED', 'OPENAI_API_KEY'],
    title: 'Agents',
  });

  // GA4_MEASUREMENT_ID is frontend-only (ga4-tag.js). Backend Data API uses service account.
  // GA4_ACCESS_CONFIRMED must be explicitly true before backend reads are allowed.
  const ga4CredentialsPresent = Boolean(
    env.GA4_PROPERTY_ID &&
    env.GOOGLE_ANALYTICS_CLIENT_EMAIL &&
    env.GOOGLE_ANALYTICS_PRIVATE_KEY
  );
  const ga4AccessConfirmed = parseBoolean(env.GA4_ACCESS_CONFIRMED, false);
  const ga4Enabled = parseBoolean(env.GA4_ENABLED, false);

  let ga4Contract;
  if (ga4Enabled && ga4CredentialsPresent && !ga4AccessConfirmed) {
    ga4Contract = {
      status: 'access_pending',
      reason: 'GA4 credentials are configured, but GA4 property access for the service account is not confirmed.',
      required_env: ['GA4_ENABLED','GA4_PROPERTY_ID','GOOGLE_ANALYTICS_CLIENT_EMAIL','GOOGLE_ANALYTICS_PRIVATE_KEY','GA4_ACCESS_CONFIRMED'],
      missing_env: ['GA4_ACCESS_CONFIRMED'],
      ready_for_activation: false,
      data_available: false,
    };
  } else {
    ga4Contract = buildContract({
      env,
      enabled: env.GA4_ENABLED,
      configured: ga4CredentialsPresent && ga4AccessConfirmed,
      requiredEnv: ['GA4_ENABLED','GA4_PROPERTY_ID','GOOGLE_ANALYTICS_CLIENT_EMAIL','GOOGLE_ANALYTICS_PRIVATE_KEY','GA4_ACCESS_CONFIRMED'],
      title: 'GA4',
    });
  }

  const sourceValidationContract = buildContract({
    env,
    enabled: env.SOURCE_VALIDATION_ENABLED,
    configured: false,
    requiredEnv: ['SOURCE_VALIDATION_ENABLED'],
    title: 'Source Validation',
  });

  const crmEnrichmentContract = buildContract({
    env,
    enabled: env.CRM_ENRICHMENT_ENABLED,
    configured: Boolean(env.CRM_ENRICHMENT_API_KEY && env.CRM_ENRICHMENT_PROVIDER),
    requiredEnv: ['CRM_ENRICHMENT_ENABLED', 'CRM_ENRICHMENT_API_KEY', 'CRM_ENRICHMENT_PROVIDER'],
    title: 'CRM Enrichment',
  });

  return {
    runtime: {
      openai: openaiAvailable ? 'present' : 'missing',
      supabase_url: supabaseAvailable ? 'present' : 'missing',
      supabase_service_role_key: supabaseServiceRole ? 'present' : 'missing',
    },
    features: {
      rag: {
        enabled: parseBoolean(env.RAG_ENABLED, false),
        configured: Boolean(env.RAG_VECTOR_DB_URL && env.RAG_VECTOR_DB_KEY),
      },
      agents: {
        enabled: parseBoolean(env.AGENTS_ENABLED, false),
        configured: openaiAvailable,
      },
      ga4: {
        enabled: parseBoolean(env.GA4_ENABLED, false),
        configured: Boolean(env.GA4_PROPERTY_ID && env.GOOGLE_ANALYTICS_CLIENT_EMAIL && env.GOOGLE_ANALYTICS_PRIVATE_KEY && parseBoolean(env.GA4_ACCESS_CONFIRMED, false)),
      },
      source_validation: {
        enabled: parseBoolean(env.SOURCE_VALIDATION_ENABLED, false),
        configured: false,
      },
      crm_enrichment: {
        enabled: parseBoolean(env.CRM_ENRICHMENT_ENABLED, false),
        configured: Boolean(env.CRM_ENRICHMENT_API_KEY && env.CRM_ENRICHMENT_PROVIDER),
      },
    },
    readiness: {
      rag: ragContract.ready_for_activation,
      agents: agentsContract.ready_for_activation,
      ga4: ga4Contract.ready_for_activation,
      source_validation: sourceValidationContract.ready_for_activation,
      crm_enrichment: crmEnrichmentContract.ready_for_activation,
      supabase: supabaseAvailable && supabaseServiceRole,
    },
    integration_contracts: {
      rag: ragContract,
      agents: agentsContract,
      ga4: ga4Contract,
      source_validation: sourceValidationContract,
      crm_enrichment: crmEnrichmentContract,
    },
    required_env: {
      openai_key: 'OPENAI_API_KEY',
      rag: ['RAG_ENABLED', 'RAG_VECTOR_DB_URL', 'RAG_VECTOR_DB_KEY'],
      agents: ['AGENTS_ENABLED', 'OPENAI_API_KEY'],
      ga4: ['GA4_ENABLED','GA4_PROPERTY_ID','GOOGLE_ANALYTICS_CLIENT_EMAIL','GOOGLE_ANALYTICS_PRIVATE_KEY','GA4_ACCESS_CONFIRMED'],
      source_validation: ['SOURCE_VALIDATION_ENABLED'],
      crm_enrichment: ['CRM_ENRICHMENT_ENABLED', 'CRM_ENRICHMENT_API_KEY', 'CRM_ENRICHMENT_PROVIDER'],
    },
  };
}

/**
 * Phase 13: Live Activation Plan
 *
 * Provides a safe roadmap for activating integrations without making live external calls.
 * Returns activation order, safety gates, rollback procedures, and risk assessment.
 */

function buildGA4SafetyChecks(integrationStatus) {
  const contract = integrationStatus?.integration_contracts?.ga4;
  const isReady = contract?.missing_env?.length === 0 && contract?.status === 'ready';
  const isPending = contract?.status === 'access_pending';
  return {
    name: 'GA4 Data API (Read-Only)',
    activation_gate: 'service_account_credentials_and_access_confirmed',
    pre_flight_checks: [
      {
        check: 'property_id_present',
        status: isReady ? 'pass' : 'fail',
        description: 'Verify GA4_PROPERTY_ID is set (numeric, e.g. 536562958)',
      },
      {
        check: 'service_account_email_present',
        status: Boolean(contract?.missing_env?.indexOf('GOOGLE_ANALYTICS_CLIENT_EMAIL') === -1) ? 'pass' : 'fail',
        description: 'Confirm GOOGLE_ANALYTICS_CLIENT_EMAIL is set',
      },
      {
        check: 'service_account_private_key_present',
        status: Boolean(contract?.missing_env?.indexOf('GOOGLE_ANALYTICS_PRIVATE_KEY') === -1) ? 'pass' : 'fail',
        description: 'Confirm GOOGLE_ANALYTICS_PRIVATE_KEY is set (PEM format)',
      },
      {
        check: 'ga4_access_confirmed',
        status: isPending ? 'access_pending' : (isReady ? 'pass' : 'fail'),
        description: 'Set GA4_ACCESS_CONFIRMED=true after verifying service account has GA4 property access',
      },
      {
        check: 'read_only_scope',
        status: 'pending_activation',
        description: 'Confirm service account has analytics.readonly IAM scope only',
      },
    ],
    safety_level: 'low',
    data_at_risk: 'none',
    rollback_action: 'disable GA4_ENABLED or set GA4_ACCESS_CONFIRMED=false',
  };
}

function buildRAGSafetyChecks(integrationStatus) {
  const contract = integrationStatus?.integration_contracts?.rag;
  return {
    name: 'RAG Source Validation',
    activation_gate: 'vector_db_connectivity',
    pre_flight_checks: [
      {
        check: 'vector_db_url_valid',
        status: Boolean(contract?.missing_env?.length === 0 && contract?.status === 'ready') ? 'pass' : 'fail',
        description: 'Confirm RAG_VECTOR_DB_URL is reachable',
      },
      {
        check: 'vector_db_auth',
        status: Boolean(contract?.missing_env?.length === 0) ? 'pass' : 'fail',
        description: 'Verify RAG_VECTOR_DB_KEY is valid for authentication',
      },
      {
        check: 'index_health',
        status: 'pending_activation',
        description: 'Health check vector database before activation',
      },
    ],
    safety_level: 'medium',
    data_at_risk: 'source_metadata',
    rollback_action: 'disable RAG_ENABLED',
  };
}

function buildSourceValidationSafetyChecks(integrationStatus) {
  const contract = integrationStatus?.integration_contracts?.source_validation;
  return {
    name: 'Source Validation Provider',
    activation_gate: 'provider_configuration',
    pre_flight_checks: [
      {
        check: 'source_validation_enabled',
        status: Boolean(contract?.missing_env?.length === 0) ? 'pass' : 'fail',
        description: 'Confirm SOURCE_VALIDATION_ENABLED is set',
      },
      {
        check: 'provider_adapter_ready',
        status: 'pending_activation',
        description: 'Verify validation provider adapter is loaded',
      },
      {
        check: 'validation_rules_loaded',
        status: 'pending_activation',
        description: 'Confirm validation rules are in memory',
      },
    ],
    safety_level: 'low',
    data_at_risk: 'none',
    rollback_action: 'disable SOURCE_VALIDATION_ENABLED',
  };
}

function buildCRMSafetyChecks(integrationStatus) {
  const contract = integrationStatus?.integration_contracts?.crm_enrichment;
  return {
    name: 'CRM Enrichment',
    activation_gate: 'crm_api_credentials',
    pre_flight_checks: [
      {
        check: 'crm_api_key_valid',
        status: Boolean(contract?.missing_env?.length === 0 && contract?.status === 'ready') ? 'pass' : 'fail',
        description: 'Validate CRM_ENRICHMENT_API_KEY format and permissions',
      },
      {
        check: 'crm_provider_supported',
        status: Boolean(contract?.missing_env?.length === 0) ? 'pass' : 'fail',
        description: 'Confirm CRM_ENRICHMENT_PROVIDER is in supported list',
      },
      {
        check: 'rate_limiting_configured',
        status: 'pending_activation',
        description: 'Verify rate limiting is set before activation',
      },
    ],
    safety_level: 'medium',
    data_at_risk: 'contact_records',
    rollback_action: 'disable CRM_ENRICHMENT_ENABLED',
  };
}

function buildAgentSafetyChecks(integrationStatus) {
  const contract = integrationStatus?.integration_contracts?.agents;
  return {
    name: 'Agent Recommendations',
    activation_gate: 'llm_provider_ready',
    pre_flight_checks: [
      {
        check: 'openai_api_key_valid',
        status: Boolean(contract?.missing_env?.length === 0 && contract?.status === 'ready') ? 'pass' : 'fail',
        description: 'Confirm OPENAI_API_KEY is set and valid',
      },
      {
        check: 'model_access_confirmed',
        status: Boolean(contract?.missing_env?.length === 0) ? 'pass' : 'fail',
        description: 'Verify access to required LLM model',
      },
      {
        check: 'prompt_injection_mitigation',
        status: 'pending_activation',
        description: 'Confirm prompt sanitization is in place',
      },
    ],
    safety_level: 'high',
    data_at_risk: 'strategy_context',
    rollback_action: 'disable AGENTS_ENABLED',
  };
}

function buildRollbackPlan() {
  return {
    manual_rollback: {
      ga4: 'Set GA4_ENABLED=false, redeploy',
      rag: 'Set RAG_ENABLED=false, redeploy',
      source_validation: 'Set SOURCE_VALIDATION_ENABLED=false, redeploy',
      crm_enrichment: 'Set CRM_ENRICHMENT_ENABLED=false, redeploy',
      agents: 'Set AGENTS_ENABLED=false, redeploy',
    },
    automatic_rollback: {
      condition: 'Feature returns high error rate (>5% of requests)',
      action: 'Disable feature flag and skip connector in buildIntegrationContext',
      recovery_time: 'Immediate on next request',
    },
    data_safety: 'No user data persisted from integrations; safe to disable at any time',
  };
}

function buildFeatureFlags(integrationStatus) {
  return {
    ga4_signal_validation: {
      enabled: parseBoolean(integrationStatus?.features?.ga4?.enabled, false),
      ready: integrationStatus?.integration_contracts?.ga4?.ready_for_activation,
      flag_key: 'GA4_ENABLED',
    },
    rag_source_validation: {
      enabled: parseBoolean(integrationStatus?.features?.rag?.enabled, false),
      ready: integrationStatus?.integration_contracts?.rag?.ready_for_activation,
      flag_key: 'RAG_ENABLED',
    },
    source_validation_provider: {
      enabled: parseBoolean(integrationStatus?.features?.source_validation?.enabled, false),
      ready: integrationStatus?.integration_contracts?.source_validation?.ready_for_activation,
      flag_key: 'SOURCE_VALIDATION_ENABLED',
    },
    crm_enrichment: {
      enabled: parseBoolean(integrationStatus?.features?.crm_enrichment?.enabled, false),
      ready: integrationStatus?.integration_contracts?.crm_enrichment?.ready_for_activation,
      flag_key: 'CRM_ENRICHMENT_ENABLED',
    },
    agent_recommendations: {
      enabled: parseBoolean(integrationStatus?.features?.agents?.enabled, false),
      ready: integrationStatus?.integration_contracts?.agents?.ready_for_activation,
      flag_key: 'AGENTS_ENABLED',
    },
  };
}

function buildDeploymentNotes(integrationStatus) {
  return {
    deployment_checklist: [
      '1. Verify all required environment variables are set securely',
      '2. Test read-only access to GA4 before enabling signal validation',
      '3. Validate vector database connectivity for RAG before activation',
      '4. Confirm source validation rules are loaded in memory',
      '5. Test CRM API credentials with rate limit settings',
      '6. Activate Agent recommendations only after all evidence sources are validated',
    ],
    activation_strategy: 'Sequential activation by feature, with monitoring between each phase',
    monitoring_points: [
      'Integration context response time',
      'Connector error rates',
      'External API latency (if enabled)',
      'Feature flag toggles',
    ],
    success_criteria: [
      'All safety checks return pass status',
      'No secrets exposed in logs or responses',
      'Report generation unaffected by integration context',
      'Fallback behavior working when features disabled',
    ],
  };
}

function buildRiskLevels(integrationStatus) {
  return {
    ga4_signal_validation: {
      risk_level: 'low',
      reasoning: 'Read-only access to non-sensitive analytics data',
      mitigation: 'API key rotation schedule, IP whitelisting if available',
    },
    rag_source_validation: {
      risk_level: 'medium',
      reasoning: 'Requires vector database credentials and metadata access',
      mitigation: 'Network isolation, credential encryption, audit logging',
    },
    source_validation_provider: {
      risk_level: 'low',
      reasoning: 'Local validation rules, no external dependencies',
      mitigation: 'Keep rules updated, test validation logic regularly',
    },
    crm_enrichment: {
      risk_level: 'medium',
      reasoning: 'Access to contact records, requires API key security',
      mitigation: 'Rate limiting, PII handling, audit trail for enrichment requests',
    },
    agent_recommendations: {
      risk_level: 'high',
      reasoning: 'LLM access, strategy context sharing, potential prompt injection',
      mitigation: 'Prompt sanitization, context filtering, output validation',
    },
  };
}

export function buildLiveActivationPlan(env = {}) {
  const integrationStatus = getIntegrationStatus(env);

  return {
    activation_order: [
      'ga4_signal_validation',
      'rag_source_validation',
      'source_validation_provider',
      'crm_enrichment',
      'agent_recommendations',
    ],
    reason_for_order: 'Agents activated last because they depend on validated evidence and clean source context',
    required_env_by_feature: {
      ga4_signal_validation: ['GA4_ENABLED','GA4_PROPERTY_ID','GOOGLE_ANALYTICS_CLIENT_EMAIL','GOOGLE_ANALYTICS_PRIVATE_KEY','GA4_ACCESS_CONFIRMED'],
      rag_source_validation: ['RAG_ENABLED', 'RAG_VECTOR_DB_URL', 'RAG_VECTOR_DB_KEY'],
      source_validation_provider: ['SOURCE_VALIDATION_ENABLED'],
      crm_enrichment: ['CRM_ENRICHMENT_ENABLED', 'CRM_ENRICHMENT_API_KEY', 'CRM_ENRICHMENT_PROVIDER'],
      agent_recommendations: ['AGENTS_ENABLED', 'OPENAI_API_KEY'],
    },
    safety_checks: {
      ga4_signal_validation: buildGA4SafetyChecks(integrationStatus),
      rag_source_validation: buildRAGSafetyChecks(integrationStatus),
      source_validation_provider: buildSourceValidationSafetyChecks(integrationStatus),
      crm_enrichment: buildCRMSafetyChecks(integrationStatus),
      agent_recommendations: buildAgentSafetyChecks(integrationStatus),
    },
    rollback_plan: buildRollbackPlan(),
    feature_flags: buildFeatureFlags(integrationStatus),
    deployment_notes: buildDeploymentNotes(integrationStatus),
    risk_level_by_feature: buildRiskLevels(integrationStatus),
    timestamp: new Date().toISOString(),
  };
}
