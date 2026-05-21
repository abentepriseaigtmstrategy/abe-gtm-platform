import { canUseLiveIntegration, getIntegrationStatus } from '../integration-readiness.js';

export async function fetchRAGSources(strategy, env = {}) {
  const feature = 'rag';
  const contract = getIntegrationStatus(env).integration_contracts?.[feature];
  const isReady = canUseLiveIntegration(feature, env);

  if (!isReady) {
    return {
      status: contract?.status ?? 'disabled',
      source: 'RAG',
      data_available: false,
      payload: null,
      reason: contract?.reason ?? 'RAG connector is inactive because live integration is not ready.',
    };
  }

  return {
    status: contract?.status ?? 'ready',
    source: 'RAG',
    data_available: false,
    payload: null,
    reason: contract?.reason ?? 'RAG connector is ready for future live activation.',
  };
}
