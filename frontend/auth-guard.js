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
      // ── FIX: gtm-strategy.html polls window._currentUser for userId resolution ──
      window._currentUser = user;

      // ── ADMIN DETECTION ───────────────────────────────────────────
      // Check user_profiles for is_admin flag
      // Cached in sessionStorage so it doesn't re-query on every page load
      let isAdmin = false;
      try {
        const cached = sessionStorage.getItem('abe_is_admin');
        if (cached !== null) {
          isAdmin = cached === 'true';
        } else {
          const { data: profile } = await sb
            .from('user_profiles')
            .select('is_admin')
            .eq('id', user.id)
            .single();
          isAdmin = !!profile?.is_admin;
          sessionStorage.setItem('abe_is_admin', String(isAdmin));
        }
      } catch (_) {
        isAdmin = false;
      }
      window.APP.isAdmin = isAdmin;

      // ── INJECT ADMIN LINK INTO NAV ────────────────────────────────
      // Runs after page renders — adds Admin tab only for admins
      // Works on ALL pages that use auth-guard.js
      if (isAdmin) {
        const injectAdminNav = () => {
          // Don't inject if we're already on admin.html
          if (window.location.pathname.includes('admin')) return;
          // Don't inject if already injected
          if (document.getElementById('admin-nav-link')) return;

          const navTabs = document.querySelector('.nav-tabs') ||
                          document.querySelector('#topnav .nav-tabs');
          if (!navTabs) return;

          const link = document.createElement('a');
          link.id        = 'admin-nav-link';
          link.href      = 'admin.html';
          link.className = 'nav-tab';
          link.innerHTML = '&#128274; Admin';
          link.style.cssText = [
            'color:#f59e0b',
            'border-bottom:2px solid rgba(245,158,11,0.4)',
            'background:rgba(245,158,11,0.06)',
          ].join(';');
          link.addEventListener('mouseenter', () => {
            link.style.background = 'rgba(245,158,11,0.12)';
            link.style.color      = '#fbbf24';
          });
          link.addEventListener('mouseleave', () => {
            link.style.background = 'rgba(245,158,11,0.06)';
            link.style.color      = '#f59e0b';
          });
          navTabs.appendChild(link);
        };

        // Try immediately, then retry after DOM settles
        injectAdminNav();
        setTimeout(injectAdminNav, 300);
        setTimeout(injectAdminNav, 800);
      }
      // ── END ADMIN NAV INJECTION ───────────────────────────────────

      document.documentElement.style.visibility = '';
    } catch (e) {
      try { await sb.auth.signOut(); } catch (_) {}
      window.location.replace('login.html');
    }
  })();
})();
