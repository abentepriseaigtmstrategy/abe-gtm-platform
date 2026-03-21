<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Intelligence · ABE AI Revenue Infrastructure</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

  <style>
    :root {
      --bg:#0B0F1A; --bg-alt:#0D1120; --card:#121827; --border:#1F2937;
      --accent:#a855f7; --accent2:#7c3aed; --green:#22c55e; --amber:#f59e0b;
      --red:#ef4444; --blue:#3b82f6; --text:#E5E7EB; --muted:#6B7280; --white:#fff;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
      background-image:linear-gradient(rgba(168,85,247,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,.02) 1px,transparent 1px);
      background-size:48px 48px}

    /* NAV */
    #topnav{position:sticky;top:0;z-index:100;background:rgba(11,15,26,.95);
      backdrop-filter:blur(24px);border-bottom:1px solid rgba(31,41,55,.6);
      padding:0 32px;display:flex;align-items:center;justify-content:space-between;height:58px}
    .nav-brand{display:flex;align-items:center;gap:12px;text-decoration:none}
    .nav-mark{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),var(--accent2));
      border-radius:8px;display:flex;align-items:center;justify-content:center;
      font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:white}
    .nbname{font-size:11px;font-weight:800;color:white}
    .nbsub{font-size:8px;color:var(--muted);letter-spacing:.14em;text-transform:uppercase}
    .nav-tabs{display:flex;align-items:center;gap:4px;background:rgba(255,255,255,.03);
      border:1px solid var(--border);border-radius:10px;padding:4px}
    .nav-tab{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
      color:var(--muted);padding:6px 14px;border-radius:7px;cursor:pointer;text-decoration:none;
      transition:all .15s;border:none;background:none}
    .nav-tab:hover{color:white;background:rgba(255,255,255,.04)}
    .nav-tab.active{color:white;background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.25)}

    /* LAYOUT */
    .wrap{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:36px 32px}
    .ph{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:28px}
    .ptitle{font-size:26px;font-weight:900;color:white;letter-spacing:-.6px}
    .psub{font-size:10px;text-transform:uppercase;letter-spacing:.25em;color:var(--accent);font-weight:700;margin-bottom:5px}

    /* STATS */
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
    .sc{background:rgba(18,24,39,.7);border:1px solid var(--border);border-radius:14px;padding:20px 22px}
    .sv{font-size:26px;font-weight:900;font-family:'Space Mono',monospace;color:white;letter-spacing:-1px}
    .sl{font-size:9px;text-transform:uppercase;letter-spacing:.18em;color:var(--muted);font-weight:700;margin-top:4px}

    /* TOOLBAR */
    .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:18px}
    .si{flex:1;background:rgba(18,24,39,.8);border:1px solid var(--border);color:var(--text);
      font-size:11px;padding:9px 12px 9px 34px;border-radius:10px;outline:none;font-family:'Inter',sans-serif}
    .si:focus{border-color:var(--accent)}
    .si::placeholder{color:var(--muted)}
    .sw{position:relative;flex:1}
    .si-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:13px;pointer-events:none}
    .fs{background:rgba(18,24,39,.8);border:1px solid var(--border);color:var(--text);
      font-size:10px;font-weight:700;padding:9px 13px;border-radius:10px;outline:none;
      cursor:pointer;text-transform:uppercase;letter-spacing:.08em}
    .fs:focus{border-color:var(--accent)}
    .fs option{background:#121827}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;font-size:10px;
      font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-radius:8px;
      cursor:pointer;border:none;transition:all .15s}
    .btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:white}
    .btn-outline{background:transparent;color:var(--muted);border:1px solid var(--border)}
    .btn-outline:hover{border-color:var(--accent);color:white}
    .btn-sm{padding:6px 12px;font-size:9px}

    /* ACCOUNTS GRID */
    .ag{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
    @media(max-width:1100px){.ag{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:700px){.ag{grid-template-columns:1fr}}

    .ac{background:rgba(18,24,39,.7);border:1px solid var(--border);border-radius:14px;
      padding:20px 22px;cursor:pointer;transition:all .2s;position:relative}
    .ac:hover{border-color:rgba(168,85,247,.4);background:rgba(168,85,247,.04);transform:translateY(-2px)}
    .ac.hot{border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.03)}
    .ac.warm{border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.03)}

    .ac-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
    .ac-name{font-size:14px;font-weight:800;color:white;letter-spacing:-.2px}
    .ac-domain{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-top:2px}
    .intent-ring{text-align:right;flex-shrink:0}
    .intent-num{font-size:22px;font-weight:900;font-family:'Space Mono',monospace}
    .intent-lbl{font-size:8px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}

    .tier-badge{display:inline-block;font-size:8px;font-weight:900;text-transform:uppercase;
      letter-spacing:.12em;padding:3px 9px;border-radius:4px;margin-bottom:10px}
    .tier-HOT{background:rgba(239,68,68,.12);color:var(--red);border:1px solid rgba(239,68,68,.25)}
    .tier-WARM{background:rgba(245,158,11,.12);color:var(--amber);border:1px solid rgba(245,158,11,.25)}
    .tier-COLD{background:rgba(107,114,128,.1);color:var(--muted);border:1px solid rgba(107,114,128,.2)}

    .sig-pills{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
    .sig-pill{font-size:8px;font-weight:700;padding:2px 7px;border-radius:4px;
      background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.18);color:#c4b5fd}
    .sig-pill.hiring{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.2);color:#86efac}
    .sig-pill.product{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.2);color:#93c5fd}
    .sig-pill.website{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.2);color:#fcd34d}

    .tech-chips{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:10px}
    .tech-chip{font-size:8px;font-weight:600;padding:2px 6px;border-radius:4px;
      background:rgba(31,41,55,.6);border:1px solid var(--border);color:#9ca3af}

    .ac-footer{display:flex;align-items:center;justify-content:space-between;
      padding-top:12px;border-top:1px solid rgba(31,41,55,.5)}
    .ac-meta{font-size:9px;color:var(--muted);font-family:'Space Mono',monospace}
    .ac-actions{display:flex;gap:5px;opacity:0;transition:opacity .15s}
    .ac:hover .ac-actions{opacity:1}

    /* DRAWER */
    #drawer{position:fixed;right:-720px;top:0;bottom:0;width:720px;background:#0D1120;
      border-left:1px solid var(--border);z-index:200;overflow-y:auto;
      transition:right .3s cubic-bezier(.34,1.56,.64,1)}
    #drawer.open{right:0}
    .doverlay{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);
      z-index:199;display:none}
    .doverlay.show{display:block}
    .dhead{padding:28px 32px 20px;border-bottom:1px solid var(--border)}
    .dco{font-size:22px;font-weight:900;color:white;letter-spacing:-.5px;margin-bottom:4px}
    .dmeta{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.15em}
    .dclose{position:absolute;top:18px;right:20px;background:none;border:none;
      color:var(--muted);font-size:20px;cursor:pointer}
    .dclose:hover{color:white}
    .dbody{padding:24px 32px}

    .dsec{margin-bottom:24px}
    .dstitle{font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.22em;
      color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:8px}
    .dstitle::before{content:'';width:3px;height:14px;background:linear-gradient(var(--accent),var(--accent2));border-radius:2px}

    .score-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
    .score-box{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:10px;
      padding:14px;text-align:center}
    .score-val{font-size:24px;font-weight:900;font-family:'Space Mono',monospace;color:white}
    .score-lab{font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:3px}

    .sig-row{display:flex;align-items:center;gap:10px;padding:8px 12px;
      background:rgba(0,0,0,.25);border-radius:8px;margin-bottom:6px}
    .sig-icon{font-size:14px;flex-shrink:0}
    .sig-type{font-size:10px;font-weight:700;color:white;text-transform:capitalize}
    .sig-score{font-size:10px;font-weight:800;color:var(--accent);margin-left:auto;font-family:'Space Mono',monospace}
    .sig-age{font-size:9px;color:var(--muted);font-family:'Space Mono',monospace}

    .rec-row{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;
      background:rgba(0,0,0,.2);border-radius:8px;margin-bottom:6px;border-left:3px solid var(--accent)}
    .rec-priority{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;
      padding:2px 7px;border-radius:4px;flex-shrink:0}
    .rec-HIGH{background:rgba(239,68,68,.12);color:var(--red)}
    .rec-MEDIUM{background:rgba(245,158,11,.12);color:var(--amber)}
    .rec-LOW{background:rgba(107,114,128,.1);color:var(--muted)}
    .rec-text{font-size:11px;color:#d1d5db;line-height:1.5}

    .timeline-item{display:flex;align-items:flex-start;gap:10px;padding:7px 0;
      border-bottom:1px solid rgba(31,41,55,.3)}
    .tl-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);margin-top:3px;flex-shrink:0}
    .tl-dot.outreach{background:var(--blue)}
    .tl-label{font-size:10px;color:var(--text);text-transform:capitalize}
    .tl-date{font-size:9px;color:var(--muted);font-family:'Space Mono',monospace;margin-left:auto;white-space:nowrap}

    /* EMPTY / LOADING */
    .es{text-align:center;padding:60px 40px}
    .es-icon{font-size:40px;margin-bottom:16px}
    .es-title{font-size:16px;font-weight:800;color:white;margin-bottom:8px}
    .es-sub{font-size:12px;color:var(--muted);margin-bottom:20px}
    .skeleton{background:rgba(18,24,39,.7);border:1px solid var(--border);border-radius:14px;
      padding:20px;animation:pulse 1.5s ease-in-out infinite}
    .sk-line{height:10px;background:rgba(255,255,255,.06);border-radius:5px;margin-bottom:8px}
    @keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}

    #toast{position:fixed;bottom:24px;right:24px;background:rgba(18,24,39,.95);
      border:1px solid var(--border);border-radius:12px;padding:12px 18px;
      font-size:11px;font-weight:700;color:white;z-index:300;opacity:0;
      transform:translateY(8px);transition:all .25s;pointer-events:none}
    #toast.show{opacity:1;transform:none}
    #toast.success{border-color:rgba(34,197,94,.4);color:var(--green)}
    #toast.error{border-color:rgba(239,68,68,.4);color:var(--red)}
  </style>
