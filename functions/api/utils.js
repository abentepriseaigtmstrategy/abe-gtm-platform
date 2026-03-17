/**
 * shared/utils.js
 * Common utility functions used across all workers.
 *
 * Usage:
 *   import { sanitise, hashString, slugify, paginationQuery, ... } from '../shared/utils.js';
 */

// ── String utilities ───────────────────────────────────────────────

/**
 * Strip HTML tags, control characters, trim, and truncate.
 */
export function sanitise(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, maxLen);
}

/**
 * Normalise a domain — strip protocol and www prefix.
 */
export function normaliseDomain(domain) {
  if (!domain) return null;
  return domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase()
    .trim();
}

/**
 * URL-safe slug from a string.
 */
export function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Crypto ─────────────────────────────────────────────────────────

/**
 * SHA-256 hash of a string (Web Crypto API — available in Workers).
 * Returns first 16 hex chars for use as a cache key.
 */
export async function hashString(str) {
  const data    = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * Simple non-crypto djb2 hash for content change detection.
 * Synchronous — use for HTML change tracking.
 */
export function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

// ── Date utilities ─────────────────────────────────────────────────

/**
 * ISO timestamp for N days ago.
 */
export function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * ISO timestamp for N hours ago.
 */
export function hoursAgo(n) {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

/**
 * Floor a Date to the start of the current hour (for rate limit windows).
 */
export function currentHourWindow() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// ── Supabase helpers ───────────────────────────────────────────────

/**
 * Generic Supabase REST fetch. Used by all workers.
 */
export function sbFetch(url, key, table, method, body, qs = '') {
  return fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      apikey:          key,
      Authorization:   `Bearer ${key}`,
      Prefer:          method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body || undefined,
  });
}

/**
 * Build a Supabase query string for pagination.
 */
export function paginationQuery(limit = 50, offset = 0, orderBy = 'created_at', direction = 'desc') {
  return `&order=${orderBy}.${direction}&limit=${limit}&offset=${offset}`;
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate a schema definition against a data object.
 * Returns an array of error strings (empty = valid).
 *
 * Schema format: { field: 'type|required' }
 * Supported types: string, number, boolean, array, uuid
 */
export function validate(schema, data) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const val = data?.[field];
    const required = rule.includes('required');
    if (required && (val === undefined || val === null || val === '')) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }
    if (val === undefined || val === null) continue;
    const type = rule.replace('|required', '').trim();
    if (type === 'string'  && typeof val !== 'string')  errors.push(`${field} must be a string`);
    if (type === 'number'  && typeof val !== 'number')  errors.push(`${field} must be a number`);
    if (type === 'boolean' && typeof val !== 'boolean') errors.push(`${field} must be a boolean`);
    if (type === 'array'   && !Array.isArray(val))      errors.push(`${field} must be an array`);
    if (type === 'uuid'    && typeof val === 'string' && !/^[0-9a-f-]{36}$/i.test(val)) {
      errors.push(`${field} must be a valid UUID`);
    }
  }
  return errors;
}

// ── Response helpers ───────────────────────────────────────────────

export const okRes  = (data, headers) =>
  new Response(JSON.stringify(data), { status: 200, headers });

export const errRes = (message, status, headers) =>
  new Response(JSON.stringify({ error: message }), { status, headers });

// ── CSV helpers ────────────────────────────────────────────────────

/**
 * Escape a single CSV cell value.
 */
export function csvCell(val) {
  const s = String(val ?? '').replace(/"/g, '""');
  return /[,"\r\n]/.test(s) ? `"${s}"` : s;
}

/**
 * Convert an array of objects to CSV string.
 */
export function toCSV(rows, headers) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvCell(row[h] ?? '')).join(','));
  }
  return lines.join('\r\n');
}

// ── Misc ───────────────────────────────────────────────────────────

/**
 * Sleep for N milliseconds (for rate-limit backoff, cron pacing).
 */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Clamp a number between min and max.
 */
export const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

/**
 * Extract JSON from a string that may contain markdown or prose.
 */
export function extractJSON(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  return null;
}
