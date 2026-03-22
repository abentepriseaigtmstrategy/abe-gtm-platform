// ═══════════════════════════════════════════════════════════════════════════
// ABE Platform — FAQ Chat Assistant
// Floating help widget · Powered by OpenAI via /api/analyze
// Include on all pages: <script src="faq-chat.js"></script>
// ═══════════════════════════════════════════════════════════════════════════

var ABE_FAQ = (function () {

  // ── Platform knowledge base injected as system prompt ──────────────────
  var SYSTEM_PROMPT = [
    'You are the ABE Platform Help Assistant — a friendly, concise expert on the ABE AI Revenue Infrastructure platform.',
    'Answer questions about platform features only. Be direct and specific. Max 3 sentences per answer unless a step-by-step is needed.',
    '',
    'PLATFORM OVERVIEW:',
    'ABE is a GTM (Go-To-Market) AI platform for SDRs, Sales Managers, and BD teams. It has 6 modules:',
    '1. Command Centre (dashboard.html) — import leads, run AI analysis, view KPI cards and charts',
    '2. GTM Strategy Builder (gtm-strategy.html) — 6-step AI strategy per company: Market Research, TAM, ICP, Account Sourcing, Keywords, Messaging',
    '3. Strategy Vault (vault.html) — store, search, export all GTM strategies. Push to Lead Manager.',
    '4. Lead Manager (leads.html) — import CSV leads, score them, generate personalised outreach, track actions',
    '5. Account Intelligence (accounts.html) — track 8 intent signal types per company, HOT/WARM/COLD tiers',
    '6. Report Page (report.html) — printable full GTM report for any vault strategy',
    '',
    'KEY FEATURES:',
    '- Bulk Analyze: processes 5 leads simultaneously, skips already-analyzed, shows live progress bar',
    '- AI Analysis Modal: generates Pain Area (red), Key Insight (amber), Proposed Solution (purple), Cold Outreach Draft (cyan) per lead',
    '- Custom Prompt Editor: refine any AI output with free-text instructions',
    '- Save Mode: LOCAL (localStorage) and SUPABASE (cloud) toggles — both can be active simultaneously',
    '- GTM Score: AI-generated relevance score per company — flows from Vault to Lead Manager without overwrite',
    '- ICP Score: 5-dimension scoring for leads — colour coded green ≥75, amber ≥50, red <50',
    '- Intent Signals: 8 types (Hiring Growth, Product Launch, Tech Adoption, Content Activity, Website Change, Funding, Leadership Change, Expansion). Recency decay after 14 days.',
    '- Bulk GTM Generator: upload CSV of up to 10 companies, AI runs all 6 steps on each',
    '- Export options: XLSX, CSV, PDF (jsPDF), Word from Repository; PDF with section selector from Vault',
    '- Data persistence: ab_fileRegistry, ab_savedLeads, ab_currentSourceFile in localStorage',
    '- Security: Supabase Auth JWT, Cloudflare Worker backend, API keys never in browser',
    '',
    'SCORING:',
    '- HIGH priority: ICP ≥75%, Intent ≥60',
    '- MEDIUM priority: ICP 50-74%, Intent 30-59',
    '- LOW priority: ICP <50%, Intent <30',
    '- HOT account: intent score ≥60',
    '- WARM account: intent score 30-59',
    '',
    'COMMON WORKFLOWS:',
    '- Import leads: Command Centre → click IMPORT → upload .xlsx or .csv → Execute Mapping → Bulk Analyze',
    '- Generate GTM strategy: GTM Strategy → enter company + industry → run all 6 steps → auto-saves to vault',
    '- Push account to Lead Manager: Strategy Vault → hover card → click LM button',
    '- Generate outreach for a lead: Lead Manager → click ✉ button on any lead → save → 📧 icon locks',
    '- Track buying signals: Account Intelligence → Add Company → Scan Signals → view HOT accounts',
    '',
    'If asked something not related to the ABE platform, politely redirect: "I can only help with ABE platform questions."',
  ].join('\n');

  // ── Quick-question chips shown in empty state ───────────────────────────
  var QUICK_QUESTIONS = [
    'How do I import leads?',
    'What is a GTM Score?',
    'How does Bulk Analyze work?',
    'What are intent signals?',
    'How do I export my leads?',
    'How do I generate outreach?',
    'What is the difference between ICP score and GTM score?',
    'How do I push a strategy to Lead Manager?',
    'What does the Tour button do?',
    'How does recency decay work?',
  ];

  // ── State ───────────────────────────────────────────────────────────────
  var isOpen    = false;
  var isLoading = false;
  var history   = []; // { role, content }
  var panel     = null;

  // ── Get Supabase JWT for API calls ──────────────────────────────────────
  function getToken() {
    return new Promise(function (resolve) {
      try {
        if (window.APP && window.APP.sb) {
          window.APP.sb.auth.getSession().then(function (r) {
            resolve((r.data && r.data.session && r.data.session.access_token) || '');
          }).catch(function () { resolve(''); });
        } else {
          resolve('');
        }
      } catch (e) { resolve(''); }
    });
  }

  // ── Call OpenAI via existing /api/analyze endpoint ──────────────────────
  // /api/analyze ignores custom system prompts — it only uses customPrompt as
  // the user message. So we embed our full knowledge base + the question inside
  // customPrompt and ask for a plain-text answer (not JSON).
  function callAI(userMsg) {
    isLoading = true;
    renderMessages();

    // Build conversation context from history (last 4 turns max to stay within token limit)
    var recentHistory = history.slice(-4);
    var historyText = recentHistory.length
      ? recentHistory.map(function(m){ return (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content; }).join('\n')
      : '';

    // Embed full platform knowledge + question into customPrompt
    // The server treats this as the user message to GPT-4o-mini
    var fullPrompt = SYSTEM_PROMPT
      + (historyText ? '\n\nPREVIOUS CONVERSATION:\n' + historyText : '')
      + '\n\nUSER QUESTION: ' + userMsg
      + '\n\nIMPORTANT: Reply in plain conversational text only. Do NOT return JSON. Do NOT use markdown headers. Keep your answer concise and helpful. If the question is not about the ABE platform, say: "I can only help with ABE platform questions."';

    getToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      fetch('/api/analyze', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          lead: { name: 'ABE FAQ User', title: 'Platform User', company: 'ABE Platform' },
          customPrompt: fullPrompt,
        }),
        signal: AbortSignal.timeout(30000),
      })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        isLoading = false;
        // /api/analyze returns parsed JSON from AI. Since we asked for plain text,
        // the AI may return a JSON object with one key, or a raw string.
        // Extract the most meaningful text value.
        var answer = extractAnswer(data, userMsg);
        history.push({ role: 'user',      content: userMsg });
        history.push({ role: 'assistant', content: answer  });
        renderMessages();
      })
      .catch(function (err) {
        isLoading = false;
        var errMsg = err.message && err.message.includes('429')
          ? '⚠️ Too many requests. Please wait a moment and try again.'
          : '⚠️ Could not reach the AI engine. Please check your connection and try again.';
        history.push({ role: 'user',      content: userMsg });
        history.push({ role: 'assistant', content: errMsg  });
        renderMessages();
      });
    });
  }

  // Extract the most meaningful plain-text value from the API response
  function extractAnswer(data, fallbackQ) {
    if (!data || typeof data === 'string') return data || 'No response received.';
    // If AI returned a plain answer key
    if (data.answer)  return data.answer;
    if (data.message) return data.message;
    if (data.response) return data.response;
    if (data.reply)   return data.reply;
    if (data.text)    return data.text;
    // /api/analyze 4-panel format — stitch together the most relevant panels
    var parts = [];
    if (data['Pain Area'])            parts.push(data['Pain Area']);
    if (data['Key Insight'])          parts.push(data['Key Insight']);
    if (data['Proposed Solution'])    parts.push(data['Proposed Solution']);
    if (data['Cold Outreach Message']) parts.push(data['Cold Outreach Message']);
    if (data.painArea)                parts.push(data.painArea);
    if (data.keyInsight)              parts.push(data.keyInsight);
    if (data.proposedSolution)        parts.push(data.proposedSolution);
    if (data.coldOutreachMessage)     parts.push(data.coldOutreachMessage);
    if (parts.length) return parts[0]; // return first/most relevant
    // Last resort: first string value in the object
    var vals = Object.values(data).filter(function(v){ return typeof v === 'string' && v.length > 5; });
    return vals.length ? vals[0] : 'I received a response but could not parse it. Please try rephrasing your question.';
  }

  // ── Direct OpenAI call (used if /api/analyze doesn\'t support faqMode) ──
  function callOpenAIDirect(userMsg) {
    isLoading = true;
    renderMessages();

    var messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    history.forEach(function (m) { messages.push(m); });
    messages.push({ role: 'user', content: userMsg });

    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: messages,
      }),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      isLoading = false;
      var answer = (data.content && data.content[0] && data.content[0].text) || 'Sorry, I could not generate an answer.';
      history.push({ role: 'user',      content: userMsg });
      history.push({ role: 'assistant', content: answer  });
      renderMessages();
    })
    .catch(function () {
      isLoading = false;
      history.push({ role: 'user',      content: userMsg });
      history.push({ role: 'assistant', content: '⚠️ Connection error. Please try again.' });
      renderMessages();
    });
  }

  // ── Render messages in the chat panel ───────────────────────────────────
  function renderMessages() {
    var body = document.getElementById('abe-faq-body');
    if (!body) return;

    if (history.length === 0 && !isLoading) {
      // Empty state — show quick question chips
      var chips = QUICK_QUESTIONS.map(function (q) {
        return '<button class="abe-faq-chip" onclick="ABE_FAQ.ask(' + JSON.stringify(q) + ')">' + q + '</button>';
      }).join('');
      body.innerHTML = [
        '<div style="padding:16px 14px 8px;text-align:center;">',
          '<div style="font-size:22px;margin-bottom:8px;">🤖</div>',
          '<div style="font-size:12px;font-weight:700;color:#e5e7eb;margin-bottom:4px;">ABE Platform Assistant</div>',
          '<div style="font-size:11px;color:#6b7280;margin-bottom:16px;">Ask me anything about the platform</div>',
          '<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;">' + chips + '</div>',
        '</div>',
      ].join('');
      return;
    }

    // Render conversation
    var html = history.map(function (m) {
      var isUser = m.role === 'user';
      return [
        '<div style="display:flex;justify-content:' + (isUser ? 'flex-end' : 'flex-start') + ';margin-bottom:10px;padding:0 12px;">',
          '<div style="',
            'max-width:82%;',
            'background:' + (isUser ? 'linear-gradient(135deg,#a855f7,#7c3aed)' : 'rgba(255,255,255,.06)') + ';',
            'color:#fff;',
            'border-radius:' + (isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px') + ';',
            'padding:10px 13px;',
            'font-size:12px;',
            'line-height:1.6;',
          '">',
            escHtml(m.content),
          '</div>',
        '</div>',
      ].join('');
    }).join('');

    if (isLoading) {
      html += [
        '<div style="display:flex;justify-content:flex-start;margin-bottom:10px;padding:0 12px;">',
          '<div style="background:rgba(255,255,255,.06);border-radius:14px 14px 14px 4px;padding:10px 14px;">',
            '<span style="display:inline-flex;gap:4px;">',
              '<span style="width:6px;height:6px;border-radius:50%;background:#a855f7;animation:abe-faq-dot 1s .0s infinite"></span>',
              '<span style="width:6px;height:6px;border-radius:50%;background:#a855f7;animation:abe-faq-dot 1s .2s infinite"></span>',
              '<span style="width:6px;height:6px;border-radius:50%;background:#a855f7;animation:abe-faq-dot 1s .4s infinite"></span>',
            '</span>',
          '</div>',
        '</div>',
      ].join('');
    }

    body.innerHTML = html;
    body.scrollTop = body.scrollHeight;
  }

  function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  }

  // ── Build the panel DOM ─────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('abe-faq-panel')) return;

    // Inject CSS
    if (!document.getElementById('abe-faq-css')) {
      var s = document.createElement('style');
      s.id = 'abe-faq-css';
      s.textContent = [
        '@keyframes abe-faq-in{from{opacity:0;transform:translateY(20px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}',
        '@keyframes abe-faq-dot{0%,80%,100%{transform:scale(0);opacity:.4}40%{transform:scale(1);opacity:1}}',
        '#abe-faq-panel{animation:abe-faq-in .25s cubic-bezier(.34,1.56,.64,1);}',
        '.abe-faq-chip{background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);color:#c4b5fd;border-radius:20px;',
          'padding:5px 11px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;}',
        '.abe-faq-chip:hover{background:rgba(168,85,247,.25);border-color:rgba(168,85,247,.5);color:#fff;}',
      ].join('');
      document.head.appendChild(s);
    }

    panel = document.createElement('div');
    panel.id = 'abe-faq-panel';
    panel.style.cssText = [
      'position:fixed',
      'bottom:100px',
      'right:28px',
      'width:340px',
      'max-width:calc(100vw - 40px)',
      'height:480px',
      'max-height:calc(100vh - 140px)',
      'background:#0d1120',
      'border:1px solid rgba(168,85,247,.3)',
      'border-radius:18px',
      'box-shadow:0 20px 60px rgba(0,0,0,.7)',
      'z-index:8001',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      'font-family:Inter,sans-serif',
    ].join(';');

    panel.innerHTML = [
      // Header
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0;">',
        '<div style="display:flex;align-items:center;gap:8px;">',
          '<div style="width:28px;height:28px;background:linear-gradient(135deg,#0ea5e9,#0284c7);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;">🤖</div>',
          '<div>',
            '<div style="font-size:11px;font-weight:800;color:#fff;">ABE Assistant</div>',
            '<div style="font-size:9px;color:#22c55e;font-weight:700;">● Online</div>',
          '</div>',
        '</div>',
        '<div style="display:flex;gap:6px;">',
          '<button onclick="ABE_FAQ.clear()" title="Clear chat" style="background:none;border:none;color:#4b5563;cursor:pointer;font-size:13px;padding:2px 5px;border-radius:5px;" onmouseenter="this.style.color=\'#9ca3af\'" onmouseleave="this.style.color=\'#4b5563\'">↺</button>',
          '<button onclick="ABE_FAQ.close()" style="background:none;border:none;color:#4b5563;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;border-radius:5px;" onmouseenter="this.style.color=\'#9ca3af\'" onmouseleave="this.style.color=\'#4b5563\'">×</button>',
        '</div>',
      '</div>',
      // Body
      '<div id="abe-faq-body" style="flex:1;overflow-y:auto;padding:8px 0;scrollbar-width:thin;scrollbar-color:#1f2937 transparent;"></div>',
      // Input row
      '<div style="padding:10px 12px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:8px;flex-shrink:0;">',
        '<input id="abe-faq-input" type="text" placeholder="Ask anything about ABE…" ',
          'style="flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:10px;',
          'color:#e5e7eb;font-size:12px;padding:9px 12px;outline:none;font-family:inherit;" ',
          'onkeydown="if(event.key===\'Enter\')ABE_FAQ.submit()" ',
          'onfocus="this.style.borderColor=\'rgba(168,85,247,.5)\'" ',
          'onblur="this.style.borderColor=\'rgba(255,255,255,.08)\'" />',
        '<button onclick="ABE_FAQ.submit()" ',
          'style="background:linear-gradient(135deg,#a855f7,#7c3aed);border:none;border-radius:10px;',
          'padding:9px 13px;color:#fff;font-size:13px;cursor:pointer;flex-shrink:0;transition:transform .1s;" ',
          'onmouseenter="this.style.transform=\'scale(1.05)\'" onmouseleave="this.style.transform=\'scale(1)\'">→</button>',
      '</div>',
    ].join('');

    document.body.appendChild(panel);
    renderMessages();

    // Focus input
    setTimeout(function () {
      var inp = document.getElementById('abe-faq-input');
      if (inp) inp.focus();
    }, 100);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  return {
    toggle: function () {
      if (isOpen) { this.close(); } else { this.open(); }
    },

    open: function () {
      isOpen = true;
      buildPanel();
      // Update chat button appearance
      var chatBtn = document.getElementById('abe-fab-chat');
      if (chatBtn) {
        chatBtn.style.background = 'linear-gradient(135deg,#0284c7,#0369a1)';
      }
    },

    close: function () {
      isOpen = false;
      if (panel) { panel.remove(); panel = null; }
      var chatBtn = document.getElementById('abe-fab-chat');
      if (chatBtn) {
        chatBtn.style.background = 'linear-gradient(135deg,#0ea5e9,#0284c7)';
      }
    },

    clear: function () {
      history = [];
      renderMessages();
    },

    ask: function (question) {
      var inp = document.getElementById('abe-faq-input');
      if (inp) inp.value = '';
      callAI(question);
    },

    submit: function () {
      var inp = document.getElementById('abe-faq-input');
      if (!inp) return;
      var q = (inp.value || '').trim();
      if (!q || isLoading) return;
      inp.value = '';
      callAI(q);
    },
  };

})();

// Make globally accessible
window.ABE_FAQ = ABE_FAQ;
