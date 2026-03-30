/**
 * frontend/auth-guard.js
 * ─────────────────────────────────────────────────────────────────
 * SECURITY: Zero Supabase keys. Zero direct database access.
 * All auth operations go through /api/* backend endpoints.
 *
 * Token stored in sessionStorage only (cleared on tab close).
 *
 * EXPOSES:
 *   window.APP.login()       — sign in
 *   window.APP.signup()      — sign up
 *   window.APP.logout()      — sign out
 *   window.APP.signOut()     — alias for logout (used by report.html)
 *   window.APP.getSession()  — validate session
 *   window.APP.token()       — returns current JWT (used by vault, gtm-strategy, report, faq-chat)
 *   window.APP.api()         — authenticated fetch helper
 *   window.APP.isAdmin()     — admin check
 *   window.APP.sb            — compatibility shim for pages using old Supabase SDK pattern
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var TOKEN_KEY = 'abe_token';

  /* ── Token storage ───────────────────────────────────────────── */
  function storeToken(t) { if (t) sessionStorage.setItem(TOKEN_KEY, t); }
  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    // Clean up any legacy Supabase keys from old version
    Object.keys(localStorage).forEach(function (k) {
      if (k.startsWith('sb-') || k.includes('supabase')) localStorage.removeItem(k);
    });
  }
  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

  /* ── Route classification ────────────────────────────────────── */
  var _path = window.location.pathname;
  var _isPublic = (
    _path === '/' ||
    _path.startsWith('/login') ||
    _path.startsWith('/auth-callback') ||
    _path === '/index.html' ||
    _path.endsWith('index.html')
  );

  /* ── Core authenticated fetch ────────────────────────────────── */
  async function apiFetch(endpoint, body, method) {
    method = method || (body ? 'POST' : 'GET');
    var opts = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
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

  /* ══════════════════════════════════════════════════════════════
     window.APP — primary interface used by all pages
  ══════════════════════════════════════════════════════════════ */
  window.APP = {

    user:         null,
    profile:      null,
    organization: null,

    /* Authenticated fetch — used by all pages for API calls */
    api: apiFetch,

    /* Returns current JWT token (async for backward compat) */
    token: async function () {
      return getToken();
    },

    /* Sign in via POST /api/login */
    login: async function (email, password) {
      var data = await apiFetch('/api/login', { email: email, password: password });
      if (data.token) storeToken(data.token);
      window.APP.user         = data.user         || null;
      window.APP.profile      = data.profile      || null;
      window.APP.organization = data.organization || null;
      return data;
    },

    /* Sign up via POST /api/signup */
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

    /* Sign out — clears token, redirects to login */
    logout: function () {
      clearToken();
      window.APP.user         = null;
      window.APP.profile      = null;
      window.APP.organization = null;
      window.location.replace('/login');
    },

    /* signOut — alias for logout (used by report.html) */
    signOut: function () {
      return window.APP.logout();
    },

    /* Validate session via GET /api/session */
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

    /* Admin check */
    isAdmin: function () {
      return !!(window.APP.profile && window.APP.profile.is_admin);
    },

    /* Score a lead via POST /api/signal-score */
    scoreSignal: function (leadId, icpCriteria) {
      return apiFetch('/api/signal-score', {
        lead_id:      leadId,
        icp_criteria: icpCriteria || undefined,
      });
    },

    /* ────────────────────────────────────────────────────────────
       window.APP.sb — compatibility shim for pages that still use
       the old Supabase SDK pattern (sb.auth.getSession, sb.from etc.)

       This shim translates old SDK calls into the new secure pattern:
         sb.auth.getSession()  → reads local APP state (no network call)
         sb.auth.signOut()     → calls APP.logout()
         sb.from(table)        → routes DB operations through /api/*
    ─────────────────────────────────────────────────────────────── */
    sb: {

      auth: {
        /* Returns a fake Supabase session object from local APP state.
           Pages use this to check: if (session) { ... }              */
        getSession: async function () {
          var token = getToken();
          var user  = window.APP.user;
          if (!token || !user) {
            return { data: { session: null }, error: null };
          }
          return {
            data: {
              session: {
                access_token:  token,
                user:          user,
              },
            },
            error: null,
          };
        },

        /* Sign out — delegates to APP.logout() */
        signOut: function () {
          return window.APP.logout();
        },
      },

      /* from(table) — chainable builder that routes to /api/* endpoints.
         Supports the patterns used across dashboard, leads, accounts:
           .from('table').upsert(data)
           .from('table').insert(data)
           .from('table').select('*').eq('id', val).single()
           .from('table').update(data).eq('id', val)
           .from('table').delete().eq('id', val)                        */
      from: function (table) {
        return {
          _table:  table,
          _filter: {},
          _select: '*',
          _single: false,

          upsert: function (data, opts) {
            return this._run('upsert', data);
          },

          insert: function (data) {
            return this._run('insert', data);
          },

          update: function (data) {
            this._updateData = data;
            return this; // chainable — caller adds .eq() then result
          },

          select: function (cols) {
            this._select = cols || '*';
            return this;
          },

          eq: function (col, val) {
            this._filter[col] = val;
            // If we have pending update data, execute now
            if (this._updateData) {
              return this._run('update', this._updateData);
            }
            return this;
          },

          single: function () {
            this._single = true;
            return this._run('select', null);
          },

          delete: function () {
            return this._run('delete', null);
          },

          _run: async function (action, data) {
            try {
              var result = await apiFetch('/api/db', {
                table:  this._table,
                action: action,
                data:   data   || undefined,
                filter: Object.keys(this._filter).length ? this._filter : undefined,
                select: this._select || undefined,
                single: this._single || undefined,
              });
              return { data: result, error: null };
            } catch (e) {
              console.warn('[APP.sb] ' + action + ' on ' + this._table + ' failed:', e.message);
              return { data: null, error: { message: e.message } };
            }
          },
        };
      },
    }, // end sb

  }; // end window.APP

  /* ══════════════════════════════════════════════════════════════
     window.authGuard — backward compat for pages that use the
     old authGuard interface directly
  ══════════════════════════════════════════════════════════════ */
  window.authGuard = {
    get currentUser()  { return window.APP.user; },
    get currentOrg()   { return window.APP.organization; },

    initialize: function () {
      return window.APP.getSession().then(function (s) { return !!s; });
    },

    requireAuth: async function () {
      var s = await window.APP.getSession();
      if (!s) { window.location.replace('/login'); return false; }
      return true;
    },

    login:   function (e, p)       { return window.APP.login(e, p); },
    signup:  function (e, p, t, m) { return window.APP.signup(e, p, t, m); },
    logout:  function ()           { return window.APP.logout(); },
    isAdmin: function ()           { return window.APP.isAdmin(); },

    /* Called by auth-callback.html after Google OAuth redirect */
    handleOAuthCallback: async function () {
      var hash  = window.location.hash.substring(1);
      var token = new URLSearchParams(hash).get('access_token');

      if (!token) {
        window.location.replace('/login?error=oauth_failed');
        return;
      }

      storeToken(token);
      var session = await window.APP.getSession();

      if (!session) {
        clearToken();
        window.location.replace('/login?error=session_failed');
        return;
      }

      window.location.replace(
        session.onboardingCompleted ? '/dashboard.html' : '/dashboard.html?onboarding=1'
      );
    },
  };

  /* ── Route guard ─────────────────────────────────────────────── */
  window.APP.getSession().then(function (session) {
    if (!session && !_isPublic) {
      var next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace('/login?next=' + next);
    }
  }).catch(function () {
    if (!_isPublic) window.location.replace('/login');
  });

  console.log('[ABE] auth-guard ready — public page:', _isPublic, '| path:', _path);

})();
