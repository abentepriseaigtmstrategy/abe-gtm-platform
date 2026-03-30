/**
 * frontend/auth-guard.js
 * ─────────────────────────────────────────────────────────────────
 * SECURITY: Zero Supabase keys. Zero direct database access.
 * All auth operations go through /api/* backend endpoints.
 *
 * Token is stored in sessionStorage only (cleared when browser tab closes).
 * The browser never sees your Supabase keys.
 *
 * EXPOSES: window.APP = { login, signup, logout, getSession, api, isAdmin }
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var TOKEN_KEY = 'abe_token';

  /* ── Token storage (sessionStorage only — not localStorage) ──── */
  function storeToken(t)  { if (t) sessionStorage.setItem(TOKEN_KEY, t); }
  function clearToken()   {
    sessionStorage.removeItem(TOKEN_KEY);
    // Clean up any old Supabase keys left from the previous version
    Object.keys(localStorage).forEach(function (k) {
      if (k.startsWith('sb-') || k.includes('supabase')) localStorage.removeItem(k);
    });
  }
  function getToken()     { return sessionStorage.getItem(TOKEN_KEY) || ''; }

  /* ── Route classification ────────────────────────────────────── */
  var _path = window.location.pathname;
  var _isPublic = (
    _path.includes('login.html')         ||
    _path.includes('auth-callback.html') ||
    _path === '/'                        ||
    _path === '/index.html'              ||
    _path.endsWith('index.html')
  );

  /* ── Core API fetch ──────────────────────────────────────────── */
  async function apiFetch(endpoint, body, method) {
    method = method || (body ? 'POST' : 'GET');
    var opts = {
      method:  method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + getToken(),
      },
    };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    var res  = await fetch(endpoint, opts);
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  /* ── window.APP ──────────────────────────────────────────────── */
  window.APP = {

    user:         null,
    profile:      null,
    organization: null,

    /** Authenticated fetch helper — used by all pages */
    api: apiFetch,

    /** Sign in — calls POST /api/login */
    login: async function (email, password) {
      var data = await apiFetch('/api/login', { email: email, password: password });
      if (data.token) storeToken(data.token);
      window.APP.user         = data.user         || null;
      window.APP.profile      = data.profile      || null;
      window.APP.organization = data.organization || null;
      return data;
    },

    /** Sign up — calls POST /api/signup */
    signup: async function (email, password, termsAccepted, marketingConsent) {
      var data = await apiFetch('/api/signup', {
        email:             email,
        password:          password,
        terms_accepted:    !!termsAccepted,
        marketing_consent: !!marketingConsent,
      });
      if (data.token) storeToken(data.token);
      window.APP.user         = data.user         || null;
      window.APP.profile      = data.profile      || null;
      window.APP.organization = data.organization || null;
      return data;
    },

    /** Sign out — clears token and redirects to login */
    logout: function () {
      clearToken();
      window.APP.user         = null;
      window.APP.profile      = null;
      window.APP.organization = null;
      window.location.replace('/login.html');
    },

    /** Validate current session — calls GET /api/session */
    getSession: async function () {
      if (!getToken()) return null;
      try {
        var data = await apiFetch('/api/session', null, 'GET');
        window.APP.user         = data.user         || null;
        window.APP.profile      = data.profile      || null;
        window.APP.organization = data.organization || null;
        return data;
      } catch (_) {
        clearToken();
        return null;
      }
    },

    /** Returns true if current user has admin privileges */
    isAdmin: function () {
      return !!(window.APP.profile && window.APP.profile.is_admin);
    },

    /** Score a lead — calls POST /api/signal-score */
    scoreSignal: function (leadId, icpCriteria) {
      return apiFetch('/api/signal-score', {
        lead_id:      leadId,
        icp_criteria: icpCriteria || undefined,
      });
    },
  };

  /* ── Backward-compat shim — old pages use window.authGuard ──── */
  window.authGuard = {
    get currentUser()  { return window.APP.user; },
    get currentOrg()   { return window.APP.organization; },

    initialize:  function ()            { return window.APP.getSession().then(function(s){ return !!s; }); },
    requireAuth: async function ()      {
      var s = await window.APP.getSession();
      if (!s) { window.location.replace('/login.html'); return false; }
      return true;
    },
    login:       function (e, p)        { return window.APP.login(e, p); },
    signup:      function (e, p, t, m)  { return window.APP.signup(e, p, t, m); },
    logout:      function ()            { return window.APP.logout(); },
    isAdmin:     function ()            { return window.APP.isAdmin(); },

    handleOAuthCallback: async function () {
      var hash  = window.location.hash.substring(1);
      var token = new URLSearchParams(hash).get('access_token');
      if (!token) { window.location.replace('/login.html?error=oauth_failed'); return; }
      storeToken(token);
      var session = await window.APP.getSession();
      if (!session) { clearToken(); window.location.replace('/login.html?error=session_failed'); return; }
      window.location.replace(session.onboardingCompleted ? '/dashboard.html' : '/dashboard.html?onboarding=1');
    },
  };

  /* ── Route guard — runs on every page load ───────────────────── */
  window.APP.getSession().then(function (session) {
    if (!session && !_isPublic) {
      var next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace('/login.html?next=' + next);
    }
  }).catch(function () {
    if (!_isPublic) window.location.replace('/login.html');
  });

  console.log('[ABE] auth-guard ready — public page:', _isPublic);

})();
