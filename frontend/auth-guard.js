/**
 * auth-guard.js  —  ABE GTM Platform Authentication Module
 *
 * ROOT CAUSE FIXES:
 *   Bug #1: Previous version used `import { createClient } from '...'` ES Module
 *           syntax, but was loaded as a plain <script> tag (no type="module").
 *           This caused a SyntaxError on every page, silently killing the entire
 *           auth layer. Fix: use global window.supabase (loaded via CDN <script>
 *           before this file).
 *
 *   Bug #2: window.APP was referenced everywhere (dashboard, vault, leads, gtm-
 *           strategy, accounts, report) but was NEVER defined anywhere in the
 *           codebase. Every call to window.APP.token(), window.APP.sb,
 *           window.APP.user etc. threw TypeError: Cannot read properties of
 *           undefined. Fix: define and populate window.APP here.
 *
 * CONTRACT — window.APP interface (used across all pages):
 *   window.APP.sb          → Supabase client instance
 *   window.APP.user        → current user object (null if not authed)
 *   window.APP.token()     → async () => string  (JWT access token)
 *   window.APP.signOut()   → async () => void    (signs out + redirects)
 *   window.APP.api(endpoint, body, method?) → async fetch helper with auth header
 *
 * LOADING: This file MUST be loaded AFTER the Supabase CDN script:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="auth-guard.js"></script>
 *   (NO type="module" — this is intentional)
 */

