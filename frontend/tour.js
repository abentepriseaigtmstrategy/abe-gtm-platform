/**
 * ABE Platform — Interactive Onboarding Tour
 * Include AFTER auth-guard.js on every page
 *
 * Features:
 * - Step-by-step spotlight tour per page
 * - Prerequisite warnings ("Complete X before Y")
 * - Progress tracked in localStorage
 * - Restart tour anytime via ? button in nav
 * - Skippable but resurfaces on next visit if incomplete
 */

(function () {
'use strict';

// ── TOUR DATA ────────────────────────────────────────────────────
var PAGES = {
  'gtm-strategy': 1,
  'vault':        2,
  'accounts':     3,
  'leads':        4,
  'dashboard':    0,
};

var TOURS = {

  // ─── DASHBOARD / COMMAND CENTRE ─────────────────────────────
  dashboard: [
    {
      title:  'Welcome to ABE — AI Revenue Infrastructure',
      body:   'ABE gives you two platforms in one. The ABE GTM Platform builds complete go-to-market strategies per account. The AI Lead Orchestration platform scores and outreaches your lead database at scale. This tour covers both.',
      anchor: null,
      pos:    'center',
    },
    {
      title:  'ABE GTM Platform — How It Works',
      body:   'Step 1: GTM Strategy — enter a company, generate 6-step intelligence (Market, TAM, ICP, Sourcing, Keywords, Messaging). Step 2: Strategy Vault — all saved strategies. Step 3: Account Intelligence — monitor buying signals. Step 4: Lead Manager — pipeline tracking.',
      anchor: null,
      pos:    'center',
    },
    {
      title:  'AI Lead Orchestration — How It Works',
      body:   'Import any CSV or Excel file of leads. Execute Mapping scores every lead instantly — green HIGH, amber MEDIUM, red LOW. Bulk Analyze Intel generates AI intelligence for 100 leads in under 3 minutes. Each lead gets Pain Area, Key Insight, Solution and Cold Outreach.',
      anchor: null,
      pos:    'center',
    },
    {
      title:  'GTM Strategy — Start Here',
      body:   'Click GTM Strategy, enter any company name and website. ABE extracts their digital footprint and runs all 6 strategy steps. Each step builds on the previous. The full strategy takes 3-4 minutes.',
      anchor: 'a[href="gtm-strategy.html"]',
      pos:    'bottom',
    },
    {
      title:  'Strategy Vault',
      body:   'Every completed strategy auto-saves here. Select multiple companies and use bulk actions: → Lead Manager to start outreach, or 📡 Monitor to track buying signals in Account Intelligence.',
      anchor: 'a[href="vault.html"]',
      pos:    'bottom',
    },
    {
      title:  'Account Intelligence',
      body:   'Tracks 8 buying signal types for every company you monitor — hiring growth, funding signals, product launches, leadership changes and more. Signals older than 14 days decay automatically. Scores always reflect right now.',
      anchor: 'a[href="accounts.html"]',
      pos:    'bottom',
    },
    {
      title:  'Lead Manager',
      body:   'Your AI-powered pipeline. Import raw CSV/Excel lead lists, score every contact, generate personalised outreach per lead, and track every prospect from first contact to closed deal.',
      anchor: 'a[href="leads.html"]',
      pos:    'bottom',
    },
    {
      title:  'BYOK — Bring Your Own API Key',
      body:   'ABE uses your own OpenAI API key — paste it once in settings, it stays in session memory only, wiped on logout. No key stored on servers. No data sold. Your key, your machine.',
      anchor: null,
      pos:    'center',
    },
    {
      title:  'You\'re ready 🚀',
      body:   'Start with GTM Strategy → enter your first target company → run all 6 steps. Then send it to Lead Manager or Account Intelligence. Click the ? button anytime to restart this tour.',
      anchor: null,
      pos:    'center',
    },
  ],

  // ─── GTM STRATEGY ────────────────────────────────────────────
  'gtm-strategy': [
    {
      title:  'GTM Strategy Builder',
      body:   'This is the core of ABE. Enter a company name and website URL, then run all 6 strategy steps — Market Research, TAM, ICP, Sourcing, Keywords, and Messaging.',
      anchor: '#topnav',
      pos:    'bottom',
    },
    {
      title:  'Configure Your AI Key First',
      body:   'Click the ⚙ Config button to paste your OpenAI API key. It stays in session memory only — never stored on our servers. Without this, the AI steps won\'t run.',
      anchor: '[onclick="openApiModal()"]',
      pos:    'bottom',
      warn:   true,
    },
    {
      title:  'Run All 6 Steps in Order',
      body:   'Each step builds on the previous one. Complete Step 1 first, then unlock Step 2 and so on. The full strategy takes 3-4 minutes to generate.',
      anchor: '#step-nav-1',
      pos:    'right',
    },
    {
      title:  'Strategy Saves Automatically',
      body:   'Every completed step saves to your Strategy Vault instantly. If you close the page, you can resume from where you left off.',
      anchor: '#step-nav-1',
      pos:    'right',
    },
  ],

  // ─── STRATEGY VAULT ──────────────────────────────────────────
  vault: [
    {
      title:  'Strategy Vault',
      body:   'All your completed GTM strategies live here. Each card shows the company name, GTM score, and how many of the 6 steps are complete.',
      anchor: '#topnav',
      pos:    'bottom',
    },
    {
      title:  'Select Multiple Companies',
      body:   'Tick the checkbox on any card to select it. Select several at once to take bulk actions — send to Lead Manager or monitor in Account Intelligence.',
      anchor: '.vault-card-checkbox',
      pos:    'right',
    },
    {
      title:  'Send to Lead Manager',
      body:   'Click → Lead Manager in the bulk action bar to convert a strategy into a scored lead. The GTM score carries over — no rescoring needed.',
      anchor: '#vault-bulk-bar',
      pos:    'top',
    },
    {
      title:  'Monitor in Account Intelligence',
      body:   'Click 📡 Monitor in Account Intelligence to start tracking a company\'s buying signals automatically. Best used for medium/low intent companies that aren\'t ready to buy yet.',
      anchor: '#vault-bulk-bar',
      pos:    'top',
    },
  ],

  // ─── ACCOUNT INTELLIGENCE ────────────────────────────────────
  accounts: [
    {
      title:  'Account Intelligence',
      body:   'This module tracks buying signals for every company you\'re monitoring. When a company\'s intent score rises — due to hiring, funding, or product launches — you\'ll see it here.',
      anchor: '#topnav',
      pos:    'bottom',
    },
    {
      title:  'Add Companies to Monitor',
      body:   'Companies are added here from the Strategy Vault. Go to Vault → select companies → click 📡 Monitor. Or click + Add Company to add one manually.',
      anchor: '[onclick="openAddCompany()"]',
      pos:    'left',
    },
    {
      title:  'Scan Signals',
      body:   'Click ⚡ Scan Signals to analyse all monitored companies\' websites for buying signals. ABE detects hiring growth, product launches, funding announcements and more.',
      anchor: '[onclick="runSignalScan()"]',
      pos:    'bottom',
    },
    {
      title:  'Run Learning Cycle',
      body:   'Click 🧠 Run Learning Cycle to recalculate intent scores for all your companies based on their latest signals. Run this after scanning to update the scores.',
      anchor: '[onclick="runLearningCycle()"]',
      pos:    'bottom',
    },
    {
      title:  'Filter by Intent Tier',
      body:   'Use the tier filter to show only HOT, WARM, or COLD accounts. HOT = score 60+, WARM = 30-59, COLD = below 30. Keep ALL TIERS selected to see every monitored company.',
      anchor: '#tier-filter',
      pos:    'bottom',
    },
  ],

  // ─── LEAD MANAGER ────────────────────────────────────────────
  leads: [
    {
      title:  'Lead Manager',
      body:   'Your AI-powered pipeline. Import raw lead lists from CSV or Excel, score them automatically, generate personalised outreach, and track every prospect.',
      anchor: '#topnav',
      pos:    'bottom',
    },
    {
      title:  'Import Your Lead List',
      body:   'Click ⬆ Import CSV to upload any spreadsheet of leads. ABE maps your columns automatically — no formatting required.',
      anchor: '[onclick="openImport()"]',
      pos:    'bottom',
      warn:   true,
    },
    {
      title:  'Filter and Sort Leads',
      body:   'Use the Priority and Intent filters to focus on your highest-value leads. Sort by ICP score, intent score, or date imported.',
      anchor: '#filter-priority',
      pos:    'bottom',
    },
  ],
};

// ── PREREQUISITES (shown as blocking warnings) ──────────────────
var PREREQS = {
  vault:    { key: 'abe_tour_gtm_done',     msg: 'Run at least one GTM Strategy first — then your strategies will appear here.' },
  accounts: { key: 'abe_tour_vault_done',   msg: 'Add companies to your Strategy Vault first — then send them to Account Intelligence.' },
  leads:    { key: 'abe_tour_gtm_done',     msg: 'Run at least one GTM Strategy first to understand your ICP before importing leads.' },
};

// ── STATE ───────────────────────────────────────────────────────
var currentPage  = null;
var currentStep  = 0;
var tourSteps    = [];
var overlayEl    = null;
var boxEl        = null;
var helpBtnEl    = null;
var _resizeTimer = null;

// ── CSS ─────────────────────────────────────────────────────────
var CSS = `
.abe-tour-overlay {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0,0,0,0);
  pointer-events: none;
  transition: background .3s;
}
.abe-tour-overlay.dim { background: rgba(0,0,0,.65); }

.abe-spotlight {
  position: fixed; z-index: 9001;
  border-radius: 10px;
  box-shadow: 0 0 0 9999px rgba(0,0,0,.65), 0 0 0 3px #a855f7, 0 0 24px rgba(168,85,247,.5);
  pointer-events: none !important;
  transition: all .35s cubic-bezier(.4,0,.2,1);
}

.abe-tour-box {
  position: fixed; z-index: 9010;
  pointer-events: all;
  background: #0F1420;
  border: 1px solid rgba(168,85,247,.4);
  border-radius: 14px;
  padding: 20px 22px;
  max-width: 320px;
  min-width: 260px;
  box-shadow: 0 20px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(168,85,247,.1);
  animation: abe-pop .25s cubic-bezier(.34,1.56,.64,1);
  font-family: 'Inter', sans-serif;
}
@keyframes abe-pop {
  from { opacity:0; transform: scale(.92) translateY(6px); }
  to   { opacity:1; transform: scale(1)   translateY(0); }
}

.abe-tour-box .abe-progress {
  display: flex; gap: 4px; margin-bottom: 14px;
}
.abe-tour-box .abe-prog-dot {
  height: 3px; flex: 1; border-radius: 2px;
  background: rgba(168,85,247,.2);
  transition: background .3s;
}
.abe-tour-box .abe-prog-dot.done { background: #a855f7; }
.abe-tour-box .abe-prog-dot.active { background: #7c3aed; }

.abe-tour-box .abe-tour-icon {
  font-size: 22px; margin-bottom: 8px;
}
.abe-tour-box .abe-tour-title {
  font-size: 13px; font-weight: 800; color: white;
  letter-spacing: -.2px; margin-bottom: 6px; line-height: 1.3;
}
.abe-tour-box .abe-tour-body {
  font-size: 11px; color: #94A3B8; line-height: 1.65; margin-bottom: 16px;
}
.abe-tour-box .abe-tour-warn {
  display: flex; gap: 7px; align-items: flex-start;
  background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.25);
  border-radius: 7px; padding: 8px 10px; margin-bottom: 12px;
  font-size: 10px; color: #fde68a; line-height: 1.5;
}
.abe-tour-box .abe-tour-actions {
  display: flex; align-items: center; gap: 7px;
}
.abe-tbtn {
  padding: 7px 14px; border-radius: 7px; font-size: 10px;
  font-weight: 800; cursor: pointer; border: none;
  font-family: 'Inter', sans-serif; text-transform: uppercase;
  letter-spacing: .08em; transition: all .15s;
  position: relative; z-index: 9020; pointer-events: all;
}
.abe-tbtn.next {
  background: linear-gradient(135deg, #a855f7, #7c3aed); color: white;
  flex: 1;
}
.abe-tbtn.next:hover { opacity: .9; transform: translateY(-1px); }
.abe-tbtn.skip {
  background: rgba(31,41,55,.5); border: 1px solid #1C2235;
  color: #6B7280;
}
.abe-tbtn.skip:hover { color: #E2E8F0; }
.abe-tbtn.done {
  background: linear-gradient(135deg, #22c55e, #16a34a); color: white;
  flex: 1;
}
.abe-step-count {
  font-size: 9px; color: #64748B; font-weight: 700;
  text-transform: uppercase; letter-spacing: .1em; margin-left: auto;
}

/* Help button */
.abe-help-btn {
  position: fixed; bottom: 24px; right: 24px; z-index: 8999;
  width: 40px; height: 40px; border-radius: 50%;
  background: linear-gradient(135deg, #a855f7, #7c3aed);
  color: white; font-size: 16px; font-weight: 800;
  border: none; cursor: pointer; font-family: 'Inter', sans-serif;
  box-shadow: 0 4px 16px rgba(168,85,247,.4);
  transition: all .2s; display: flex; align-items: center; justify-content: center;
}
.abe-help-btn:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(168,85,247,.5); }
.abe-help-btn .abe-help-tooltip {
  position: absolute; bottom: 48px; right: 0; white-space: nowrap;
  background: #0F1420; border: 1px solid rgba(168,85,247,.3);
  border-radius: 7px; padding: 5px 10px;
  font-size: 10px; font-weight: 700; color: #E2E8F0;
  opacity: 0; pointer-events: none; transition: opacity .2s;
}
.abe-help-btn:hover .abe-help-tooltip { opacity: 1; }

/* Prereq warning banner */
.abe-prereq-banner {
  position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
  z-index: 8990; background: rgba(245,158,11,.1);
  border: 1px solid rgba(245,158,11,.35); border-radius: 10px;
  padding: 12px 18px; display: flex; align-items: center; gap: 10px;
  max-width: 520px; font-family: 'Inter', sans-serif;
  animation: abe-pop .3s ease;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.abe-prereq-banner .abe-pb-icon { font-size: 18px; flex-shrink: 0; }
.abe-prereq-banner .abe-pb-text { font-size: 11px; color: #fde68a; line-height: 1.5; flex: 1; }
.abe-prereq-banner .abe-pb-close {
  background: none; border: none; color: #6B7280; cursor: pointer;
  font-size: 14px; font-family: inherit; padding: 2px 4px;
  flex-shrink: 0;
}
.abe-prereq-banner .abe-pb-close:hover { color: #E2E8F0; }
`;

// ── INIT ────────────────────────────────────────────────────────
function init() {
  // Detect current page
  var path = window.location.pathname;
  for (var p in PAGES) {
    if (path.includes(p)) { currentPage = p; break; }
  }
  if (!currentPage) currentPage = 'dashboard';

  tourSteps = TOURS[currentPage] || [];

  injectCSS();
  addHelpButton();
  checkPrerequisite();

  // Auto-start tour if first visit to this page
  var key = 'abe_toured_' + currentPage;
  if (!localStorage.getItem(key)) {
    setTimeout(startTour, 1200);
  }

  // Mark progress when page visited
  markProgress();
}

function injectCSS() {
  if (document.getElementById('abe-tour-css')) return;
  var s = document.createElement('style');
  s.id = 'abe-tour-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function markProgress() {
  var marks = {
    'gtm-strategy': 'abe_tour_gtm_done',
    'vault':        'abe_tour_vault_done',
    'accounts':     'abe_tour_accounts_done',
    'leads':        'abe_tour_leads_done',
  };
  if (marks[currentPage]) {
    localStorage.setItem(marks[currentPage], '1');
  }
}

// ── PREREQUISITE CHECK ──────────────────────────────────────────
function checkPrerequisite() {
  var prereq = PREREQS[currentPage];
  if (!prereq) return;
  if (localStorage.getItem(prereq.key)) return; // prereq done

  setTimeout(function() {
    var banner = document.createElement('div');
    banner.className = 'abe-prereq-banner';
    banner.innerHTML =
      '<div class="abe-pb-icon">⚠️</div>' +
      '<div class="abe-pb-text"><strong style="color:white">Heads up!</strong> ' + prereq.msg + '</div>' +
      '<button class="abe-pb-close" onclick="this.parentNode.remove()">✕</button>';
    document.body.appendChild(banner);
    setTimeout(function() { if (banner.parentNode) banner.remove(); }, 8000);
  }, 800);
}

// ── TOUR ENGINE ─────────────────────────────────────────────────
function startTour() {
  if (!tourSteps.length) return;
  currentStep = 0;
  createOverlay();
  showStep(currentStep);
}

function createOverlay() {
  // Spotlight element
  if (!document.getElementById('abe-spotlight')) {
    var sp = document.createElement('div');
    sp.id = 'abe-spotlight';
    sp.className = 'abe-spotlight';
    document.body.appendChild(sp);
  }

  overlayEl = document.getElementById('abe-spotlight');
  overlayEl.style.display = 'block';
}

function showStep(n) {
  var step = tourSteps[n];
  if (!step) { endTour(); return; }

  // Remove old box
  var old = document.getElementById('abe-tour-box');
  if (old) old.remove();

  // Spotlight anchor
  var anchor = step.anchor ? document.querySelector(step.anchor) : null;
  positionSpotlight(anchor);

  // Build box
  boxEl = document.createElement('div');
  boxEl.id = 'abe-tour-box';
  boxEl.className = 'abe-tour-box';

  var isLast = n === tourSteps.length - 1;
  var icons = ['🎯','⚙️','📊','🔍','💡','🚀','📡','🧠','✅'];
  var icon = icons[n % icons.length];

  var progressDots = tourSteps.map(function(_, i) {
    var cls = i < n ? 'done' : i === n ? 'active' : '';
    return '<div class="abe-prog-dot ' + cls + '"></div>';
  }).join('');

  var warnHtml = step.warn
    ? '<div class="abe-tour-warn"><span>⚠️</span><span>This step is required before proceeding.</span></div>'
    : '';

  var nextLabel = isLast ? '✓ Got it!' : 'Next →';
  var nextClass = isLast ? 'abe-tbtn done' : 'abe-tbtn next';

  boxEl.innerHTML =
    '<div class="abe-progress">' + progressDots + '</div>' +
    '<div class="abe-tour-icon">' + icon + '</div>' +
    '<div class="abe-tour-title">' + step.title + '</div>' +
    '<div class="abe-tour-body">' + step.body + '</div>' +
    warnHtml +
    '<div class="abe-tour-actions">' +
      '<button class="abe-tbtn skip" onclick="skipTour()">Skip tour</button>' +
      '<button class="' + nextClass + '" onclick="tourNext()">' + nextLabel + '</button>' +
      '<span class="abe-step-count">' + (n+1) + ' / ' + tourSteps.length + '</span>' +
    '</div>';

  document.body.appendChild(boxEl);
  positionBox(anchor, step.pos);

  // Click backdrop to advance
  document.addEventListener('keydown', onKeyPress);
}

function positionSpotlight(anchor) {
  if (!overlayEl) return;
  if (!anchor) {
    // Center mode — no spotlight
    overlayEl.style.display = 'none';
    return;
  }
  overlayEl.style.display = 'block';
  var r = anchor.getBoundingClientRect();
  var pad = 8;
  overlayEl.style.left   = (r.left - pad) + 'px';
  overlayEl.style.top    = (r.top - pad) + 'px';
  overlayEl.style.width  = (r.width + pad*2) + 'px';
  overlayEl.style.height = (r.height + pad*2) + 'px';
}

function positionBox(anchor, pos) {
  if (!boxEl) return;
  var bw = boxEl.offsetWidth  || 300;
  var bh = boxEl.offsetHeight || 200;
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var margin = 16;

  if (!anchor || pos === 'center') {
    // Centre of screen
    boxEl.style.left = Math.max(margin, (vw - bw) / 2) + 'px';
    boxEl.style.top  = Math.max(margin, (vh - bh) / 2) + 'px';
    return;
  }

  var r = anchor.getBoundingClientRect();
  var left = r.left, top = r.top;

  if (pos === 'bottom') {
    top  = r.bottom + 14;
    left = r.left + r.width/2 - bw/2;
  } else if (pos === 'top') {
    top  = r.top - bh - 14;
    left = r.left + r.width/2 - bw/2;
  } else if (pos === 'right') {
    top  = r.top + r.height/2 - bh/2;
    left = r.right + 14;
  } else if (pos === 'left') {
    top  = r.top + r.height/2 - bh/2;
    left = r.left - bw - 14;
  }

  // Clamp to viewport
  left = Math.max(margin, Math.min(vw - bw - margin, left));
  top  = Math.max(margin, Math.min(vh - bh - margin, top));

  boxEl.style.left = left + 'px';
  boxEl.style.top  = top + 'px';
}

function tourNext() {
  document.removeEventListener('keydown', onKeyPress);
  currentStep++;
  if (currentStep >= tourSteps.length) {
    endTour();
  } else {
    showStep(currentStep);
  }
}

function skipTour() {
  document.removeEventListener('keydown', onKeyPress);
  endTour();
}

function endTour() {
  document.removeEventListener('keydown', onKeyPress);
  var box = document.getElementById('abe-tour-box');
  if (box) box.remove();
  if (overlayEl) overlayEl.style.display = 'none';
  // Mark as toured
  localStorage.setItem('abe_toured_' + currentPage, '1');
}

function onKeyPress(e) {
  if (e.key === 'Escape') skipTour();
  if (e.key === 'ArrowRight' || e.key === 'Enter') tourNext();
}

// ── HELP BUTTON ─────────────────────────────────────────────────
function addHelpButton() {
  if (document.getElementById('abe-help-btn')) return;
  helpBtnEl = document.createElement('button');
  helpBtnEl.id = 'abe-help-btn';
  helpBtnEl.className = 'abe-help-btn';
  helpBtnEl.innerHTML = '?<div class="abe-help-tooltip">Platform guide</div>';
  helpBtnEl.onclick = function() {
    // Reset tour flag and restart
    localStorage.removeItem('abe_toured_' + currentPage);
    endTour();
    setTimeout(startTour, 100);
  };
  document.body.appendChild(helpBtnEl);
}

// ── EXPOSE GLOBALLY ─────────────────────────────────────────────
// Must be on window so onclick="" handlers in HTML strings can call them
window.tourNext  = function() { tourNext(); };
window.skipTour  = function() { skipTour(); };

window.ABE_TOUR = {
  start:  startTour,
  skip:   skipTour,
  next:   tourNext,
  reset:  function() {
    ['dashboard','gtm-strategy','vault','accounts','leads'].forEach(function(p) {
      localStorage.removeItem('abe_toured_' + p);
    });
    startTour();
  },
};

// Boot after page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 600); });
} else {
  setTimeout(init, 600);
}

})();
