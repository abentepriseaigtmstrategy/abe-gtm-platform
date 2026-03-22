// ABE Platform - FAQ Chat Assistant
// Floating help widget - Powered by OpenAI via /api/analyze
// Include on all pages: <script src="faq-chat.js"></script>

var ABE_FAQ = (function () {

  var SYSTEM_PROMPT = 'You are the ABE Platform Help Assistant. Answer questions about the ABE platform only. Be direct and concise. Max 3 sentences unless steps are needed.\n\nPLATFORM MODULES:\n1. Command Centre (dashboard.html) - import leads, AI analysis, KPI cards, charts\n2. GTM Strategy Builder (gtm-strategy.html) - 6-step AI strategy: Market Research, TAM, ICP, Account Sourcing, Keywords, Messaging\n3. Strategy Vault (vault.html) - store/search/export GTM strategies, push to Lead Manager\n4. Lead Manager (leads.html) - import CSV leads, score, generate outreach, track actions\n5. Account Intelligence (accounts.html) - 8 intent signal types, HOT/WARM/COLD tiers\n6. Report Page (report.html) - printable full GTM report\n\nKEY FEATURES:\n- Bulk Analyze: 5 leads simultaneously, skips already-analyzed, live progress bar\n- AI Modal: Pain Area (red), Key Insight (amber), Proposed Solution (purple), Cold Outreach (cyan)\n- Save Mode: LOCAL and SUPABASE toggles, both can be active simultaneously\n- GTM Score: flows Vault to Lead Manager without overwrite\n- ICP Score: green>=75, amber>=50, red<50\n- Intent Signals: 8 types with 14-day recency decay\n- Bulk GTM: CSV of up to 10 companies, all 6 steps each\n- Export: XLSX, CSV, PDF, Word\n\nSCORING:\n- HIGH: ICP>=75%, Intent>=60\n- MEDIUM: ICP 50-74%, Intent 30-59\n- LOW: ICP<50%, Intent<30\n- HOT account: intent>=60, WARM: 30-59\n\nWORKFLOWS:\n- Import leads: Command Centre > IMPORT > upload xlsx/csv > Execute Mapping > Bulk Analyze\n- GTM strategy: GTM Strategy > enter company + industry > run 6 steps > auto-saves\n- Push to Lead Manager: Strategy Vault > hover card > LM button\n- Generate outreach: Lead Manager > click mail button on lead > save\n- Track signals: Account Intelligence > Add Company > Scan Signals\n\nIf asked anything not about ABE platform, say: I can only help with ABE platform questions.';

  var QUICK_QUESTIONS = [
    'How do I import leads?',
    'What is a GTM Score?',
    'How does Bulk Analyze work?',
    'What are intent signals?',
    'How do I export my leads?',
    'How do I generate outreach?',
    'Difference between ICP and GTM score?',
    'How do I push a strategy to Lead Manager?',
    'How does recency decay work?',
    'What is the Strategy Vault?'
  ];

  var isOpen    = false;
  var isLoading = false;
  var messages  = [];
  var panel     = null;

  function getToken() {
    // Use window.APP.token() — the same method used by all other pages
    // This is defined in auth-guard.js and always returns a fresh JWT
    return new Promise(function(resolve) {
      try {
        if (window.APP && typeof window.APP.token === 'function') {
          window.APP.token().then(function(t) { resolve(t || ''); }).catch(function() { resolve(''); });
        } else {
          resolve('');
        }
      } catch(e) { resolve(''); }
    });
  }

  function callAI(question) {
    isLoading = true;
    renderMessages();

    var recentHistory = messages.slice(-4).map(function(m) {
      return (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content;
    }).join('\n');

    var fullPrompt = SYSTEM_PROMPT
      + (recentHistory ? '\n\nPREVIOUS CONVERSATION:\n' + recentHistory : '')
      + '\n\nUSER QUESTION: ' + question
      + '\n\nIMPORTANT: Reply in plain text only. No JSON. No markdown. Be concise.';

    getToken().then(function(token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) { headers['Authorization'] = 'Bearer ' + token; }

      fetch('/api/analyze', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          lead: { name: 'ABE FAQ User', title: 'Platform User', company: 'ABE Platform' },
          customPrompt: fullPrompt
        })
      })
      .then(function(res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function(data) {
        isLoading = false;
        var answer = extractAnswer(data);
        messages.push({ role: 'user', content: question });
        messages.push({ role: 'assistant', content: answer });
        renderMessages();
      })
      .catch(function(err) {
        isLoading = false;
        var errMsg = '⚠️ Could not reach the AI engine. Please try again.';
        if (err.message && err.message.indexOf('429') !== -1) {
          errMsg = '⚠️ Too many requests. Please wait a moment and try again.';
        }
        messages.push({ role: 'user', content: question });
        messages.push({ role: 'assistant', content: errMsg });
        renderMessages();
      });
    });
  }

  function extractAnswer(data) {
    if (!data) { return 'No response received.'; }
    if (typeof data === 'string') { return data; }
    if (data.answer)   { return data.answer;   }
    if (data.message)  { return data.message;  }
    if (data.response) { return data.response; }
    if (data.reply)    { return data.reply;    }
    if (data.text)     { return data.text;     }
    var panels = [
      data['Pain Area'], data['Key Insight'],
      data['Proposed Solution'], data['Cold Outreach Message'],
      data.painArea, data.keyInsight,
      data.proposedSolution, data.coldOutreachMessage
    ];
    for (var i = 0; i < panels.length; i++) {
      if (panels[i] && typeof panels[i] === 'string' && panels[i].length > 5) {
        return panels[i];
      }
    }
    var vals = Object.values(data).filter(function(v) {
      return typeof v === 'string' && v.length > 5;
    });
    return vals.length ? vals[0] : 'I received a response but could not parse it. Please rephrase your question.';
  }

  function esc(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  function renderMessages() {
    var body = document.getElementById('abe-faq-body');
    if (!body) { return; }

    if (messages.length === 0 && !isLoading) {
      var chipsHtml = '';
      for (var i = 0; i < QUICK_QUESTIONS.length; i++) {
        var q = QUICK_QUESTIONS[i];
        chipsHtml += '<button class="abe-faq-chip" onclick="ABE_FAQ.ask(this.getAttribute(\'data-q\'))" data-q="' + esc(q) + '">' + esc(q) + '</button>';
      }
      body.innerHTML = '<div style="padding:16px 14px 8px;text-align:center">'
        + '<div style="font-size:24px;margin-bottom:8px">🤖</div>'
        + '<div style="font-size:12px;font-weight:700;color:#e5e7eb;margin-bottom:4px">ABE Platform Assistant</div>'
        + '<div style="font-size:11px;color:#6b7280;margin-bottom:16px">Ask me anything about the platform</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">' + chipsHtml + '</div>'
        + '</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      var isUser = m.role === 'user';
      var align = isUser ? 'flex-end' : 'flex-start';
      var bg = isUser ? 'linear-gradient(135deg,#a855f7,#7c3aed)' : 'rgba(255,255,255,.07)';
      var radius = isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px';
      html += '<div style="display:flex;justify-content:' + align + ';margin-bottom:10px;padding:0 12px">'
        + '<div style="max-width:82%;background:' + bg + ';color:#fff;border-radius:' + radius + ';padding:10px 13px;font-size:12px;line-height:1.6">'
        + esc(m.content)
        + '</div></div>';
    }

    if (isLoading) {
      html += '<div style="display:flex;justify-content:flex-start;margin-bottom:10px;padding:0 12px">'
        + '<div style="background:rgba(255,255,255,.07);border-radius:14px 14px 14px 4px;padding:10px 14px">'
        + '<span style="display:inline-flex;gap:4px">'
        + '<span style="width:6px;height:6px;border-radius:50%;background:#a855f7;animation:abe-dot 1s 0s infinite"></span>'
        + '<span style="width:6px;height:6px;border-radius:50%;background:#a855f7;animation:abe-dot 1s .2s infinite"></span>'
        + '<span style="width:6px;height:6px;border-radius:50%;background:#a855f7;animation:abe-dot 1s .4s infinite"></span>'
        + '</span></div></div>';
    }

    body.innerHTML = html;
    body.scrollTop = body.scrollHeight;
  }

  function injectCSS() {
    if (document.getElementById('abe-faq-css')) { return; }
    var s = document.createElement('style');
    s.id = 'abe-faq-css';
    s.textContent = ''
      + '@keyframes abe-faq-in{from{opacity:0;transform:translateY(16px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}'
      + '@keyframes abe-dot{0%,80%,100%{transform:scale(0);opacity:.3}40%{transform:scale(1);opacity:1}}'
      + '#abe-faq-panel{animation:abe-faq-in .25s cubic-bezier(.34,1.56,.64,1)}'
      + '.abe-faq-chip{background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);color:#c4b5fd;'
      + 'border-radius:20px;padding:5px 11px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}'
      + '.abe-faq-chip:hover{background:rgba(168,85,247,.25);border-color:rgba(168,85,247,.5);color:#fff}'
      + '#abe-faq-body::-webkit-scrollbar{width:4px}'
      + '#abe-faq-body::-webkit-scrollbar-track{background:transparent}'
      + '#abe-faq-body::-webkit-scrollbar-thumb{background:#1f2937;border-radius:4px}';
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('abe-faq-panel')) { return; }
    injectCSS();

    panel = document.createElement('div');
    panel.id = 'abe-faq-panel';
    panel.style.cssText = 'position:fixed;bottom:100px;right:28px;width:340px;max-width:calc(100vw - 40px);'
      + 'height:480px;max-height:calc(100vh - 140px);background:#0d1120;'
      + 'border:1px solid rgba(168,85,247,.3);border-radius:18px;'
      + 'box-shadow:0 20px 60px rgba(0,0,0,.7);z-index:8001;'
      + 'display:flex;flex-direction:column;overflow:hidden;font-family:Inter,sans-serif';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0';

    var logoWrap = document.createElement('div');
    logoWrap.style.cssText = 'display:flex;align-items:center;gap:8px';
    var logo = document.createElement('div');
    logo.style.cssText = 'width:28px;height:28px;background:linear-gradient(135deg,#0ea5e9,#0284c7);'
      + 'border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px';
    logo.textContent = '🤖';
    var titleWrap = document.createElement('div');
    var title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:800;color:#fff';
    title.textContent = 'ABE Assistant';
    var status = document.createElement('div');
    status.style.cssText = 'font-size:9px;color:#22c55e;font-weight:700';
    status.textContent = '● Online';
    titleWrap.appendChild(title);
    titleWrap.appendChild(status);
    logoWrap.appendChild(logo);
    logoWrap.appendChild(titleWrap);

    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px';

    var clearBtn = document.createElement('button');
    clearBtn.title = 'Clear chat';
    clearBtn.textContent = '↺';
    clearBtn.style.cssText = 'background:none;border:none;color:#4b5563;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:5px;font-family:inherit';
    clearBtn.onclick = function() { ABE_FAQ.clear(); };
    clearBtn.onmouseenter = function() { clearBtn.style.color = '#9ca3af'; };
    clearBtn.onmouseleave = function() { clearBtn.style.color = '#4b5563'; };

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:#4b5563;cursor:pointer;font-size:20px;line-height:1;padding:0 4px;border-radius:5px;font-family:inherit';
    closeBtn.onclick = function() { ABE_FAQ.close(); };
    closeBtn.onmouseenter = function() { closeBtn.style.color = '#9ca3af'; };
    closeBtn.onmouseleave = function() { closeBtn.style.color = '#4b5563'; };

    btns.appendChild(clearBtn);
    btns.appendChild(closeBtn);
    header.appendChild(logoWrap);
    header.appendChild(btns);

    // Body
    var body = document.createElement('div');
    body.id = 'abe-faq-body';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:8px 0';

    // Input row
    var inputRow = document.createElement('div');
    inputRow.style.cssText = 'padding:10px 12px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:8px;flex-shrink:0';

    var input = document.createElement('input');
    input.id = 'abe-faq-input';
    input.type = 'text';
    input.placeholder = 'Ask anything about ABE…';
    input.style.cssText = 'flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);'
      + 'border-radius:10px;color:#e5e7eb;font-size:12px;padding:9px 12px;outline:none;font-family:inherit';
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { ABE_FAQ.submit(); }
    });
    input.addEventListener('focus', function() { input.style.borderColor = 'rgba(168,85,247,.5)'; });
    input.addEventListener('blur',  function() { input.style.borderColor = 'rgba(255,255,255,.08)'; });

    var sendBtn = document.createElement('button');
    sendBtn.textContent = '→';
    sendBtn.style.cssText = 'background:linear-gradient(135deg,#a855f7,#7c3aed);border:none;border-radius:10px;'
      + 'padding:9px 14px;color:#fff;font-size:14px;cursor:pointer;flex-shrink:0;transition:transform .1s;font-family:inherit';
    sendBtn.onclick = function() { ABE_FAQ.submit(); };
    sendBtn.onmouseenter = function() { sendBtn.style.transform = 'scale(1.05)'; };
    sendBtn.onmouseleave = function() { sendBtn.style.transform = 'scale(1)'; };

    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(inputRow);
    document.body.appendChild(panel);

    renderMessages();
    setTimeout(function() { input.focus(); }, 100);
  }

  return {
    toggle: function() {
      if (isOpen) { this.close(); } else { this.open(); }
    },
    open: function() {
      isOpen = true;
      buildPanel();
      var btn = document.getElementById('abe-fab-chat');
      if (btn) { btn.style.background = 'linear-gradient(135deg,#0284c7,#0369a1)'; }
    },
    close: function() {
      isOpen = false;
      if (panel) { panel.remove(); panel = null; }
      var btn = document.getElementById('abe-fab-chat');
      if (btn) { btn.style.background = 'linear-gradient(135deg,#0ea5e9,#0284c7)'; }
    },
    clear: function() {
      messages = [];
      renderMessages();
    },
    ask: function(question) {
      var inp = document.getElementById('abe-faq-input');
      if (inp) { inp.value = ''; }
      callAI(question);
    },
    submit: function() {
      var inp = document.getElementById('abe-faq-input');
      if (!inp) { return; }
      var q = inp.value.trim();
      if (!q || isLoading) { return; }
      inp.value = '';
      callAI(q);
    }
  };

})();

window.ABE_FAQ = ABE_FAQ;