(function () {
  'use strict';

  /* ─── Supabase configuration ────────────────────────────────────────────── */
  var SUPABASE_URL      = 'https://cwcvneluhlimhlzowabv.supabase.co';
  // JWT-format anon key — consistent with index.html and backend _middleware.js
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3Y3ZuZWx1aGxpbWhsem93YWJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzAxMjAsImV4cCI6MjA4OTIwNjEyMH0.SZDS-svU-kFh_OkUq3AjQY64F-71MpbBsFd6Iin5DlQ';

  /* ─── Guard: Supabase CDN must be loaded first ──────────────────────────── */
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[auth-guard] FATAL: window.supabase is not available. '
      + 'Ensure supabase-js CDN script is loaded before auth-guard.js.');
    return;
  }

  /* ─── Create Supabase client ────────────────────────────────────────────── */
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* ─── Detect page type ──────────────────────────────────────────────────── */
  var _path = window.location.pathname;
  var _isPublicPage = (
    _path.includes('login.html')         ||
    _path.includes('auth-callback.html') ||
    _path === '/'                        ||
    _path === '/index.html'              ||
    _path.endsWith('index.html')
  );

  /* ─── Define window.APP immediately (synchronous) ──────────────────────── */
  // All pages access window.APP.sb synchronously for signOut etc., so this
  // must be set before any DOMContentLoaded or inline script runs.
  window.APP = {

    sb: sb,

    /** Current user object — null until session resolves */
    user: null,

    /**
     * Returns the JWT access token for the current session.
     * Used as: Authorization: Bearer <token> on all API calls.
     */
    token: async function () {
      try {
        var result = await sb.auth.getSession();
        return (result.data && result.data.session)
          ? result.data.session.access_token
          : '';
      } catch (e) {
        console.error('[auth-guard] token() error:', e);
        return '';
      }
    },

    /**
     * Authenticated fetch helper.
     * Usage: const data = await window.APP.api('/api/gtm', { action: 'get_vault' })
     */
    api: async function (endpoint, body, method) {
      method = method || 'POST';
      var token = await this.token();
      var opts = {
        method: method,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + token,
        },
      };
      if (body && method !== 'GET') {
        opts.body = JSON.stringify(body);
      }
      var res = await fetch(endpoint, opts);
      if (!res.ok) {
        var e = {};
        try { e = await res.json(); } catch (_) {}
        throw new Error(e.error || ('HTTP ' + res.status));
      }
      return res.json();
    },

    /**
     * Sign out the current user and redirect to login.
     */
    signOut: async function () {
      try {
        await sb.auth.signOut({ scope: 'local' });
      } catch (_) {}
      // Purge all Supabase tokens from localStorage
      Object.keys(localStorage).forEach(function (k) {
        if (k.startsWith('sb-') || k.includes('supabase')) {
          localStorage.removeItem(k);
        }
      });
      window.location.replace('/login.html');
    },
  };

  /* ─── Session check & route protection ─────────────────────────────────── */
  sb.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;

    if (session) {
      window.APP.user        = session.user;
      window._currentUser    = session.user;  // legacy compat for gtm-strategy.html
    } else {
      window.APP.user        = null;
      window._currentUser    = null;
      if (!_isPublicPage) {
        // Not authenticated — redirect to login preserving current URL as ?next=
        var next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace('/login.html?next=' + next);
      }
    }
  }).catch(function (err) {
    console.error('[auth-guard] getSession error:', err);
    if (!_isPublicPage) {
      window.location.replace('/login.html');
    }
  });

  /* ─── Auth state change listener ───────────────────────────────────────── */
  // Keeps window.APP.user in sync across token refreshes and sign-outs.
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      window.APP.user     = session ? session.user : null;
      window._currentUser = window.APP.user;
    } else if (event === 'SIGNED_OUT') {
      window.APP.user     = null;
      window._currentUser = null;
      if (!_isPublicPage) {
        window.location.replace('/login.html');
      }
    }
  });

  /* ─── window.authGuard — backward-compat object ────────────────────────── */
  // Some legacy call sites use window.authGuard directly.
  window.authGuard = {

    get supabase()     { return sb; },
    get currentUser()  { return window.APP.user; },
    get currentOrg()   { return null; }, // org is loaded per-page as needed

    initialize: async function () {
      var result  = await sb.auth.getSession();
      var session = result.data && result.data.session;
      if (session) {
        window.APP.user = session.user;
        return true;
      }
      return false;
    },

    requireAuth: async function () {
      var result  = await sb.auth.getSession();
      var session = result.data && result.data.session;
      if (!session) {
        window.location.replace('/login.html');
        return false;
      }
      window.APP.user = session.user;
      return true;
    },

    login: async function (email, password) {
      var result = await sb.auth.signInWithPassword({ email: email, password: password });
      if (result.error) throw result.error;
      window.APP.user = result.data.user;
      return result.data;
    },

    signup: async function (email, password, termsAccepted, marketingConsent) {
      var result = await sb.auth.signUp({
        email: email,
        password: password,
        options: {
          data: {
            terms_accepted:     termsAccepted    || false,
            marketing_consent:  marketingConsent || false,
          },
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },

    signInWithGoogle: async function () {
      var result = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/auth-callback.html',
          queryParams: { access_type: 'offline', prompt: 'consent' },
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },

    sendMagicLink: async function (email) {
      var result = await sb.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + '/dashboard.html' },
      });
      if (result.error) throw result.error;
      return result.data;
    },

    logout: async function () {
      return window.APP.signOut();
    },

    isAdmin: function () {
      var adminEmails = ['amitbhawik@gmail.com', 'amitbhawik@hotmail.com'];
      var email = window.APP.user && window.APP.user.email
        ? window.APP.user.email.toLowerCase()
        : '';
      return adminEmails.indexOf(email) !== -1 ||
             !!(window.APP.user && window.APP.user.profile && window.APP.user.profile.is_admin);
    },

    getDeviceFingerprint: function () {
      var raw = JSON.stringify({
        ua:   navigator.userAgent,
        lang: navigator.language,
        tz:   Intl.DateTimeFormat().resolvedOptions().timeZone,
        res:  screen.width + 'x' + screen.height,
        cd:   screen.colorDepth,
      });
      var h = 0;
      for (var i = 0; i < raw.length; i++) {
        h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
      }
      return 'fp_' + Math.abs(h).toString(36);
    },

    handleOAuthCallback: async function () {
      var result = await sb.auth.getSession();
      if (result.error || !result.data.session) {
        window.location.replace('/login.html');
        return;
      }
      var session = result.data.session;
      window.APP.user = session.user;

      var profileResult = await sb
        .from('user_profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

      var profile = profileResult.data;

      if (!profile) {
        // New OAuth user — create profile inline
        await this._createUserProfile(session.user, {
          termsAccepted:     true,
          marketingConsent:  false,
          deviceId:          this.getDeviceFingerprint(),
        });
        this._showOnboardingModal();
      } else if (!profile.onboarding_completed) {
        this._showOnboardingModal();
      } else {
        window.location.replace('/dashboard.html');
      }
    },

    _showOnboardingModal: function () {
      var modal = document.getElementById('onboarding-modal');
      if (modal) modal.classList.add('active');
    },

    _createUserProfile: async function (user, options) {
      var orgResult = await sb
        .from('organizations')
        .insert({
          name:       user.email + "'s Organization",
          plan_tier:  'free_trial',
          owner_id:   user.id,
        })
        .select()
        .single();

      if (orgResult.error) throw orgResult.error;

      var profileResult = await sb
        .from('user_profiles')
        .insert({
          id:                  user.id,
          email:               user.email,
          organization_id:     orgResult.data.id,
          plan:                'free_trial',
          tc_accepted:         options.termsAccepted    || false,
          marketing_consent:   options.marketingConsent || false,
          device_id:           options.deviceId         || '',
          onboarding_completed: false,
          created_at:          new Date().toISOString(),
        })
        .select()
        .single();

      if (profileResult.error) throw profileResult.error;

      await sb
        .from('organization_members')
        .insert({
          organization_id: orgResult.data.id,
          user_id:         user.id,
          role:            'owner',
        });

      return profileResult.data;
    },
  };

  console.log('[auth-guard] Initialized. Public page:', _isPublicPage);

})();
