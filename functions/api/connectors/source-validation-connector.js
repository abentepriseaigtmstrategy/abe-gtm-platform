import { canUseLiveIntegration, getIntegrationStatus } from '../integration-readiness.js';

export async function validateSources(strategy, env = {}) {
  const feature = 'source_validation';
  const contract = getIntegrationStatus(env).integration_contracts?.[feature];
  const isReady = canUseLiveIntegration(feature, env);

  if (!isReady) {
    return {
      status: contract?.status ?? 'disabled',
      source: 'Source Validation',
      data_available: false,
      payload: null,
      reason: contract?.reason ?? 'Source Validation connector is inactive because live integration is not ready.',
    };
  }

  return {
    status: contract?.status ?? 'ready',
    source: 'Source Validation',
    data_available: false,
    payload: null,
    reason: contract?.reason ?? 'Source Validation connector is ready for future live activation.',
  };
}