</head>
<body>

<!-- AUTH GUARD -->
<script src="auth-guard.js"></script>
  <script src="tour.js"></script>

<nav id="topnav">
  <a href="index.html" class="nav-brand">
    <div class="nav-mark">ABE</div>
    <div><div class="nbname">ABE</div><div class="nbsub">Enterprise AI Revenue Infrastructure</div></div>
  </a>
  <div class="nav-tabs">
    <a href="dashboard.html"    class="nav-tab">Command Centre</a>
    <a href="gtm-strategy.html" class="nav-tab">GTM Strategy</a>
    <a href="vault.html"        class="nav-tab">Strategy Vault</a>
    <button class="nav-tab active">Account Intelligence</button>
    <a href="leads.html"        class="nav-tab">Lead Manager</a>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <button class="btn btn-outline btn-sm" onclick="runSignalScan()">⚡ Scan Signals</button>
    <button class="btn btn-outline btn-sm" onclick="handleSignOut()">Sign Out</button>
  </div>
</nav>

<div class="wrap">
  <div class="ph">
    <div style="display:flex;align-items:center;gap:12px">
      <button onclick="history.back()" style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#6b7280;border-radius:8px;padding:6px 12px;font-size:10px;cursor:pointer;font-weight:700">← Back</button>
      <div>
        <div class="psub">Intelligence Layer</div>
        <div class="ptitle">Account Intelligence</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-outline" onclick="runLearningCycle()">🧠 Run Learning Cycle</button>
      <button class="btn btn-primary" onclick="openAddCompany()">+ Add Company</button>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="sc"><div class="sv" id="stat-hot">—</div><div class="sl">Hot Accounts</div></div>
    <div class="sc"><div class="sv" id="stat-signals" style="color:var(--accent)">—</div><div class="sl">Signals (7 days)</div></div>
    <div class="sc"><div class="sv" id="stat-reply" style="color:var(--green)">—</div><div class="sl">Reply Rate</div></div>
    <div class="sc"><div class="sv" id="stat-meetings" style="color:var(--amber)">—</div><div class="sl">Meetings Booked</div></div>
  </div>

  <!-- Toolbar -->
  <div class="toolbar">
    <div class="sw">
      <span class="si-icon">🔍</span>
      <input type="text" class="si" id="search" placeholder="Search accounts..." oninput="debounceSearch()" />
    </div>
    <select class="fs" id="tier-filter" onchange="applyFilters()">
      <option value="">All Tiers</option>
      <option value="HOT">🔥 Hot</option>
      <option value="WARM">🌡 Warm</option>
      <option value="COLD">❄ Cold</option>
    </select>
    <select class="fs" id="sort-filter" onchange="applyFilters()">
      <option value="score">Sort: Intent Score</option>
      <option value="signals">Sort: Signal Count</option>
      <option value="name">Sort: Name</option>
    </select>
    <button class="btn btn-outline btn-sm" onclick="refreshAccounts()">↺</button>
  </div>

  <!-- Accounts Grid -->
  <div id="accounts-container">
    <!-- FIX Bug 6: Template literals ${} don't work in .html files — replaced with static HTML -->
    <div class="ag" id="skeleton-grid">
      <div class="skeleton"><div class="sk-line" style="width:55%"></div><div class="sk-line" style="width:35%;margin-bottom:14px"></div><div class="sk-line"></div><div class="sk-line" style="width:75%"></div><div class="sk-line" style="width:50%"></div></div>
      <div class="skeleton"><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:40%;margin-bottom:14px"></div><div class="sk-line"></div><div class="sk-line" style="width:80%"></div><div class="sk-line" style="width:45%"></div></div>
      <div class="skeleton"><div class="sk-line" style="width:50%"></div><div class="sk-line" style="width:30%;margin-bottom:14px"></div><div class="sk-line"></div><div class="sk-line" style="width:70%"></div><div class="sk-line" style="width:55%"></div></div>
      <div class="skeleton"><div class="sk-line" style="width:65%"></div><div class="sk-line" style="width:35%;margin-bottom:14px"></div><div class="sk-line"></div><div class="sk-line" style="width:75%"></div><div class="sk-line" style="width:50%"></div></div>
      <div class="skeleton"><div class="sk-line" style="width:55%"></div><div class="sk-line" style="width:45%;margin-bottom:14px"></div><div class="sk-line"></div><div class="sk-line" style="width:65%"></div><div class="sk-line" style="width:40%"></div></div>
      <div class="skeleton"><div class="sk-line" style="width:58%"></div><div class="sk-line" style="width:38%;margin-bottom:14px"></div><div class="sk-line"></div><div class="sk-line" style="width:72%"></div><div class="sk-line" style="width:48%"></div></div>
    </div>
    <div class="ag" id="accounts-grid" style="display:none;"></div>
    <div id="empty-state" class="es" style="display:none;">
      <div class="es-icon" id="es-icon">🧠</div>
      <div class="es-title" id="es-title">No accounts in intelligence graph</div>
      <div class="es-sub" id="es-sub">Add companies to start tracking intent signals and buying behaviour.</div>
      <button class="btn btn-primary" id="es-btn" onclick="openAddCompany()">+ Add First Company</button>
    </div>
  </div>
