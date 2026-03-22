// ═══════════════════════════════════════════════════════════════════════════════
// ABE Platform + AI Lead Orchestration Framework
// User Tour Guide — SDR & Sales Manager Edition
// Built from: ABE_Platform_Features.docx + ALO_Feature_Addendum.docx
// All targets verified against actual HTML element IDs
// ═══════════════════════════════════════════════════════════════════════════════

const TOUR_CONFIG = {
  version: '2.0.0',
  platform: 'ABE AI Revenue Infrastructure',

  // ── Page → tour section mapping ───────────────────────────────────────────
  pageMap: {
    'dashboard.html':    'dashboard',
    'login.html':        'login',
    'gtm-strategy.html': 'gtm',
    'vault.html':        'vault',
    'leads.html':        'leads',
    'accounts.html':     'accounts',
    'report.html':       'report',
  },

  // ── Tour steps — targets are real HTML id/class values ───────────────────
  steps: {

    // ── 1. LOGIN (login.html) ──────────────────────────────────────────────
    login: [
      {
        id: 'login-tabs',
        target: '#tab-in',
        title: '🔐 Sign In / Sign Up Tabs',
        content: 'Toggle between Sign In and Sign Up. Min 8-char password enforced on registration. Supabase Auth handles JWT session management.',
        position: 'bottom'
      },
      {
        id: 'login-email',
        target: '#in-email',
        title: '📧 Work Email',
        content: 'Enter your work email. Press Enter to submit — no need to click the button. Auto-redirects to dashboard if a valid session already exists.',
        position: 'bottom'
      },
      {
        id: 'login-pass',
        target: '#in-pass',
        title: '🔑 Password',
        content: 'Show/Hide toggle on every password field. Friendly error messages translate all Supabase error codes: "Invalid credentials", "Too many attempts", etc.',
        position: 'bottom'
      },
      {
        id: 'login-submit',
        target: '#btn-in',
        title: '→ Authenticate',
        content: 'Loading spinner shows "Authenticating…" state. On success, auth-guard.js validates the JWT server-side before rendering any page — client-side bypass is impossible.',
        position: 'top'
      },
      {
        id: 'login-signup',
        target: '#btn-up',
        title: '📝 Self-Service Sign Up',
        content: 'No admin approval required — instant access. Password mismatch validation client-side. "Check email to confirm" shown on success.',
        position: 'top'
      }
    ],

    // ── 2. DASHBOARD / COMMAND CENTRE (dashboard.html) ────────────────────
    dashboard: [
      {
        id: 'dash-tabs',
        target: '#tab-live',
        title: '🧭 Command Center Tab',
        content: 'Two main views: Command Center (live pipeline) and Repository (saved leads). This is your daily working screen — import files, run AI analysis, monitor your pipeline.',
        position: 'bottom'
      },
      {
        id: 'dash-tab-saved',
        target: '#tab-saved',
        title: '🗂 Strategic Repository Tab',
        content: 'All leads you\'ve saved after AI analysis live here. Search, filter, export, track actions taken, and expand any lead to see full AI intelligence inline.',
        position: 'bottom'
      },
      {
        id: 'dash-nav',
        target: '#topnav',
        title: '🗺 Platform Navigation',
        content: 'Access all 5 modules from the top nav: Command Centre · Repository · GTM Strategy · Strategy Vault · Account Intelligence. LOCAL and SUPABASE save toggles sit here too.',
        position: 'bottom'
      },
      {
        id: 'dash-save-local',
        target: '#modeLocal',
        title: '💽 Local Save Toggle',
        content: 'When checked, leads are saved to localStorage — survives page refresh, works offline. Both Local and Supabase can be active simultaneously.',
        position: 'bottom'
      },
      {
        id: 'dash-save-cloud',
        target: '#modeCloud',
        title: '☁ Supabase Save Toggle',
        content: 'When checked, leads upsert to your Supabase leads table — synced across devices, user-scoped by JWT. on_conflict prevents duplicates on re-save.',
        position: 'bottom'
      },
      {
        id: 'dash-vault-grid',
        target: '#file-vault-grid',
        title: '🗂 Multi-File Data Vault',
        content: 'Every imported file is stored here as a named card showing file name and lead count. Click any card to load that file. Purple border marks the active file.',
        position: 'bottom'
      },
      {
        id: 'dash-vault-count',
        target: '#vault-count',
        title: '📁 Files Stored Count',
        content: 'Live count of all files in your vault. Use Merge Files to combine any two vault files. Delete a vault file with the ✕ button — saves in Repository are preserved.',
        position: 'bottom'
      },
      {
        id: 'dash-kpi-total',
        target: '#card-total-leads',
        title: '📊 Total Leads KPI',
        content: 'Real-time count of all leads in the currently loaded file. Updates instantly on file load or import.',
        position: 'bottom'
      },
      {
        id: 'dash-kpi-intent',
        target: '#card-high-intent',
        title: '🔥 High Intent Leads',
        content: 'Count of leads scoring ≥75%. The inline dropdown filters the Verified Leads table to show only that score tier — click the card to activate the filter.',
        position: 'bottom'
      },
      {
        id: 'dash-kpi-mapped',
        target: '#card-leads-mapped',
        title: '✅ Leads Mapped',
        content: 'Leads that have been analyzed and saved. Filterable by All / High / Medium / Low score tier. Tracks progression from raw import to actioned lead.',
        position: 'bottom'
      },
      {
        id: 'dash-kpi-pending',
        target: '#card-pending-review',
        title: '⏳ Pending Review',
        content: 'Analyzed leads not yet saved to Repository. Filterable by Analyzed / Unprocessed / All. Drives your daily prioritisation — this is what needs action today.',
        position: 'bottom'
      },
      {
        id: 'dash-intent-chart',
        target: '#intentScoreChart',
        title: '🍩 Intent Score Distribution',
        content: 'Doughnut chart showing High / Medium / Low intent split with legend. Updates on every file load and after each AI analysis run.',
        position: 'right'
      },
      {
        id: 'dash-funnel-chart',
        target: '#statusFunnelChart',
        title: '📊 Lead Status Funnel',
        content: 'Bar chart: Unprocessed → Analyzed → Mapped funnel stages. Shows exactly where leads are dropping off in your pipeline.',
        position: 'left'
      },
      {
        id: 'dash-source-chart',
        target: '#sourceFileChart',
        title: '🥧 Source File Distribution',
        content: 'Pie chart showing % of leads from each imported file. Essential when running campaigns from multiple lead sources simultaneously.',
        position: 'right'
      },
      {
        id: 'dash-activity-chart',
        target: '#timeActivityChart',
        title: '📅 7-Day Activity Chart',
        content: 'Line chart tracking daily AI analysis activity over the last 7 days. Tracks API calls, tokens used, and cache hits.',
        position: 'left'
      },
      {
        id: 'dash-heat-score',
        target: '#heat-avg-score',
        title: '🌡 Avg Intent Score',
        content: 'Mean ICP score across all loaded leads. The single most important quality indicator for any imported database.',
        position: 'top'
      },
      {
        id: 'dash-heat-intent',
        target: '#heat-high-intent',
        title: '% High Intent',
        content: 'Percentage of leads scoring ≥75. Combined with Avg Intent Score, tells you whether a database is worth processing at all.',
        position: 'top'
      },
      {
        id: 'dash-heat-conversion',
        target: '#heat-conversion',
        title: '🔄 Conversion Rate',
        content: 'Mapped leads ÷ Analyzed leads — tracks how efficiently analyzed leads are being actioned and saved.',
        position: 'top'
      },
      {
        id: 'dash-heat-pending',
        target: '#heat-pending',
        title: '⏳ Pending Ratio',
        content: 'Unactioned leads as % of total. High pending ratio = backlog building up. Use Bulk Analyze to clear it fast.',
        position: 'top'
      },
      {
        id: 'dash-intel-layer',
        target: '#intel-visual-layer',
        title: '🔬 Lead Intelligence Tables',
        content: 'Two tables: Raw Leads (Name, Title, Company, LinkedIn) and Verified Leads (Name, Company, Score %, Analyze button). Score colour-coded: green ≥75, amber ≥50, red <50.',
        position: 'top'
      },
      {
        id: 'dash-bulk-analyze',
        target: '#analyzeAllBtn',
        title: '⚡ Bulk Analyze Intel',
        content: 'Processes 5 leads simultaneously per batch using Promise.allSettled — ~5x faster than sequential. Skips already-analyzed leads. Progress bar + Stop button visible during run.',
        position: 'top'
      },
      {
        id: 'dash-bulk-progress',
        target: '#bulkProgressBar',
        title: '📊 Bulk Progress Bar',
        content: 'Live animated bar showing % complete during bulk analysis. "Analyzing X / Y leads…" status text updates per batch. Stop button halts after current batch finishes.',
        position: 'top'
      },
      {
        id: 'dash-bulk-stop',
        target: '#bulkStopBtn',
        title: '⏹ Stop Bulk Analysis',
        content: 'Graceful stop — never cuts mid-batch. Sets a flag that breaks the loop after the current 5-lead batch completes. Shows exact count of completed leads on stop.',
        position: 'top'
      },
      {
        id: 'dash-architecture',
        target: '#architecture',
        title: '🏛 Automation Architecture',
        content: '5-step vision pipeline: Capture → Enrich → Score → Route → Outreach. Shows the full capability roadmap — webhook ingestion, Apollo/Clearbit enrichment, CRM routing, Smartlead sequencing.',
        position: 'top'
      },
      {
        id: 'dash-ai-modal-pain',
        target: '#painArea',
        title: '🔴 AI Modal — Pain Area',
        content: 'When you click Analyze on any lead, the AI identifies the specific business pain based on title, company, and role context. This is the hook for your outreach.',
        position: 'top'
      },
      {
        id: 'dash-ai-modal-insight',
        target: '#keyInsight',
        title: '🟡 AI Modal — Key Strategic Insight',
        content: 'Strategic insight: market context, competitive pressure, growth signals for this specific prospect. Shown in amber — the "why now" for your outreach.',
        position: 'top'
      },
      {
        id: 'dash-ai-modal-solution',
        target: '#proposedSolution',
        title: '🟣 AI Modal — Proposed Solution',
        content: 'ABE\'s recommended solution approach tailored to this lead\'s pain area and company context. Shown in purple — the "what to offer" for your call.',
        position: 'top'
      },
      {
        id: 'dash-ai-modal-outreach',
        target: '#outreachMsg',
        title: '🔵 AI Modal — Cold Outreach Draft',
        content: 'Ready-to-use personalised cold outreach message. Based on all 3 panels above. Copy and send immediately or refine with the Custom Prompt editor.',
        position: 'top'
      },
      {
        id: 'dash-ai-custom-prompt',
        target: '#customPrompt',
        title: '✨ Custom Prompt Editor',
        content: 'Write any refinement: "Focus on SaaS pain points", "Rewrite outreach more casually", "Emphasize ROI angle". Re-Analyze regenerates all 4 panels with your instruction.',
        position: 'top'
      },
      {
        id: 'dash-chat',
        target: '#chatHistory',
        title: '🤖 AI Chat Interface',
        content: 'Conversational follow-up panel — right side of the AI modal. Type refinements in the chat input for iterative AI responses without losing the 4-panel output.',
        position: 'left'
      },
      {
        id: 'dash-chat-input',
        target: '#chatInput',
        title: '💬 Chat Input',
        content: 'Type any follow-up: "Make it shorter", "Focus on CHRO pain points", "Add a P.S. line". Each chat turn sends full lead context to the AI engine.',
        position: 'top'
      },
      {
        id: 'dash-save-btn',
        target: '#saveAnalysisBtn',
        title: '💾 Save Strategy Button',
        content: 'Saves this lead + all 4 AI panels to the Strategic Repository. Respects Local/Supabase toggle. Upserts on re-save — no duplicates ever created.',
        position: 'top'
      },
      {
        id: 'dash-repo-search',
        target: '#repoSearch',
        title: '🔍 Repository Live Search',
        content: 'Search across Name, Company, Source File, Status, and Tags simultaneously. Fires on every keystroke — no submit needed.',
        position: 'bottom'
      },
      {
        id: 'dash-repo-table',
        target: '#saved-leads-table',
        title: '📋 Strategic Repository Table',
        content: 'All saved leads with: Score %, Source File, Status badge, Actions Taken dropdown (10 CRM-style options), Updated timestamp. Expand any row to see full AI intel inline.',
        position: 'top'
      },
      {
        id: 'dash-save-mapped',
        target: '#saveMappedBtn',
        title: '✅ Save Mapped Lead',
        content: 'Saves the currently viewed lead as "Mapped" status — the final stage in the pipeline indicating it\'s been processed and actioned.',
        position: 'top'
      }
    ],

    // ── 3. GTM STRATEGY BUILDER (gtm-strategy.html) ───────────────────────
    gtm: [
      {
        id: 'gtm-company',
        target: '#company-input',
        title: '🏢 Company Input',
        content: 'Enter the target company name here. Combined with the website URL for auto-extraction, this seeds all 6 AI steps with accurate context.',
        position: 'bottom'
      },
      {
        id: 'gtm-industry',
        target: '#industry-input',
        title: '🏭 Industry Input',
        content: 'Specify the company\'s industry to sharpen ICP modeling and TAM sizing. The AI uses this to select relevant competitors and market benchmarks.',
        position: 'bottom'
      },
      {
        id: 'gtm-step-1',
        target: '#card-1',
        title: '1️⃣ Step 1 — Market Research',
        content: 'AI analyses company website (auto-extracted), overview, market position, products/services, growth signals, tech stack hints. Produces GTM Relevance Score with reasoning.',
        position: 'right'
      },
      {
        id: 'gtm-body-1',
        target: '#body-1',
        title: '📄 Step 1 Output',
        content: 'Market Research output renders here. Includes company overview, GTM fit score, market position, product summary, and growth signals — all sourced from the live website.',
        position: 'right'
      },
      {
        id: 'gtm-step-2',
        target: '#card-2',
        title: '2️⃣ Step 2 — TAM Mapping',
        content: 'Total Addressable Market sizing with segment breakdown, market sizing methodology, growth projections, and competitive landscape overview.',
        position: 'right'
      },
      {
        id: 'gtm-step-3',
        target: '#card-3',
        title: '3️⃣ Step 3 — ICP Modeling',
        content: 'Ideal Customer Profile: firmographics, decision maker titles, core pain points, buying triggers, objections, primary ICP summary. Saved to icp_profiles table for lead scoring.',
        position: 'right'
      },
      {
        id: 'gtm-step-4',
        target: '#card-4',
        title: '4️⃣ Step 4 — Account Sourcing',
        content: 'Target account database recommendations, filtering criteria, account tiers, and sourcing strategy per ICP segment. Tells you exactly where to find your buyers.',
        position: 'right'
      },
      {
        id: 'gtm-step-5',
        target: '#card-5',
        title: '5️⃣ Step 5 — Keyword Generation',
        content: 'Boolean search strings, LinkedIn search queries, and keyword clusters for finding target accounts. Ready to paste directly into LinkedIn Sales Navigator.',
        position: 'right'
      },
      {
        id: 'gtm-step-6',
        target: '#card-6',
        title: '6️⃣ Step 6 — Messaging Creation',
        content: 'Full email sequence (subject, body, CTA), LinkedIn connection note, follow-up cadence — all tailored to this specific company and ICP. Ready to deploy.',
        position: 'right'
      },
      {
        id: 'gtm-token-counter',
        target: '#token-counter',
        title: '📊 Token Counter',
        content: 'Live token count per step and running total. Tracks API spend in real time. KV cache means repeated runs for the same company cost zero tokens for cached steps.',
        position: 'bottom'
      },
      {
        id: 'gtm-progress',
        target: '#main-progress-fill',
        title: '📈 Strategy Progress Bar',
        content: 'Visual progress across all 6 steps. Each completed step updates the fill. Use the step navigation sidebar to jump to any completed step.',
        position: 'bottom'
      },
      {
        id: 'gtm-bulk-zone',
        target: '#bulk-upload-zone',
        title: '⚡ Bulk GTM Generator',
        content: 'Upload a CSV of up to 10 companies. AI runs all 6 steps on each company sequentially. Progress shown per company. All saved to Strategy Vault automatically.',
        position: 'right'
      },
      {
        id: 'gtm-bulk-run',
        target: '#bulk-run-btn',
        title: '▶ Run Bulk Strategy',
        content: 'Starts the bulk engine. Each company gets a full 6-step GTM strategy. Auto-retry on parse errors. Crash-safe — auto-saves after every completed step.',
        position: 'top'
      },
      {
        id: 'gtm-bulk-stop',
        target: '#bulk-stop-btn',
        title: '⏹ Stop Bulk Run',
        content: 'Gracefully stops bulk generation after the current company\'s active step completes. All completed strategies remain saved in the vault.',
        position: 'top'
      },
      {
        id: 'gtm-export-modal',
        target: '#exportModal',
        title: '📄 Export PDF Modal',
        content: 'Selective PDF export — choose which of the 6 steps to include via checkboxes. Only exports the sections you need for a specific proposal or meeting.',
        position: 'top'
      },
      {
        id: 'gtm-api-modal',
        target: '#apiModal',
        title: '⚙ API Key Config',
        content: 'Configure your own OpenAI API key here. Stored securely — never exposed in the DOM. The pluggable AI architecture supports OpenAI, Claude, or any compatible endpoint.',
        position: 'top'
      },
      {
        id: 'gtm-logs',
        target: '#exec-logs-panel',
        title: '📋 Execution Logs',
        content: 'Real-time log of every AI call, token count, cache hit, and error. Essential for debugging and understanding cost per step.',
        position: 'left'
      }
    ],

    // ── 4. STRATEGY VAULT (vault.html) ────────────────────────────────────
    vault: [
      {
        id: 'vault-stats',
        target: '#stat-total',
        title: '📊 Vault Stats Bar',
        content: '4 live stat cards: Total Strategies, Complete count, Average GTM Score, Total Tokens Used. All update in real time as strategies are added or deleted.',
        position: 'bottom'
      },
      {
        id: 'vault-complete',
        target: '#stat-complete',
        title: '✅ Complete Strategies',
        content: 'Count of strategies where all 6 steps have been successfully generated. These are ready for Lead Manager push or PDF export.',
        position: 'bottom'
      },
      {
        id: 'vault-avg-score',
        target: '#stat-avg-score',
        title: '🎯 Average GTM Score',
        content: 'Mean GTM Relevance Score across all strategies in the vault. Gives you an instant read on the overall quality of your target account universe.',
        position: 'bottom'
      },
      {
        id: 'vault-tokens',
        target: '#stat-tokens',
        title: '💰 Total Tokens Used',
        content: 'Cumulative API tokens consumed across all strategy runs. Multiply by your model cost to track total USD spend. KV cache keeps this low on repeated runs.',
        position: 'bottom'
      },
      {
        id: 'vault-search',
        target: '#search-input',
        title: '🔍 Search Strategies',
        content: 'Real-time search by company name or industry. Debounced — fires 300ms after typing stops. Combine with the Status filter for precise vault navigation.',
        position: 'bottom'
      },
      {
        id: 'vault-filter',
        target: '#filter-status',
        title: '🔽 Status Filter',
        content: 'Filter by Complete / In Progress / Archived. Combinable with search. "In Progress" shows strategies where the run stopped mid-way — resume them with one click.',
        position: 'bottom'
      },
      {
        id: 'vault-grid',
        target: '#vault-grid',
        title: '🃏 Strategy Cards',
        content: 'Each strategy card shows: company name, industry, GTM Score (colour-coded HIGH/MED/LOW), steps completed, TAM size, token count, primary ICP, status badge, and date.',
        position: 'top'
      },
      {
        id: 'vault-select-all',
        target: '#vault-select-all-btn',
        title: '☐ Select All / Deselect All',
        content: 'Toggle all visible cards checked/unchecked. Activates the bulk action bar with Send to Lead Manager and Delete options.',
        position: 'bottom'
      },
      {
        id: 'vault-bulk-bar',
        target: '#vault-bulk-bar',
        title: '⚡ Bulk Action Bar',
        content: 'Appears when any card is selected. Send all selected strategies to Lead Manager in one click — processes sequentially, reports sent/duplicate/failed count via toast.',
        position: 'top'
      },
      {
        id: 'vault-bulk-monitor',
        target: '#btn-bulk-monitor',
        title: '→ Bulk Send to Lead Manager',
        content: 'Pushes all selected strategies to Lead Manager carrying their GTM Score directly — no rescoring. Server-side dedup prevents duplicate rows.',
        position: 'top'
      },
      {
        id: 'vault-drawer',
        target: '#strategy-drawer',
        title: '📖 Strategy Drawer',
        content: 'Click any card to open the full strategy drawer. Shows all 6 steps in expandable sections. Copy to clipboard, PDF export, Re-run, and Send to Lead Manager all available inside.',
        position: 'left'
      },
      {
        id: 'vault-pdf-btn',
        target: '#pdf-generate-btn',
        title: '📄 Export Full Report',
        content: 'Opens report.html with the complete 6-step formatted report for this account. Printable. PDF export button in both header and footer.',
        position: 'top'
      },
      {
        id: 'vault-pdf-modal',
        target: '#pdf-modal',
        title: '📋 PDF Section Selector',
        content: 'Choose which of the 6 steps to include in the PDF export. Section checkboxes let you tailor the output for a specific audience — e.g. just ICP + Messaging for an SDR.',
        position: 'top'
      },
      {
        id: 'vault-intel-alert',
        target: '#intel-alert-bar',
        title: '🔔 Intelligence Alert',
        content: 'If Account Intelligence has flagged HOT signals for a company in your vault, an alert bar appears on their card — direct link between buying signals and your strategy.',
        position: 'bottom'
      }
    ],

    // ── 5. LEAD MANAGER (leads.html) ──────────────────────────────────────
    leads: [
      {
        id: 'leads-stats-total',
        target: '#s-total',
        title: '📊 Stats Bar — Total Leads',
        content: 'Live count of all leads in Lead Manager across all files and import sources. Updates in real time as leads are imported, scored, or deleted.',
        position: 'bottom'
      },
      {
        id: 'leads-stats-high',
        target: '#s-high',
        title: '🔥 High Priority Count',
        content: 'Leads with priority = HIGH (ICP score ≥75). This is your daily call list — start here every morning.',
        position: 'bottom'
      },
      {
        id: 'leads-stats-analyzed',
        target: '#s-analyzed',
        title: '✅ Analyzed Count',
        content: 'Leads with status "analyzed" or "mapped" — processed and ready for outreach. Track this against Total to know your pipeline coverage.',
        position: 'bottom'
      },
      {
        id: 'leads-stats-outreach',
        target: '#s-outreach',
        title: '✉ Outreach Sent',
        content: 'Leads where outreach_status = sent or replied. The activity metric — are you actually sending the messages the AI is generating?',
        position: 'bottom'
      },
      {
        id: 'leads-stats-replied',
        target: '#s-replied',
        title: '💬 Replied',
        content: 'Leads who have replied to outreach. The money metric. Track sent → replied conversion rate to measure message quality.',
        position: 'bottom'
      },
      {
        id: 'leads-import-zone',
        target: '#drop-zone',
        title: '📥 CSV Import Drop Zone',
        content: 'Drag and drop or click to upload any CSV of contacts. AI auto-maps column headers to standard fields — works even if your columns are named differently.',
        position: 'bottom'
      },
      {
        id: 'leads-file-input',
        target: '#csv-file',
        title: '📁 File Input',
        content: 'Upload CSV files here. AI schema detection (GPT-4o-mini) maps non-standard column names automatically. Falls back to fuzzy matching if AI fails — import never blocks.',
        position: 'bottom'
      },
      {
        id: 'leads-filter-priority',
        target: '#filter-priority',
        title: '🎯 Priority Filter',
        content: 'Filter by HIGH (≥75) / MEDIUM (50–74) / LOW (<50) ICP fit score. Use HIGH daily to focus on your best leads first.',
        position: 'bottom'
      },
      {
        id: 'leads-filter-intent',
        target: '#filter-intent',
        title: '⚡ Intent Filter',
        content: 'Filter by HIGH (≥60) / MEDIUM (30–59) / LOW (<30) intent. For vault leads, intent is derived from the GTM Score when intent_score is absent.',
        position: 'bottom'
      },
      {
        id: 'leads-filter-status',
        target: '#filter-status',
        title: '📋 Status Filter',
        content: 'Filter by Unprocessed / Analyzed / Mapped pipeline stage. "Unprocessed" = imported but not yet scored. Use this to find leads still needing attention.',
        position: 'bottom'
      },
      {
        id: 'leads-filter-outreach',
        target: '#filter-outreach',
        title: '✉ Outreach Filter',
        content: 'Filter by Not Sent / Sent / Replied. Cross with Priority filter to find HIGH priority leads you haven\'t reached out to yet.',
        position: 'bottom'
      },
      {
        id: 'leads-filter-file',
        target: '#filter-file',
        title: '📁 Source File Filter',
        content: 'Filter leads by which import file they came from. Dropdown auto-populates with all distinct source files — essential when running multiple campaigns.',
        position: 'bottom'
      },
      {
        id: 'leads-search',
        target: '#search',
        title: '🔍 Live Search',
        content: 'Real-time search across name, company, and email simultaneously. Combine with filters for surgical lead lookup.',
        position: 'bottom'
      },
      {
        id: 'leads-table',
        target: '#leads-body',
        title: '📋 Leads Table',
        content: 'ICP Score (colour-coded), Intent (HIGH/MED/LOW), Priority, Status badge, Outreach badge, Score/GTM lock button, Outreach button, Delete. Vault leads show 🔒 GTM Score locked.',
        position: 'top'
      },
      {
        id: 'leads-score-btn',
        target: '#score-btn',
        title: '⚡ Score Button',
        content: 'CSV leads: click to run deterministic ICP scoring (5 dimensions). Vault leads show 🔒 GTM badge instead — their score is locked and protected from overwrite.',
        position: 'top'
      },
      {
        id: 'leads-outreach-btn',
        target: '#outreach-btn',
        title: '✉ Generate Outreach',
        content: 'Before outreach: purple ✉ button generates hyper-personalised email + LinkedIn note using GTM context. After saving: becomes green 📧 locked icon.',
        position: 'top'
      },
      {
        id: 'leads-bulk-bar',
        target: '#bulk-bar',
        title: '⚡ Bulk Action Bar',
        content: 'Select any rows to activate. Bulk Score (vault leads auto-excluded), Bulk Export CSV, Bulk Delete. Row-level checkboxes + Select All header checkbox.',
        position: 'top'
      },
      {
        id: 'leads-select-all',
        target: '#select-all',
        title: '☐ Select All Checkbox',
        content: 'Select or deselect all visible leads in one click. Activates the bulk action bar. Use with filters to bulk-score only Unprocessed HIGH priority leads.',
        position: 'top'
      },
      {
        id: 'leads-drawer',
        target: '#lead-drawer',
        title: '📋 Lead Detail Drawer',
        content: 'Click any lead row to open the full detail drawer. Two tabs: Details (full profile + AI score breakdown + notes + status buttons) and Outreach (email + LinkedIn copy).',
        position: 'left'
      },
      {
        id: 'leads-drawer-tabs',
        target: '#tab-details',
        title: '📑 Details & Outreach Tabs',
        content: 'Details tab: name, title, company, email, LinkedIn, location, industry, ICP score, priority, notes. Outreach tab: generated email and LinkedIn note with copy buttons.',
        position: 'bottom'
      },
      {
        id: 'leads-drawer-score',
        target: '#btn-drawer-score',
        title: '⚡ Score from Drawer',
        content: 'Score individual lead directly from the detail drawer. Vault leads show 🔒 GTM Score Locked badge instead — no overwrite possible.',
        position: 'top'
      },
      {
        id: 'leads-drawer-outreach',
        target: '#btn-drawer-outreach',
        title: '📧 View / Regenerate Outreach',
        content: 'If outreach exists: shows "📧 View / Regenerate" in green. If not: "✉ Generate Outreach" in purple. Regeneration replaces the previous message.',
        position: 'top'
      },
      {
        id: 'leads-drawer-save',
        target: '#btn-save-outreach',
        title: '💾 Save Outreach + Auto-Close',
        content: 'Saving outreach locks the mail icon to 📧 in the table row, shows success toast, then auto-closes the drawer after 1.2 seconds. Smooth single-lead workflow.',
        position: 'top'
      },
      {
        id: 'leads-pagination',
        target: '#pagination',
        title: '📄 Pagination',
        content: 'Paginated lead table — handles thousands of leads without performance issues. Page info shows current range. Prev/Next controls keep the view clean.',
        position: 'top'
      }
    ],

    // ── 6. ACCOUNT INTELLIGENCE (accounts.html) ───────────────────────────
    accounts: [
      {
        id: 'acc-stats-hot',
        target: '#stat-hot',
        title: '🔥 HOT Accounts',
        content: 'Count of accounts with intent score ≥60. These are showing active buying signals right now — prioritise outreach to HOT accounts above all others.',
        position: 'bottom'
      },
      {
        id: 'acc-stats-signals',
        target: '#stat-signals',
        title: '⚡ Signals (7 Days)',
        content: 'Total intent signals detected across all tracked companies in the last 7 days. Spike here = buying activity is increasing in your target universe.',
        position: 'bottom'
      },
      {
        id: 'acc-stats-reply',
        target: '#stat-reply',
        title: '💬 Reply Rate',
        content: 'Outreach reply rate from Lead Manager data — bridges intent signals with actual outreach performance.',
        position: 'bottom'
      },
      {
        id: 'acc-stats-meetings',
        target: '#stat-meetings',
        title: '📅 Meetings Booked',
        content: 'Meetings booked from outreach tracked in Lead Manager. The ultimate downstream metric for intent signal quality.',
        position: 'bottom'
      },
      {
        id: 'acc-search',
        target: '#search',
        title: '🔍 Search Accounts',
        content: 'Real-time search across account names. Combine with the Tier filter to find all HOT accounts in a specific segment.',
        position: 'bottom'
      },
      {
        id: 'acc-tier-filter',
        target: '#tier-filter',
        title: '🔥 Intent Tier Filter',
        content: 'Filter by HOT (≥60) / WARM (30–59) / COLD (<30). Focus your day on HOT accounts — they\'re signalling buying intent right now.',
        position: 'bottom'
      },
      {
        id: 'acc-sort',
        target: '#sort-filter',
        title: '🔽 Sort Options',
        content: 'Sort by Intent Score or Signal Count. Sort by Signal Count to find accounts generating the most activity — highest engagement = highest priority.',
        position: 'bottom'
      },
      {
        id: 'acc-grid',
        target: '#accounts-grid',
        title: '🃏 Account Cards',
        content: 'Each card: company name, industry, intent score ring, tier badge (HOT/WARM/COLD), signal type chips, signal count, last signal date. 8 signal types tracked.',
        position: 'top'
      },
      {
        id: 'acc-drawer',
        target: '#drawer',
        title: '📖 Account Detail Drawer',
        content: 'Click any account to open the full intelligence drawer. Shows: intent score, avg ICP score, touchpoints, signal history with recency decay, recommended actions, activity timeline.',
        position: 'left'
      },
      {
        id: 'acc-scan-btn',
        target: '#scan-btn-drawer',
        title: '🔍 Scan Signals',
        content: 'Triggers website analysis for this company. Detects 8 signal types: Hiring Growth, Product Launch, Tech Adoption, Content Activity, Website Change, Funding, Leadership Change, Expansion.',
        position: 'top'
      },
      {
        id: 'acc-gtm-btn',
        target: '#gtm-btn-drawer',
        title: '⚡ Open GTM Strategy',
        content: 'One click to open or resume the GTM Strategy for this account. Finds existing strategy in vault automatically — no duplicate strategies created.',
        position: 'top'
      }
    ],

    // ── 7. REPORT PAGE (report.html) ──────────────────────────────────────
    report: [
      {
        id: 'report-nav',
        target: '#topnav',
        title: '📄 Strategy Report Page',
        content: 'Full formatted 6-step GTM strategy report for a single account. Opened from Strategy Vault. Printable and PDF-exportable. Each section is expandable.',
        position: 'bottom'
      },
      {
        id: 'report-content',
        target: '#report-content',
        title: '📋 Report Content',
        content: 'All 6 steps rendered: Market Research, TAM Mapping, ICP Profile, Account Sourcing, Keywords, Outreach Messaging. Arrays rendered as visual tag chips. Emails as formatted cards.',
        position: 'top'
      },
      {
        id: 'report-sections',
        target: '#sections-container',
        title: '📑 Expandable Sections',
        content: 'Each of the 6 strategy sections is individually expandable. Growth signals, tech stack, buying triggers, and decision maker lists render as coloured tag chips.',
        position: 'top'
      },
      {
        id: 'report-export-top',
        target: '#btn-export',
        title: '⬇ Export PDF (Header)',
        content: 'PDF export in the page header. Same section-selection modal as the vault — choose which steps to include. Two export buttons (header + footer) for accessibility.',
        position: 'bottom'
      },
      {
        id: 'report-export-bottom',
        target: '#btn-export2',
        title: '⬇ Export PDF (Footer)',
        content: 'Duplicate PDF export button in the page footer — so you never have to scroll back to the top after reading the full report.',
        position: 'top'
      },
      {
        id: 'report-score',
        target: '#r-score',
        title: '🎯 GTM Score',
        content: 'The GTM Relevance Score for this account — generated in Step 1 Market Research. Colour-coded HIGH/MED/LOW. This score flows into Lead Manager when you push from vault.',
        position: 'bottom'
      },
      {
        id: 'report-tam',
        target: '#r-tam',
        title: '💰 TAM Size',
        content: 'Total Addressable Market figure from Step 2. Used on the Strategy Vault card and in bulk filtering to prioritise accounts by market opportunity.',
        position: 'bottom'
      }
    ]

  }, // end steps

  // ── State ─────────────────────────────────────────────────────────────────
  currentStep: 0,
  tourActive: false,
  completedSteps: [],

  // ── Methods ───────────────────────────────────────────────────────────────

  init: function () {
    this.injectStyles();
    this.loadState();
    this.injectButton();
    this.bindKeys();
  },

  injectStyles: function () {
    if (document.getElementById('abe-tour-css')) return;
    const s = document.createElement('style');
    s.id = 'abe-tour-css';
    s.textContent = [
      '@keyframes abe-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes abe-pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}',
      '@keyframes abe-slide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
      '#abe-overlay{animation:abe-fade .2s ease-out}',
      '#abe-tooltip{animation:abe-pop .25s cubic-bezier(.34,1.56,.64,1)}',
      '.abe-toast{animation:abe-slide .3s ease-out}',
    ].join('');
    document.head.appendChild(s);
  },

  loadState: function () {
    try {
      const s = JSON.parse(localStorage.getItem('abe_tour_v2') || '{}');
      this.completedSteps = s.completedSteps || [];
      this.currentStep    = typeof s.currentStep === 'number' ? s.currentStep : 0;
    } catch (e) {}
  },

  saveState: function () {
    try {
      localStorage.setItem('abe_tour_v2', JSON.stringify({
        completedSteps: this.completedSteps,
        currentStep: this.currentStep,
        ts: Date.now()
      }));
    } catch (e) {}
  },

  injectButton: function () {
    const nav = document.querySelector('#topnav') || document.querySelector('nav');
    if (!nav || document.getElementById('abe-tour-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'abe-tour-btn';
    btn.textContent = '✨ Tour';
    btn.style.cssText = [
      'background:linear-gradient(135deg,#a855f7,#7c3aed)',
      'color:#fff',
      'border:none',
      'border-radius:7px',
      'padding:6px 14px',
      'font-size:10px',
      'font-weight:800',
      'letter-spacing:.08em',
      'text-transform:uppercase',
      'cursor:pointer',
      'margin-left:10px',
      'font-family:inherit',
    ].join(';');
    btn.onclick = function () { TOUR_CONFIG.start(); };
    nav.appendChild(btn);
  },

  bindKeys: function () {
    document.addEventListener('keydown', function (e) {
      if (!TOUR_CONFIG.tourActive) return;
      if (e.key === 'Escape')                   TOUR_CONFIG.end();
      if (e.shiftKey && e.key === 'ArrowRight') TOUR_CONFIG.next();
      if (e.shiftKey && e.key === 'ArrowLeft')  TOUR_CONFIG.prev();
    });
  },

  getPage: function () {
    const p = window.location.pathname;
    for (const [file, key] of Object.entries(this.pageMap)) {
      if (p.includes(file)) return key;
    }
    return 'dashboard'; // default — dashboard is the real landing page after login
  },

  start: function () {
    const page  = this.getPage();
    const steps = this.steps[page];
    if (!steps || !steps.length) {
      this.toast('No tour available for this page.', 'info');
      return;
    }
    this.tourActive  = true;
    this.currentStep = 0;
    this.saveState();
    this.render();
  },

  render: function () {
    const page  = this.getPage();
    const steps = this.steps[page];
    if (!this.tourActive || !steps || this.currentStep >= steps.length) {
      this.end();
      return;
    }
    this.cleanup();
    const step = steps[this.currentStep];

    // Overlay
    const ov = document.createElement('div');
    ov.id = 'abe-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.72);backdrop-filter:blur(3px)';
    ov.onclick = function () { TOUR_CONFIG.end(); };
    document.body.appendChild(ov);

    // Tooltip
    const tt = document.createElement('div');
    tt.id = 'abe-tooltip';
    tt.style.cssText = [
      'position:fixed',
      'width:380px',
      'max-width:calc(100vw - 32px)',
      'z-index:10000',
      'background:#0F1420',
      'border:1px solid rgba(168,85,247,.4)',
      'border-radius:14px',
      'padding:18px 20px 14px',
      'box-shadow:0 20px 60px rgba(0,0,0,.7)',
      'font-family:Inter,sans-serif',
    ].join(';');
    tt.innerHTML = [
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">',
        '<div>',
          '<div style="font-size:9px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#a855f7;margin-bottom:4px">',
            (this.currentStep + 1) + ' / ' + steps.length,
          '</div>',
          '<div style="font-size:13px;font-weight:800;color:#fff;letter-spacing:-.2px">' + step.title + '</div>',
        '</div>',
        '<button id="abe-tt-close" style="background:none;border:none;color:#6b7280;font-size:18px;cursor:pointer;line-height:1;padding:0;margin-left:12px;flex-shrink:0">×</button>',
      '</div>',
      '<p style="font-size:12px;line-height:1.65;color:#9ca3af;margin:0 0 14px">' + step.content + '</p>',
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">',
        '<button id="abe-tt-prev" style="padding:6px 14px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-radius:7px;cursor:pointer;border:1px solid #1f2937;background:transparent;color:#6b7280;font-family:inherit">← Prev</button>',
        '<a href="#" id="abe-tt-skip" style="font-size:10px;color:#4b5563;text-decoration:none">Skip</a>',
        '<button id="abe-tt-next" style="padding:6px 14px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-radius:7px;cursor:pointer;border:none;background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;font-family:inherit">Next →</button>',
      '</div>',
    ].join('');
    document.body.appendChild(tt);

    // Wire buttons
    document.getElementById('abe-tt-close').onclick = function () { TOUR_CONFIG.end(); };
    document.getElementById('abe-tt-skip').onclick  = function (e) { e.preventDefault(); TOUR_CONFIG.end(); };
    document.getElementById('abe-tt-prev').onclick  = function () { TOUR_CONFIG.prev(); };
    document.getElementById('abe-tt-next').onclick  = function () { TOUR_CONFIG.next(); };

    // Highlight + position
    this.highlight(step.target, step.position);
    this.scrollTo(step.target);

    if (!this.completedSteps.includes(step.id)) this.completedSteps.push(step.id);
    this.saveState();
  },

  highlight: function (selector, position) {
    const el = document.querySelector(selector);
    const tt = document.getElementById('abe-tooltip');
    if (!tt) return;

    if (!el) {
      // Element not found — skip to next step gracefully
      const page  = this.getPage();
      const total = (this.steps[page] || []).length;
      this.currentStep++;
      if (this.currentStep < total) { this.render(); } else { this.end(); }
      return;
    }

    const r  = el.getBoundingClientRect();
    const TW = 380, TH = 170, G = 14, M = 14;

    // Elevate target above overlay
    el.setAttribute('data-tour-style', el.getAttribute('style') || '');
    el.style.position = el.style.position || 'relative';
    el.style.zIndex   = '9999';
    el.style.outline  = '2px solid #a855f7';
    el.style.outlineOffset = '3px';
    el.style.borderRadius  = '6px';

    // Position tooltip
    let top, left;
    switch (position) {
      case 'top':    top = r.top - TH - G;              left = r.left + r.width/2 - TW/2; break;
      case 'bottom': top = r.bottom + G;                left = r.left + r.width/2 - TW/2; break;
      case 'left':   top = r.top + r.height/2 - TH/2;  left = r.left - TW - G; break;
      case 'right':  top = r.top + r.height/2 - TH/2;  left = r.right + G; break;
      default:       top = r.bottom + G;                left = r.left + r.width/2 - TW/2;
    }
    top  = Math.max(M, Math.min(top,  window.innerHeight - TH - M));
    left = Math.max(M, Math.min(left, window.innerWidth  - TW - M));
    tt.style.top  = top  + 'px';
    tt.style.left = left + 'px';
  },

  scrollTo: function (selector) {
    const el = document.querySelector(selector);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  cleanup: function () {
    // Restore highlighted elements
    document.querySelectorAll('[data-tour-style]').forEach(function (el) {
      el.setAttribute('style', el.getAttribute('data-tour-style'));
      el.removeAttribute('data-tour-style');
    });
    const ov = document.getElementById('abe-overlay');
    const tt = document.getElementById('abe-tooltip');
    if (ov) ov.remove();
    if (tt) tt.remove();
  },

  next: function () {
    const steps = this.steps[this.getPage()] || [];
    if (this.currentStep < steps.length - 1) {
      this.currentStep++;
      this.saveState();
      this.render();
    } else {
      this.end();
      this.toast('🎉 Tour complete! You know the platform.', 'success');
    }
  },

  prev: function () {
    if (this.currentStep > 0) {
      this.currentStep--;
      this.saveState();
      this.render();
    }
  },

  end: function () {
    this.tourActive = false;
    this.cleanup();
    this.saveState();
  },

  toast: function (msg, type) {
    var ex = document.querySelector('.abe-toast');
    if (ex) ex.remove();
    var colors = { info: '#3b82f6', success: '#22c55e', error: '#ef4444' };
    var t = document.createElement('div');
    t.className = 'abe-toast';
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'right:24px',
      'background:#0f1420',
      'border:1px solid ' + (colors[type] || colors.info),
      'border-radius:10px',
      'padding:11px 16px',
      'font-size:11px',
      'font-weight:700',
      'color:#fff',
      'z-index:10001',
      'font-family:Inter,sans-serif',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s,transform .3s';
      t.style.opacity    = '0';
      t.style.transform  = 'translateY(6px)';
      setTimeout(function () { t.remove(); }, 300);
    }, 3000);
  }

};

// Bootstrap
document.addEventListener('DOMContentLoaded', function () { TOUR_CONFIG.init(); });

// Global aliases
window.TOUR_CONFIG = TOUR_CONFIG;
window.TOUR        = TOUR_CONFIG;
