/**
 * functions/api/_middleware.js
 * Re-exports everything from the root middleware for all /api/* functions.
 */
export {
  verifyAuth,
  corsHeaders,
  validate,
  sanitise,
  auditLog,
  kv,
  rateLimit,
  okRes,
  errRes,
  sbFetch,
} from '../_middleware.js';