</div>

<!-- ACCOUNT DRAWER -->
<div class="doverlay" id="doverlay" onclick="closeDrawer()"></div>
<div id="drawer">
  <button class="dclose" onclick="closeDrawer()">×</button>
  <div class="dhead">
    <div class="dco" id="d-name">—</div>
    <div class="dmeta" id="d-meta">—</div>
    <div style="display:flex;gap:8px;margin-top:14px;" id="d-actions"></div>
  </div>
  <div class="dbody" id="d-body">
    <div style="text-align:center;padding:40px;color:var(--muted);">Loading…</div>
  </div>
</div>

<div id="toast">✓ <span id="toast-msg"></span></div>

<script>
/* ═══════════════════════════════════
   STATE
═══════════════════════════════════ */
let _accounts     = [];
let _searchTimer  = null;
let _openCompanyId = null;

/* ═══════════════════════════════════
   INIT
═══════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => setTimeout(init, 400));

async function init() {
  if (!window.APP.user) { setTimeout(init, 400); return; }
  // ── FIX Bug 7: loadAccounts FIRST so _accounts is populated before loadStats reads it
  await loadAccounts();
  await loadStats();
}

async function loadAccounts() {
  const token = await getToken();
  try {
    const res = await api('/api/account-graph', { action: 'get_hot_accounts', limit: 60 }, token);
    _accounts = res.accounts || [];
    renderAccounts(_accounts);
  } catch(e) {
    document.getElementById('skeleton-grid').style.display = 'none';
    document.getElementById('empty-state').style.display   = 'block';
  }
}

async function loadStats() {
  const token = await getToken();
  try {
    const res = await api('/api/metrics', { action: 'dashboard' }, token);
    const hot = (_accounts.filter(a => a.intent_tier === 'HOT')).length;
    document.getElementById('stat-hot').textContent      = hot;
    document.getElementById('stat-reply').textContent    = res.outreach?.reply_rate || '—';
    document.getElementById('stat-meetings').textContent = res.outreach?.meeting_booked || 0;

    // Signal count from last 7 days (from metrics)
    const signalRes = await api('/api/metrics', { action: 'daily', days: 7 }, token);
    const totalSig  = (signalRes.days || []).reduce((s, d) => s + (d.calls || 0), 0);
    document.getElementById('stat-signals').textContent = totalSig;
  } catch {}
}

function refreshAccounts() { loadAccounts(); showToast('Refreshing…'); }

/* ═══════════════════════════════════
   RENDER
═══════════════════════════════════ */
function renderAccounts(accounts) {
  document.getElementById('skeleton-grid').style.display = 'none';
  const grid  = document.getElementById('accounts-grid');
  const empty = document.getElementById('empty-state');

  if (!accounts.length) {
    grid.style.display  = 'none';
    empty.style.display = 'block';
    // Show context-aware message based on whether filter is active
    const tier = document.getElementById('tier-filter')?.value || '';
    const q    = document.getElementById('search')?.value?.trim() || '';
    if (tier || q) {
      // Filtered empty — don't show "Add First Company"
      const icon = document.getElementById('es-icon');
      const title = document.getElementById('es-title');
      const sub  = document.getElementById('es-sub');
      const btn  = document.getElementById('es-btn');
      if (icon)  icon.textContent  = tier === 'HOT' ? '🔥' : tier === 'WARM' ? '🌡' : '🔍';
      if (title) title.textContent = `No ${tier || ''} accounts match your filter`.trim();
      if (sub)   sub.textContent   = 'Try clearing the filter to see all monitored companies.';
      if (btn)   btn.style.display = 'none';
    } else {
      // Truly empty — show add company
      const icon = document.getElementById('es-icon');
      const title = document.getElementById('es-title');
      const sub  = document.getElementById('es-sub');
      const btn  = document.getElementById('es-btn');
      if (icon)  icon.textContent  = '🧠';
      if (title) title.textContent = 'No accounts in intelligence graph';
      if (sub)   sub.textContent   = 'Add companies to start tracking intent signals and buying behaviour.';
      if (btn)   btn.style.display = '';
    }
    return;
  }
  empty.style.display = 'none';
  grid.style.display  = 'grid';

  grid.innerHTML = accounts.map(a => {
    const score     = a.total_intent_score || 0;
    const tier      = a.intent_tier || 'COLD';
    const sigTypes  = Array.isArray(a.signal_types) ? a.signal_types.filter(Boolean) : [];
    const techs     = Array.isArray(a.tech_stack)   ? a.tech_stack.filter(Boolean)   : [];
    const lastSig   = a.last_signal_at
      ? new Date(a.last_signal_at).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})
      : 'No signals';
    const intColor  = tier === 'HOT' ? 'var(--red)' : tier === 'WARM' ? 'var(--amber)' : 'var(--muted)';

    return `
    <div class="ac ${tier.toLowerCase()}" onclick="openDrawer('${a.company_id}')">
      <div class="ac-header">
        <div>
          <div class="ac-name">${esc(a.company_name)}</div>
          <div class="ac-domain">${esc(a.domain || a.industry || '—')}</div>
        </div>
        <div class="intent-ring">
          <div class="intent-num" style="color:${intColor}">${score}</div>
          <div class="intent-lbl">Intent</div>
        </div>
      </div>
      <span class="tier-badge tier-${tier}">${tier === 'HOT' ? '🔥' : tier === 'WARM' ? '🌡' : '❄'} ${tier}</span>
      <div class="sig-pills">
        ${sigTypes.slice(0,4).map(t => `<span class="sig-pill ${getSigClass(t)}">${t.replace(/_/g,' ')}</span>`).join('')}
        ${sigTypes.length > 4 ? `<span class="sig-pill">+${sigTypes.length - 4} more</span>` : ''}
      </div>
      ${techs.length ? `<div class="tech-chips">${techs.slice(0,5).map(t=>`<span class="tech-chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="ac-footer">
        <div class="ac-meta">${a.signal_count || 0} signals · ${lastSig}</div>
        <div class="ac-actions" onclick="event.stopPropagation()">
          <button class="btn btn-outline btn-sm" onclick="openDrawer('${a.company_id}')">View</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function getSigClass(type) {
  if (type?.includes('hiring')) return 'hiring';
  if (type?.includes('product')) return 'product';
  if (type?.includes('website')) return 'website';
  return '';
}

/* ═══════════════════════════════════
   SEARCH + FILTER
═══════════════════════════════════ */
function debounceSearch() { clearTimeout(_searchTimer); _searchTimer = setTimeout(applyFilters, 300); }

function applyFilters() {
  const q    = document.getElementById('search').value.toLowerCase().trim();
  const tier = document.getElementById('tier-filter').value;
  const sort = document.getElementById('sort-filter').value;

  let filtered = _accounts.filter(a => {
    const mq = !q || a.company_name.toLowerCase().includes(q) || (a.domain||'').toLowerCase().includes(q);
    const mt = !tier || a.intent_tier === tier;
    return mq && mt;
  });

  if (sort === 'signals') filtered.sort((a,b) => (b.signal_count||0) - (a.signal_count||0));
  else if (sort === 'name') filtered.sort((a,b) => a.company_name.localeCompare(b.company_name));
  else filtered.sort((a,b) => (b.total_intent_score||0) - (a.total_intent_score||0));

  renderAccounts(filtered);
}

/* ═══════════════════════════════════
   DRAWER — full account graph
═══════════════════════════════════ */
async function openDrawer(companyId) {
  _openCompanyId = companyId;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('doverlay').classList.add('show');
  document.getElementById('d-name').textContent = 'Loading…';
  document.getElementById('d-body').innerHTML   = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading graph…</div>';

  const token = await getToken();
  try {
    const res = await api('/api/account-graph', { action: 'get_graph', company_id: companyId }, token);
    renderDrawer(res);
  } catch(e) {
    document.getElementById('d-body').innerHTML = `<div style="color:var(--red);padding:20px">${e.message}</div>`;
  }
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('doverlay').classList.remove('show');
  _openCompanyId = null;
}

function renderDrawer(g) {
  const co   = g.company       || {};
  const intel = g.intelligence || {};
  const tier = intel.intent_score >= 60 ? 'HOT' : intel.intent_score >= 30 ? 'WARM' : 'COLD';

  document.getElementById('d-name').textContent = co.name || '—';
  document.getElementById('d-meta').textContent =
    `${co.domain||co.industry||'—'} · Intent: ${intel.intent_score||0} · ${tier}`;

  // FIX: Do NOT embed dynamic co.id / co.domain inside onclick="" string literals.
  // Template literal nesting + quote escaping causes "missing ) after argument list".
  // Use a direct event listener instead — clean and safe.
  document.getElementById('d-actions').innerHTML =
    '<button class="btn btn-primary btn-sm" id="gtm-btn-drawer">&#9889; Open GTM Strategy</button>' +
    '<button class="btn btn-outline btn-sm" id="scan-btn-drawer">&#128269; Scan Signals</button>' +
    '<button class="btn btn-outline btn-sm" id="edit-btn-drawer">&#9998; Edit</button>';

  // GTM Strategy — find existing strategy in vault, resume it
  const gtmBtn = document.getElementById('gtm-btn-drawer');
  if (gtmBtn) gtmBtn.onclick = async function() {
    gtmBtn.disabled = true; gtmBtn.textContent = 'Finding strategy…';
    try {
      const token = await getToken();
      const res = await fetch('/api/gtm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'get_vault', search: co.name, limit: 5 }),
      });
      const data = await res.json();
      const strategies = data.strategies || [];
      // Find best match
      const match = strategies.find(s =>
        s.company_name.toLowerCase().trim() === (co.name||'').toLowerCase().trim()
      ) || strategies[0];

      if (match) {
        // Resume existing strategy
        window.location.href = 'gtm-strategy.html?resume=' + match.id;
      } else {
        // No strategy yet — start new one
        window.location.href = 'gtm-strategy.html?company=' + encodeURIComponent(co.name||'') +
          '&industry=' + encodeURIComponent(co.industry||'');
      }
    } catch(e) {
      window.location.href = 'gtm-strategy.html?company=' + encodeURIComponent(co.name||'');
    }
  };

  // Scan Signals
  const scanBtn = document.getElementById('scan-btn-drawer');
  if (scanBtn) scanBtn.onclick = function() { scanCompany(co.id, co.domain || ''); };

  // Edit company
  const editBtn = document.getElementById('edit-btn-drawer');
  if (editBtn) editBtn.onclick = function() { openEditCompany(co.id, co.name||'', co.domain||'', co.industry||''); };

  const intColor = tier === 'HOT' ? 'var(--red)' : tier === 'WARM' ? 'var(--amber)' : 'var(--muted)';
  const field = (label, val) => val ? `<div style="margin-bottom:10px"><div style="font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.18em;color:var(--muted);margin-bottom:4px">${esc(label)}</div><div style="font-size:11px;color:#d1d5db;line-height:1.6;background:rgba(0,0,0,.3);border-radius:8px;padding:9px 11px">${esc(String(val))}</div></div>` : '';

  document.getElementById('d-body').innerHTML = `
    <!-- Score summary -->
    <div class="score-grid">
      <div class="score-box"><div class="score-val" style="color:${intColor}">${intel.intent_score||0}</div><div class="score-lab">Intent Score</div></div>
      <div class="score-box"><div class="score-val">${intel.avg_icp_score||'—'}</div><div class="score-lab">Avg ICP Score</div></div>
      <div class="score-box"><div class="score-val">${intel.total_touchpoints||0}</div><div class="score-lab">Touchpoints</div></div>
    </div>
    <div class="score-grid" style="margin-bottom:20px">
      <div class="score-box"><div class="score-val">${intel.lead_count||0}</div><div class="score-lab">Leads</div></div>
      <div class="score-box"><div class="score-val">${intel.signal_count||0}</div><div class="score-lab">Signals</div></div>
      <div class="score-box"><div class="score-val" style="color:var(--green)">${intel.response_rate||'0.0%'}</div><div class="score-lab">Response Rate</div></div>
    </div>

    <!-- Technologies -->
    ${(g.technologies||[]).length ? `
    <div class="dsec">
      <div class="dstitle">Technology Stack</div>
      <div class="tech-chips">${(g.technologies||[]).map(t=>`<span class="tech-chip">${esc(t)}</span>`).join('')}</div>
    </div>` : ''}

    <!-- Signals -->
    ${(g.signals||[]).length ? `
    <div class="dsec">
      <div class="dstitle">Intent Signals</div>
      ${g.signals.map(s => {
        const age = Math.round((Date.now() - new Date(s.detected_at).getTime()) / 86400000);
        const icon = {hiring_growth:'📈',product_launch:'🚀',tech_adoption:'⚙',content_activity:'📝',website_change:'🌐',funding_signal:'💰',leadership_change:'👤',expansion_signal:'🌍'}[s.type]||'•';
        return `<div class="sig-row"><span class="sig-icon">${icon}</span><div><div class="sig-type">${s.type.replace(/_/g,' ')}</div></div><div class="sig-age">${age}d ago</div><div class="sig-score">+${s.score}</div></div>`;
      }).join('')}
    </div>` : '<div style="font-size:11px;color:var(--muted);margin-bottom:20px">No signals detected yet. Click Scan Signals to analyse this company\'s website.</div>'}

    <!-- Recommendations -->
    ${(g.recommendations||[]).length ? `
    <div class="dsec">
      <div class="dstitle">Recommended Actions</div>
      ${g.recommendations.map(r=>`<div class="rec-row"><span class="rec-priority rec-${r.priority}">${r.priority}</span><div class="rec-text">${esc(r.action)}</div></div>`).join('')}
    </div>` : ''}

    <!-- Timeline -->
    ${(g.timeline||[]).length ? `
    <div class="dsec">
      <div class="dstitle">Activity Timeline</div>
      ${g.timeline.slice(0,10).map(t=>`<div class="timeline-item"><div class="tl-dot ${t.type}"></div><div class="tl-label">${esc(t.label)}${t.channel?' · '+t.channel:''}</div><div class="tl-date">${new Date(t.date).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})}</div></div>`).join('')}
    </div>` : ''}
  `;
}

/* ═══════════════════════════════════
   ACTIONS
═══════════════════════════════════ */
async function scanCompany(companyId, domain) {
  if (!domain) {
    showToast('No domain set — click ✎ Edit to add this company\'s domain first.', 'error');
    return;
  }
  const btn = document.getElementById('scan-btn-drawer');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
  showToast('🔍 Scanning ' + domain + ' for buying signals…');

  try {
    const token = await getToken();
    const a = _accounts.find(a => a.company_id === companyId);
    const res = await fetch('/api/analyze-website', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        company_id:   companyId,
        website_url:  'https://' + domain,
        company_name: a ? a.company_name : '',
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast('Scan failed: ' + (data.error || 'HTTP ' + res.status), 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Scan Signals'; }
      return;
    }

    const sigCount = data.signals_detected || 0;
    const sigs     = (data.signals || []).map(function(s){ return s.type.replace(/_/g,' '); });

    if (sigCount === 0) {
      showToast('Scan complete — no buying signals detected on ' + domain, '');
    } else {
      showToast('✓ ' + sigCount + ' signal' + (sigCount>1?'s':'') + ' detected: ' + sigs.join(', '), 'success');
    }

    // Refresh accounts list and reopen drawer with updated score
    await loadAccounts();
    setTimeout(function() {
      if (_openCompanyId) openDrawer(_openCompanyId);
    }, 600);

  } catch(e) {
    showToast('Scan error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Scan Signals'; }
  }
}

// ── SCAN SIGNALS — scans ALL monitored companies for buying signals ──
async function runSignalScan() {
  const withDomain = _accounts.filter(function(a){ return a.domain; });
  const noDomain   = _accounts.filter(function(a){ return !a.domain; });

  if (!_accounts.length) {
    showToast('No companies to scan. Add companies first.', 'error');
    return;
  }
  if (!withDomain.length) {
    showToast('No companies have a domain set. Click ✎ Edit on each company to add their domain.', 'error');
    return;
  }

  const scanBtn = document.querySelector('[onclick="runSignalScan()"]');
  if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = '⏳ Scanning…'; }
  showToast('⚡ Scanning ' + withDomain.length + ' companies for buying signals…');

  const token = await getToken();
  let totalSignals = 0;
  const results = [];

  for (const a of withDomain) {
    try {
      const res = await fetch('/api/analyze-website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          company_id:   a.company_id,
          website_url:  'https://' + a.domain,
          company_name: a.company_name,
        }),
      });
      const data = await res.json();
      const sigs = data.signals_detected || 0;
      totalSignals += sigs;
      results.push({ name: a.company_name, signals: sigs, ok: res.ok });
    } catch(e) {
      results.push({ name: a.company_name, signals: 0, ok: false, err: e.message });
    }
  }

  if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = '⚡ Scan Signals'; }

  // Show summary
  const detected  = results.filter(function(r){ return r.signals > 0; });
  const noSignals = results.filter(function(r){ return r.signals === 0 && r.ok; });
  const failed    = results.filter(function(r){ return !r.ok; });

  var msg = '⚡ Scan complete — ' + totalSignals + ' signal' + (totalSignals !== 1 ? 's' : '') + ' across ' + withDomain.length + ' companies';
  if (detected.length) msg += ' · ' + detected.length + ' with signals';
  if (noDomain.length) msg += ' · ' + noDomain.length + ' skipped (no domain)';
  showToast(msg, totalSignals > 0 ? 'success' : '');

  // Auto-run learning cycle to update scores
  if (totalSignals > 0) {
    setTimeout(async function() {
      showToast('🧠 Updating intent scores…');
      try {
        const r2 = await fetch('/api/intent-engine', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ action: 'score_all' }),
        });
        const d2 = await r2.json();
        const hot    = (d2.summary || []).filter(function(s){ return s.tier === 'HOT'; }).length;
        const warm   = (d2.summary || []).filter(function(s){ return s.tier === 'WARM'; }).length;
        const changed = d2.tiers_changed || 0;
        var scoreMsg = '✓ Scores updated — ' + hot + ' HOT · ' + warm + ' WARM';
        if (changed > 0) scoreMsg += ' · ' + changed + ' tier' + (changed>1?'s':'') + ' changed';
        showToast(scoreMsg, 'success');
        setTimeout(loadAccounts, 500);
      } catch(e) {
        showToast('Score update failed: ' + e.message, 'error');
      }
    }, 1500);
  } else {
    setTimeout(loadAccounts, 800);
  }
}

// ── RUN LEARNING CYCLE — recalculates intent scores for ALL companies ──
async function runLearningCycle() {
  if (!_accounts.length) {
    showToast('No companies to score.', 'error');
    return;
  }
  const btn = document.querySelector('[onclick="runLearningCycle()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scoring…'; }
  showToast('🧠 Recalculating intent scores…');

  // Use setTimeout to prevent UI blocking
  setTimeout(async function() {
    try {
      const token = await getToken();
      const r = await fetch('/api/intent-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'score_all' }),
      });
      const d = await r.json();
      if (!r.ok) {
        showToast('Score update failed: ' + (d.error || 'HTTP ' + r.status), 'error');
        if (btn) { btn.disabled = false; btn.textContent = '🧠 Run Learning Cycle'; }
        return;
      }
      const scored  = d.companies_scored || 0;
      const changed = d.tiers_changed    || 0;
      const hot     = (d.summary || []).filter(function(s){ return s.tier === 'HOT';  }).length;
      const warm    = (d.summary || []).filter(function(s){ return s.tier === 'WARM'; }).length;
      const cold    = (d.summary || []).filter(function(s){ return s.tier === 'COLD'; }).length;

      var msg = '🧠 ' + scored + ' companies scored';
      if (hot || warm) msg += ' — ' + hot + ' HOT · ' + warm + ' WARM · ' + cold + ' COLD';
      if (changed > 0) msg += ' · ' + changed + ' tier' + (changed > 1 ? 's' : '') + ' changed';
      else if (scored > 0 && !hot && !warm) msg += ' — no signals found yet. Run Scan Signals first.';

      showToast(msg, scored > 0 ? 'success' : '');
      if (btn) { btn.disabled = false; btn.textContent = '🧠 Run Learning Cycle'; }
      setTimeout(loadAccounts, 500);
    } catch(e) {
      showToast('Error: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🧠 Run Learning Cycle'; }
    }
  }, 0);
}

function openAddCompany() {
  const name = prompt('Company name:');
  if (!name?.trim()) return;
  const domain = prompt('Company domain (e.g. stripe.com) — press OK to skip:') || '';
  addCompany(name.trim(), domain.trim());
}

async function addCompany(name, domain) {
  const token = await getToken();
  try {
    const res = await fetch('/api/account-graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ action: 'add_company', name, domain }),
    });
    const data = await res.json();
    if (!res.ok) {
      // Treat as duplicate if 409 or error mentions conflict
      const err = data.error || '';
      if (res.status === 409 || err.includes('duplicate') || err.includes('already')) {
        showToast(`${name} is already being monitored ✓`, 'success');
      } else {
        showToast('Failed: ' + err, 'error');
      }
    } else {
      showToast(`${name} added to Account Intelligence ✓`, 'success');
    }
    setTimeout(() => loadAccounts(), 800);
  } catch(e) {
    showToast(e.message, 'error');
  }
}

/* ═══════════════════════════════════
   UTILS
═══════════════════════════════════ */
async function api(endpoint, body, token) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getToken() {
  const { data: { session } } = await window.APP.sb.auth.getSession();
  return session?.access_token || '';
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.className = type;
  document.getElementById('toast-msg').textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

function esc(s) {
  if (typeof s !== 'string') return String(s||'');
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════
   EDIT COMPANY
═══════════════════════════════════ */
function openEditCompany(companyId, name, domain, industry) {
  var ex = document.getElementById('edit-co-modal');
  if (ex) ex.remove();

  var overlay = document.createElement('div');
  overlay.id = 'edit-co-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)';

  var box = document.createElement('div');
  box.style.cssText = 'width:100%;max-width:400px;background:#0F1420;border:1px solid #1C2235;border-radius:14px;overflow:hidden;font-family:inherit';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:rgba(0,0,0,.3);border-bottom:1px solid #1C2235';
  var htitle = document.createElement('div');
  htitle.style.cssText = 'font-size:13px;font-weight:800;color:white';
  htitle.textContent = '\u270e Edit Company';
  var xBtn = document.createElement('button');
  xBtn.textContent = '\u2715';
  xBtn.style.cssText = 'background:none;border:none;color:#6B7280;cursor:pointer;font-size:16px;font-family:inherit';
  xBtn.onclick = function(){ overlay.remove(); };
  hdr.appendChild(htitle);
  hdr.appendChild(xBtn);

  var body = document.createElement('div');
  body.style.cssText = 'padding:20px 18px';

  function mkField(label, id, val, ph) {
    var w = document.createElement('div');
    w.style.marginBottom = '12px';
    var l = document.createElement('div');
    l.style.cssText = 'font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#6B7280;margin-bottom:5px';
    l.textContent = label;
    var inp = document.createElement('input');
    inp.id = id; inp.type = 'text'; inp.value = val || ''; inp.placeholder = ph || '';
    inp.style.cssText = 'width:100%;background:rgba(0,0,0,.3);border:1px solid #1C2235;color:#E2E8F0;font-size:12px;padding:9px 12px;border-radius:7px;font-family:inherit;outline:none;box-sizing:border-box';
    w.appendChild(l); w.appendChild(inp);
    return w;
  }

  body.appendChild(mkField('Company Name',             'eco-name',     name,     ''));
  body.appendChild(mkField('Domain (e.g. stripe.com)', 'eco-domain',   domain,   'company.com'));
  body.appendChild(mkField('Industry',                 'eco-industry', industry, 'e.g. Fintech'));

  var footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:6px';

  var cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 16px;border-radius:7px;font-size:10px;font-weight:800;background:rgba(31,41,55,.5);border:1px solid #1C2235;color:#6B7280;cursor:pointer;font-family:inherit';
  cancelBtn.onclick = function(){ overlay.remove(); };

  var saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save Changes';
  saveBtn.style.cssText = 'padding:8px 16px;border-radius:7px;font-size:10px;font-weight:800;background:linear-gradient(135deg,#a855f7,#7c3aed);color:white;border:none;cursor:pointer;font-family:inherit';
  saveBtn.onclick = function(){ saveEditCompany(companyId); };

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  body.appendChild(footer);
  box.appendChild(hdr);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(function(){ var n=document.getElementById('eco-name'); if(n) n.focus(); }, 100);
}

async function saveEditCompany(companyId) {
  var name     = (document.getElementById('eco-name').value     || '').trim();
  var domain   = (document.getElementById('eco-domain').value   || '').trim();
  var industry = (document.getElementById('eco-industry').value || '').trim();
  if (!name) { showToast('Company name is required', 'error'); return; }

  // Normalise domain
  domain = domain.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0].toLowerCase();

  try {
    const token = await getToken();
    const res = await fetch('/api/account-graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        action:     'update_company',
        company_id: companyId,
        name:       name,
        domain:     domain,
        industry:   industry,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showToast('Save failed: ' + (data.error||'unknown'), 'error'); return; }
    document.getElementById('edit-co-modal').remove();
    showToast(name + ' updated ✓', 'success');
    // Close drawer, reload accounts, reopen drawer — ensures fresh co.domain in closure
    closeDrawer();
    await loadAccounts();
    if (companyId) {
      setTimeout(function(){ openDrawer(companyId); }, 300);
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function handleSignOut() {
  try { await window.APP.sb.auth.signOut({ scope:'local' }); } catch(_) {}
  Object.keys(localStorage).forEach(k => { if (k.startsWith('sb-')||k.includes('supabase')) localStorage.removeItem(k); });
  window.location.replace('login.html');
}
</script>

</body>
</html>
