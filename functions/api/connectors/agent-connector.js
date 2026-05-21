import { canUseLiveIntegration, getIntegrationStatus } from '../integration-readiness.js';

export async function runAgentRecommendations(strategy, env = {}) {
  const feature = 'agents';
  const contract = getIntegrationStatus(env).integration_contracts?.[feature];
  const isReady = canUseLiveIntegration(feature, env);

  if (!isReady) {
    return {
      status: contract?.status ?? 'disabled',
      source: 'Agents',
      data_available: false,
      payload: null,
      reason: contract?.reason ?? 'Agents connector is inactive because live integration is not ready.',
    };
  }

  return {
    status: contract?.status ?? 'ready',
    source: 'Agents',
    data_available: false,
    payload: null,
    reason: contract?.reason ?? 'Agents connector is ready for future live activation.',
  };
}
