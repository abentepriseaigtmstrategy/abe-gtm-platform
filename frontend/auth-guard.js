/**
 * auth-guard.js  — ABE GTM Platform
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in replacement. Keeps all existing behaviour AND adds:
 *   • user_profiles load  (org context, plan tier, onboarding check)
 *   • window.APP.org      — current organisation object
 *   • window.APP.plan     — 'free_trial' | 'starter' | 'professional' | 'team' | 'enterprise'
 *   • window.APP.orgId    — organisation UUID shortcut
 *   • window.APP.deviceId — device fingerprint for trial tracking
 *   • Onboarding modal trigger if onboarding_completed = false
 *
 * SUPABASE PROJECT: cwcvneluhlimhlzowabv
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  const SUPABASE_URL      = 'https://cwcvneluhlimhlzowabv.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_EeDAvGbX7TpO_hgBoUZMhQ_B_nJtAbb';
  const ADMIN_EMAILS      = ['amitbhawik@gmail.com', 'amitbhawik@hotmail.com'];
const WORKER_URL      = 'https://abe-gtm-auth-worker.amitbhavikmnm.workers.dev';
  // Hide page until auth confirmed — prevents flash of content
  document.documentElement.style.visibility = 'hidden';

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ── Device fingerprint (for trial tracking) ───────────────────────
  function getDeviceFingerprint() {
    const raw = JSON.stringify({
      ua:  navigator.userAgent,
      lang: navigator.language,
      tz:  Intl.DateTimeFormat().resolvedOptions().timeZone,
      res: `${screen.width}x${screen.height}`,
      cd:  screen.colorDepth,
    });
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = Math.imul(31, h) + raw.charCodeAt(i) | 0;
    }
    return 'fp_' + Math.abs(h).toString(36);
  }

  // ── Global APP object (fully backwards-compatible) ────────────────
  window.APP = {
    sb,
    user:     null,
    session:  null,
    org:      null,           // NEW: full org object
    plan:     null,           // NEW: plan tier string
    orgId:    null,           // NEW: org UUID
    isAdmin:  false,
    deviceId: getDeviceFingerprint(),  // NEW: device fingerprint

    // Returns the current JWT — always fresh
    token: async function () {
      const { data: { session } } = await sb.auth.getSession();
      return session?.access_token || '';
    },

    // Standard API call — all existing pages use this unchanged
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

  // ── Admin nav injection ───────────────────────────────────────────
  function injectAdminNav() {
    if (window.location.pathname.includes('admin')) return;
    if (document.getElementById('admin-nav-link')) return;
    const navTabs = document.querySelector('.nav-tabs') ||
                    document.querySelector('#topnav .nav-tabs');
    if (!navTabs) return;
    const link = document.createElement('a');
    link.id        = 'admin-nav-link';
    link.href      = 'admin.html';
    link.className = 'nav-tab';
    link.innerHTML = '&#128274; Admin';
    link.style.cssText = 'color:#f59e0b;border-bottom:2px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.06);';
    link.addEventListener('mouseenter', () => { link.style.background='rgba(245,158,11,0.12)'; link.style.color='#fbbf24'; });
    link.addEventListener('mouseleave', () => { link.style.background='rgba(245,158,11,0.06)'; link.style.color='#f59e0b'; });
    navTabs.appendChild(link);
  }

  // ── Load user_profile + org (silent — never blocks page load) ─────
  async function loadProfile(userId) {
    try {
      const { data: profile } = await sb
        .from('user_profiles')
        .select('*, organizations(id, name, plan_tier)')
        .eq('id', userId)
        .maybeSingle();

      if (!profile) return null;
      window.APP.org   = profile.organizations  || null;
      window.APP.plan  = profile.organizations?.plan_tier || 'free_trial';
      window.APP.orgId = profile.organization_id || null;
      return profile;
    } catch (_) { return null; }
  }

  // ── Main auth flow ────────────────────────────────────────────────
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

      window.APP.user     = user;
      window.APP.session  = session;
      window._currentUser = user;   // backwards compat
      window.APP.isAdmin  = ADMIN_EMAILS.includes(user.email?.toLowerCase());

      // Load profile + org context
      const profile = await loadProfile(user.id);

      // Trigger onboarding modal if needed (page must have #onboarding-modal)
      if (profile && !profile.onboarding_completed && !window.APP.isAdmin) {
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.classList.add('active');
      }

      // Reveal page
      document.documentElement.style.visibility = '';

      // Admin nav (with retries for pages that render nav asynchronously)
      if (window.APP.isAdmin) {
        injectAdminNav();
        setTimeout(injectAdminNav, 300);
        setTimeout(injectAdminNav, 800);
      }

    } catch (e) {
      try { await sb.auth.signOut(); } catch (_) {}
      window.location.replace('login.html');
    }
  })();
})();
