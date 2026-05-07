/**
 * ga4-connector.js
 *
 * Phase 15/16 — GA4 Backend Read-Only Data API Contract
 * ABE GTM Platform
 *
 * GA4_MEASUREMENT_ID (G-KBPQTQPSZH) is frontend-only (ga4-tag.js).
 * Backend Data API access uses a Google service account only.
 * GA4_ACCESS_CONFIRMED must be true after verifying the service account
 * has been granted GA4 property access in the GA4 UI.
 *
 * Property ID:  536562958
 * Stream ID:    14827826199
 * Site:         https://abe-gtm-platform.pages.dev
 */

import { canUseLiveIntegration, getIntegrationStatus } from '../integration-readiness.js';

const GA4_FUTURE_CONTRACT = {
  property_id_required: true,
  auth_method: 'service_account',
  api_endpoint: 'https://analyticsdata.googleapis.com/v1beta/properties/{PROPERTY_ID}:runReport',
  required_env: [
    'GA4_ENABLED',
    'GA4_PROPERTY_ID',
    'GOOGLE_ANALYTICS_CLIENT_EMAIL',
    'GOOGLE_ANALYTICS_PRIVATE_KEY',
    'GA4_ACCESS_CONFIRMED',
  ],
  optional_env: ['GA4_MEASUREMENT_ID'],
  metrics: [
    { name: 'activeUsers',            description: 'Users with at least one session in the period' },
    { name: 'sessions',               description: 'Total number of sessions' },
    { name: 'screenPageViews',        description: 'Total page/screen views' },
    { name: 'engagementRate',         description: 'Fraction of engaged sessions' },
    { name: 'averageSessionDuration', description: 'Mean session duration in seconds' },
    { name: 'conversions',            description: 'Key event conversions (if configured in GA4)' },
  ],
  dimensions: [
    { name: 'date',           description: 'YYYYMMDD date of the session' },
    { name: 'pagePath',       description: 'URL path of the page' },
    { name: 'sessionSource',  description: 'Traffic source (e.g. google, direct)' },
    { name: 'sessionMedium',  description: 'Traffic medium (e.g. organic, cpc)' },
    { name: 'country',        description: 'Country of the user' },
    { name: 'deviceCategory', description: 'Device type: desktop, mobile, tablet' },
  ],
  date_range: { default_start: '30daysAgo', default_end: 'today' },
};

export async function fetchGA4Signals(strategy, env = {}) {
  const integrationStatus = getIntegrationStatus(env);
  const contract = integrationStatus?.integration_contracts?.ga4;

  // access_pending: credentials exist but GA4 property access not confirmed.
  if (contract?.status === 'access_pending') {
    return {
      status:          'access_pending',
      source:          'GA4',
      data_available:  false,
      payload:         null,
      reason:          'GA4 credentials are configured, but GA4 property access for the service account is not confirmed.',
      future_contract: GA4_FUTURE_CONTRACT,
    };
  }

  const isReady = canUseLiveIntegration('ga4', env);

  if (!isReady) {
    return {
      status:          contract?.status ?? 'not_connected',
      source:          'GA4',
      data_available:  false,
      payload:         null,
      reason:          contract?.reason ?? 'GA4 Data API not connected. Set GA4_ENABLED=true, provide service account credentials, and set GA4_ACCESS_CONFIRMED=true.',
      future_contract: GA4_FUTURE_CONTRACT,
    };
  }

  // ── LIVE PATH (activate when GA4_ACCESS_CONFIRMED=true + all creds present) ──
  // Implement JWT + OAuth2 token exchange + GA4 Data API runReport call here.
  // No live call is made yet.
  return {
    status:          'not_connected',
    source:          'GA4',
    data_available:  false,
    payload:         null,
    reason:          'GA4 credentials and access confirmed, but live call not yet implemented.',
    future_contract: GA4_FUTURE_CONTRACT,
  };
}
