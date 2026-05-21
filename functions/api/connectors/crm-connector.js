import { canUseLiveIntegration, getIntegrationStatus } from '../integration-readiness.js';

export async function fetchCRMEnrichment(strategy, env = {}) {
  const feature = 'crm_enrichment';
  const contract = getIntegrationStatus(env).integration_contracts?.[feature];
  const isReady = canUseLiveIntegration(feature, env);

  if (!isReady) {
    return {
      status: contract?.status ?? 'disabled',
      source: 'CRM Enrichment',
      data_available: false,
      payload: null,
      reason: contract?.reason ?? 'CRM Enrichment connector is inactive because live integration is not ready.',
    };
  }

  return {
    status: contract?.status ?? 'ready',
    source: 'CRM Enrichment',
    data_available: false,
    payload: null,
    reason: contract?.reason ?? 'CRM Enrichment connector is ready for future live activation.',
  };
}
