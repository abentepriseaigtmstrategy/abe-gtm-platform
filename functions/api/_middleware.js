/**
 * functions/api/_middleware.js
 * Re-exports everything from the root middleware so all API imports work.
 */
export { verifyAuth, corsHeaders, validate, kv, rateLimit, sanitise, okRes, errRes, sbFetch } from '../_middleware.js';
