/**
 * functions/api/_middleware.js
 * Re-exports all utilities from root middleware for all /api/* functions.
 */
export {
  verifyAuth,
  corsHeaders,
  validate,
  kv,
  rateLimit,
  sanitise,
  auditLog,
  okRes,
  errRes,
  sbFetch,
} from '../_middleware.js';
