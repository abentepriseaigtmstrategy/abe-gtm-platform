/**
 * auth-guard.js
 * Import this script on every protected page BEFORE any other scripts.
 *
 * What it does:
 *   1. Creates ONE Supabase client and exposes it as window.APP
 *   2. Verifies the user is logged in — redirects to login.html if not
 *   3. Exposes window.APP.user, window.APP.session, window.APP.token()
 *   4. All API calls use window.APP.token() for the Authorization header
 */
(function () {
  const SUPABASE_URL      = 'https://cwcvneluhlimhlzowabv.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_EeDAvGbX7TpO_hgBoUZMhQ_B_nJtAbb';

  // Hide page until auth is confirmed — prevents flash of content
  document.documentElement.style.visibility = 'hidden';

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Expose global APP object
  window.APP = {
    sb,
    user:    null,
    session: null,
    // Returns the current JWT access token — always fresh
    token: async function () {
      const { data: { session } } = await sb.auth.getSession();
      return session?.access_token || '';
    },
    // Standard API call helper — all pages use this
    api: async function (endpoint, body) {
      const token = await window.APP.token();
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    // Sign out from any page
    signOut: async function () {
      try { await sb.auth.signOut({ scope: 'local' }); } catch (_) {}
      window.location.replace('login.html');
    },
  };

  (async () => {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { window.location.replace('login.html'); return; }

      const { data: { user }, error } = await sb.auth.getUser();
      if (error || !user) {
        await sb.auth.signOut();
        window.location.replace('login.html');
        return;
      }

      window.APP.user    = user;
      window.APP.session = session;
      document.documentElement.style.visibility = '';
    } catch (e) {
      try { await sb.auth.signOut(); } catch (_) {}
      window.location.replace('login.html');
    }
  })();
})();
