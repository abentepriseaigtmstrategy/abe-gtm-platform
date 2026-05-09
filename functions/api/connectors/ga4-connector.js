/**
 * ga4-connector.js
 *
 * Phase 15/16 — Live GA4 Backend Read-Only Data API Connector
 * ABE GTM Platform
 *
 * Frontend tracking uses GA4_MEASUREMENT_ID / gtag.
 * Backend intelligence uses GA4 Data API via Google service account.
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
    { name: 'activeUsers', description: 'Users with at least one session in the period' },
    { name: 'sessions', description: 'Total number of sessions' },
    { name: 'screenPageViews', description: 'Total page/screen views' },
    { name: 'engagementRate', description: 'Fraction of engaged sessions' },
    { name: 'averageSessionDuration', description: 'Mean session duration in seconds' },
    { name: 'conversions', description: 'Key event conversions if configured in GA4' },
  ],
  dimensions: [
    { name: 'date', description: 'YYYYMMDD date of the session' },
    { name: 'pagePath', description: 'URL path of the page' },
    { name: 'sessionSource', description: 'Traffic source' },
    { name: 'sessionMedium', description: 'Traffic medium' },
    { name: 'country', description: 'Country of the user' },
    { name: 'deviceCategory', description: 'Device type' },
  ],
  date_range: { default_start: '30daysAgo', default_end: 'today' },
};

function toBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function safeBaseResponse(status, reason, contract = null) {
  return {
    status,
    source: 'GA4',
    data_available: false,
    payload: null,
    reason,
    future_contract: GA4_FUTURE_CONTRACT,
    integration_contract: contract,
  };
}

function normalizePrivateKey(privateKey = '') {
  return String(privateKey)
    .replace(/^"|"$/g, '')
    .replace(/\\n/g, '\n')
    .trim();
}

function base64UrlEncode(input) {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const cleaned = normalizePrivateKey(pem)
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  if (!cleaned) {
    throw new Error('GOOGLE_ANALYTICS_PRIVATE_KEY is empty or invalid.');
  }

  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createJwt(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const claims = {
    iss: env.GOOGLE_ANALYTICS_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const unsignedJwt = `${encodedHeader}.${encodedClaims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.GOOGLE_ANALYTICS_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedJwt)
  );

  return `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getAccessToken(env) {
  const jwt = await createJwt(env);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    return {
      ok: false,
      stage: 'oauth_token',
      status: response.status,
      reason: data?.error_description || data?.error || 'Unable to get Google OAuth token.',
    };
  }

  return {
    ok: true,
    accessToken: data.access_token,
  };
}

function metric(row, index) {
  const value = Number(row?.metricValues?.[index]?.value || 0);
  return Number.isFinite(value) ? value : 0;
}

function normalizeSummary(report) {
  const row = report?.rows?.[0] || {};

  return {
    activeUsers: metric(row, 0),
    sessions: metric(row, 1),
    screenPageViews: metric(row, 2),
    engagementRate: metric(row, 3),
    averageSessionDuration: metric(row, 4),
    conversions: metric(row, 5),
  };
}

async function runSummaryReport(env, accessToken, strategy = {}) {
  const propertyId = String(env.GA4_PROPERTY_ID || '').trim();
  const startDate = strategy?.ga4_start_date || strategy?.analytics_start_date || '30daysAgo';
  const endDate = strategy?.ga4_end_date || strategy?.analytics_end_date || 'today';

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'activeUsers' },
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'engagementRate' },
          { name: 'averageSessionDuration' },
          { name: 'conversions' },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      stage: 'ga4_summary_report',
      status: response.status,
      reason: data?.error?.message || 'GA4 Data API request failed.',
      error: data?.error
        ? {
            code: data.error.code,
            status: data.error.status,
            message: data.error.message,
          }
        : null,
    };
  }

  return {
    ok: true,
    date_range: { startDate, endDate },
    summary: normalizeSummary(data),
  };
}

export async function fetchGA4Signals(strategy = {}, env = {}) {
  const integrationStatus = getIntegrationStatus(env);
  const contract = integrationStatus?.integration_contracts?.ga4;

  if (contract?.status === 'access_pending') {
    return safeBaseResponse(
      'access_pending',
      'GA4 credentials are configured, but GA4 property access for the service account is not confirmed.',
      contract
    );
  }

  const missing = [];
  if (!toBool(env.GA4_ENABLED)) missing.push('GA4_ENABLED');
  if (!env.GA4_PROPERTY_ID) missing.push('GA4_PROPERTY_ID');
  if (!env.GOOGLE_ANALYTICS_CLIENT_EMAIL) missing.push('GOOGLE_ANALYTICS_CLIENT_EMAIL');
  if (!env.GOOGLE_ANALYTICS_PRIVATE_KEY) missing.push('GOOGLE_ANALYTICS_PRIVATE_KEY');
  if (!toBool(env.GA4_ACCESS_CONFIRMED)) missing.push('GA4_ACCESS_CONFIRMED');

  if (missing.length > 0) {
    return safeBaseResponse(
      contract?.status || 'not_connected',
      `GA4 Data API not connected. Missing/inactive env values: ${missing.join(', ')}.`,
      contract
    );
  }

  if (!canUseLiveIntegration('ga4', env)) {
    return safeBaseResponse(
      contract?.status || 'not_connected',
      contract?.reason || 'GA4 connector is inactive because live integration is not ready.',
      contract
    );
  }

  try {
    const token = await getAccessToken(env);

    if (!token.ok) {
      return {
        status: 'error',
        source: 'GA4',
        data_available: false,
        payload: null,
        reason: token.reason,
        error_stage: token.stage,
        error_status: token.status,
        future_contract: GA4_FUTURE_CONTRACT,
      };
    }

    const report = await runSummaryReport(env, token.accessToken, strategy);

    if (!report.ok) {
      return {
        status: 'error',
        source: 'GA4',
        data_available: false,
        payload: null,
        reason: report.reason,
        error_stage: report.stage,
        error_status: report.status,
        error_raw: report.error,
        future_contract: GA4_FUTURE_CONTRACT,
      };
    }

    return {
      status: 'ready',
      source: 'GA4',
      data_available: true,
      reason: 'GA4 Data API returned live summary analytics.',
      payload: {
        property_id: String(env.GA4_PROPERTY_ID),
        date_range: report.date_range,
        summary: report.summary,
      },
      future_contract: GA4_FUTURE_CONTRACT,
    };
  } catch (error) {
    return {
      status: 'error',
      source: 'GA4',
      data_available: false,
      payload: null,
      reason: error?.message || 'GA4 connector failed unexpectedly.',
      error_stage: 'unexpected_exception',
      future_contract: GA4_FUTURE_CONTRACT,
    };
  }
}
