/**
 * ABE Platform — Interactive Onboarding Tour v2
 * Full platform coverage: ABE GTM + Account Intelligence + Lead Manager
 */
(function () {
'use strict';

var PAGE = (function() {
  var p = window.location.pathname;
  if (p.includes('gtm-strategy'))  return 'gtm';
  if (p.includes('vault'))         return 'vault';
  if (p.includes('accounts'))      return 'accounts';
  if (p.includes('leads'))         return 'leads';
  return 'dashboard';
})();

var TOURS = {

dashboard: [
  { title: 'Welcome to ABE — AI Revenue Infrastructure',
    body: 'ABE gives you two powerful engines.<br><br><strong style="color:#a855f7">ABE GTM Platform</strong> — builds complete go-to-market strategies for any company in 4 minutes. Market research, TAM, ICP, sourcing, keywords, full email sequence.<br><br><strong style="color:#06b6d4">AI Lead Orchestration</strong> — import your lead database, score every contact with AI, generate personalised outreach. 100 leads in under 3 minutes.',
    anchor: null, pos: 'center' },

  { title: 'The Recommended Workflow',
    body: '<strong style="color:white">1 →</strong> Run GTM Strategy on your target accounts<br><strong style="color:white">2 →</strong> Strategy Vault saves all reports automatically<br><strong style="color:white">3 →</strong> Send to Lead Manager for outreach pipeline<br><strong style="color:white">4 →</strong> Send to Account Intelligence for signal monitoring<br><br>Each step connects to the next. Your GTM score carries everywhere — no rescoring.',
    anchor: null, pos: 'center' },

  { title: 'AI Lead Orchestration',
    body: '<strong style="color:white">Import</strong> any CSV/Excel — columns auto-mapped<br><strong style="color:white">Execute Mapping</strong> — scores every lead instantly<br><strong style="color:white">Bulk Analyze Intel</strong> — 4-panel AI per lead:<br>• Pain Area • Key Insight • Solution • Cold Outreach<br><br>The cold outreach is written for that specific lead — not a template with blanks.',
    anchor: null, pos: 'center' },

  { title: 'BYOK — Bring Your Own Key',
    body: 'Both platforms use your own OpenAI API key. Paste it once in Settings — lives in session memory, wiped on logout. Zero keys stored on our servers.',
    anchor: null, pos: 'center' },

  { title: 'Start Here → GTM Strategy',
    body: 'Enter any company name and website. ABE fetches their live site, extracts context, then runs all 6 strategy steps against that context — specific intelligence, not generic AI.',
    anchor: 'a[href="gtm-strategy.html"]', pos: 'bottom' },

  { title: 'Strategy Vault',
    body: 'All completed strategies auto-save here. Bulk-select companies and send them to Lead Manager for outreach or Account Intelligence for signal monitoring — one click each.',
    anchor: 'a[href="vault.html"]', pos: 'bottom' },

  { title: 'Account Intelligence',
    body: 'Monitors 8 buying signal types — hiring waves, funding, product launches, leadership changes. Click Edit on any company to add its domain, then Scan Signals. Intent scores update automatically.',
    anchor: 'a[href="accounts.html"]', pos: 'bottom' },

  { title: 'Lead Manager',
    body: 'Your full pipeline. Import leads, AI-score them, generate personalised outreach, track every prospect. GTM scores from the Vault carry over — pipeline starts immediately.',
    anchor: 'a[href="leads.html"]', pos: 'bottom' },

  { title: 'Ready — Click the ? Button Anytime',
    body: 'The <strong style="color:#a855f7">?</strong> button bottom-right restarts this tour. Start with GTM Strategy — enter your first target company and run all 6 steps.',
    anchor: null, pos: 'center' },
],

gtm: [
  { title: 'GTM Strategy Builder',
    body: 'Enter a company name and website below. ABE scrapes their live site and extracts 1000+ words of real context — then every AI step is grounded in that company specifically.',
    anchor: '#topnav', pos: 'bottom' },

  { title: 'Configure AI Key First',
    body: 'Click ⚙ Config and paste your OpenAI API key. Stored in session memory only — wiped on logout. Without this the AI steps cannot run.',
    anchor: '[onclick="openApiModal()"]', pos: 'bottom', warn: true },

  { title: 'Six Steps in Order',
    body: '<strong style="color:white">1</strong> Market Research + GTM Score<br><strong style="color:white">2</strong> Total Addressable Market<br><strong style="color:white">3</strong> Ideal Customer Profile<br><strong style="color:white">4</strong> Account Sourcing Strategy<br><strong style="color:white">5</strong> Boolean Search + LinkedIn Keywords<br><strong style="color:white">6</strong> Email Sequence + LinkedIn Note + Cadence',
    anchor: '#step-nav-1', pos: 'right' },

  { title: 'Auto-Saved to Vault',
    body: 'Every step saves instantly to your Strategy Vault. Close and come back anytime — strategy resumes exactly where you left off.',
    anchor: '#step-nav-1', pos: 'right' },
],

vault: [
  { title: 'Strategy Vault',
    body: 'Every GTM strategy lands here automatically. Each card shows company, GTM relevance score, steps completed, and estimated TAM. Search, filter by status, sort by score.',
    anchor: '#topnav', pos: 'bottom' },

  { title: 'Select for Bulk Actions',
    body: 'Tick the checkbox on any card. Select multiple — the action bar appears. You can send in bulk to Lead Manager, monitor in Account Intelligence, or delete.',
    anchor: '.vault-card-checkbox', pos: 'right' },

  { title: '→ Lead Manager',
    body: 'Sends selected companies to your pipeline as scored leads. The GTM score carries directly — pipeline starts immediately with no rescoring.',
    anchor: '#vault-bulk-bar', pos: 'top' },

  { title: '📡 Monitor in Account Intelligence',
    body: 'Sends selected companies to Account Intelligence for signal monitoring. Best for medium and low intent accounts — you will be alerted when their buying signals rise.',
    anchor: '#vault-bulk-bar', pos: 'top' },
],

accounts: [
  { title: 'Account Intelligence',
    body: 'Watches your target companies for 8 buying signal types: hiring growth, funding signals, product launches, leadership changes, website changes, tech adoption, expansion signals, content activity. Intent scores update automatically.',
    anchor: '#topnav', pos: 'bottom' },

  { title: 'Add Companies from Vault',
    body: 'Go to Strategy Vault → select companies → click 📡 Monitor. They land here with full context. Or click + Add Company to add manually.',
    anchor: '[onclick="openAddCompany()"]', pos: 'left' },

  { title: 'Edit → Add Domain',
    body: 'Click any company card → click ✎ Edit → add the domain (e.g. brightpathgroup.com). Domain is required before Scan Signals can work.',
    anchor: null, pos: 'center', warn: true },

  { title: 'Scan Signals',
    body: 'Click 🔍 Scan Signals inside a company card to scan that company. Or click ⚡ Scan Signals in the nav to scan ALL companies at once. Run after adding domains.',
    anchor: '[onclick="runSignalScan()"]', pos: 'bottom' },

  { title: 'Run Learning Cycle',
    body: 'After scanning, click 🧠 Run Learning Cycle to recalculate all intent scores. Filter stays on ALL TIERS by default so every company is visible regardless of score.',
    anchor: '[onclick="runLearningCycle()"]', pos: 'bottom' },

  { title: 'View Strategy + Send to Pipeline',
    body: 'Open any company card — click View GTM Strategy to see the full research report, or → Send to Lead Manager to start outreach. No need to regenerate anything.',
    anchor: null, pos: 'center' },
],

leads: [
  { title: 'Lead Manager',
    body: 'Your AI-powered pipeline. Import any CSV or Excel file, score every lead automatically, generate personalised outreach per contact, track every prospect through the pipeline.',
    anchor: '#topnav', pos: 'bottom' },

  { title: 'Import Your Leads',
    body: 'Click ⬆ Import CSV to upload any spreadsheet. ABE auto-maps columns — no formatting required. Any structure works.',
    anchor: '[onclick="openImport()"]', pos: 'bottom', warn: true },

  { title: 'Score and Analyze',
    body: 'After import: Execute Mapping scores every lead by intent. Then Bulk Analyze Intel generates 4-panel AI intelligence per lead — Pain Area, Key Insight, Solution, Cold Outreach.',
    anchor: null, pos: 'center' },

  { title: 'Filter to Your Best Leads',
    body: 'Filter by Priority (HIGH / MEDIUM / LOW) and Intent. Sort by score. Focus outreach on HIGH intent first for fastest results.',
    anchor: '#filter-priority', pos: 'bottom' },
],

};

var PREREQS = {
  vault:    { key: 'abe_has_gtm', msg: 'Run your first GTM Strategy first — then your strategies will appear here.' },
  accounts: { key: 'abe_has_gtm', msg: 'Add companies from the Strategy Vault. Go to Vault → select companies → 📡 Monitor.' },
  leads:    { key: 'abe_has_gtm', msg: 'Tip: Run a GTM Strategy first to understand your ICP before importing leads.' },
};

var CSS = `
.abt-spot{position:fixed;z-index:8801;border-radius:10px;pointer-events:none!important;
  box-shadow:0 0 0 9999px rgba(0,0,0,.7),0 0 0 3px #a855f7,0 0 28px rgba(168,85,247,.4);
  transition:all .3s cubic-bezier(.4,0,.2,1);display:none}
.abt-box{position:fixed;z-index:9000;background:#0D1119;border:1px solid rgba(168,85,247,.35);
  border-radius:14px;padding:20px 22px;max-width:340px;min-width:270px;
  box-shadow:0 24px 64px rgba(0,0,0,.65);font-family:'Inter',sans-serif;
  pointer-events:all!important;animation:abt-in .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes abt-in{from{opacity:0;transform:scale(.9) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}
.abt-prog{display:flex;gap:3px;margin-bottom:13px}
.abt-pd{height:3px;flex:1;border-radius:2px;background:rgba(168,85,247,.15);transition:background .25s}
.abt-pd.d{background:#a855f7}.abt-pd.a{background:#7c3aed}
.abt-ico{font-size:19px;margin-bottom:7px}
.abt-ttl{font-size:13px;font-weight:800;color:white;letter-spacing:-.2px;margin-bottom:6px;line-height:1.3}
.abt-bdy{font-size:11px;color:#94A3B8;line-height:1.72;margin-bottom:13px}
.abt-bdy strong{color:#d1d5db}
.abt-wrn{display:flex;gap:6px;padding:8px 10px;margin-bottom:10px;
  background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.22);
  border-radius:7px;font-size:10px;color:#fde68a;line-height:1.5}
.abt-ft{display:flex;align-items:center;gap:7px}
.abt-n,.abt-s{padding:7px 14px;border-radius:7px;font-size:10px;font-weight:800;
  cursor:pointer;border:none;font-family:inherit;text-transform:uppercase;
  letter-spacing:.08em;transition:all .13s;pointer-events:all!important;position:relative;z-index:9050}
.abt-n{background:linear-gradient(135deg,#a855f7,#7c3aed);color:white;flex:1}
.abt-n:hover{opacity:.88;transform:translateY(-1px)}
.abt-n.fin{background:linear-gradient(135deg,#22c55e,#16a34a)}
.abt-s{background:rgba(31,41,55,.5);border:1px solid #1C2235;color:#6B7280}
.abt-s:hover{color:#E2E8F0}
.abt-sc{font-size:9px;color:#64748B;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-left:auto}
.abt-hlp{position:fixed;bottom:24px;right:24px;z-index:8600;width:40px;height:40px;
  border-radius:50%;background:linear-gradient(135deg,#a855f7,#7c3aed);color:white;
  font-size:18px;font-weight:800;border:none;cursor:pointer;font-family:inherit;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 16px rgba(168,85,247,.4);transition:all .18s}
.abt-hlp:hover{transform:scale(1.1);box-shadow:0 6px 22px rgba(168,85,247,.55)}
.abt-tt{position:absolute;bottom:47px;right:0;white-space:nowrap;
  background:#0D1119;border:1px solid rgba(168,85,247,.3);border-radius:7px;
  padding:5px 10px;font-size:10px;font-weight:700;color:#E2E8F0;
  opacity:0;pointer-events:none;transition:opacity .18s;font-family:'Inter',sans-serif}
.abt-hlp:hover .abt-tt{opacity:1}
.abt-pq{position:fixed;top:66px;left:50%;transform:translateX(-50%);z-index:8500;
  background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.28);border-radius:10px;
  padding:12px 18px;display:flex;align-items:center;gap:10px;max-width:500px;
  font-family:'Inter',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);animation:abt-in .3s ease}
.abt-pq-t{font-size:11px;color:#fde68a;line-height:1.5;flex:1}
.abt-pq-x{background:none;border:none;color:#6B7280;cursor:pointer;font-size:14px;font-family:inherit}
.abt-pq-x:hover{color:#E2E8F0}
`;

var cur=0, steps=[], spotEl=null, boxEl=null;

function init(){
  steps = TOURS[PAGE]||[];
  injectCSS(); addHelp(); checkPrereq(); markVisit();
  if(!localStorage.getItem('abt_'+PAGE)) setTimeout(go,900);
}

function injectCSS(){
  if(document.getElementById('abt-css')) return;
  var s=document.createElement('style'); s.id='abt-css'; s.textContent=CSS;
  document.head.appendChild(s);
}

function markVisit(){
  if(PAGE==='gtm') localStorage.setItem('abe_has_gtm','1');
}

function checkPrereq(){
  var p=PREREQS[PAGE]; if(!p||localStorage.getItem(p.key)) return;
  setTimeout(function(){
    var el=document.createElement('div'); el.className='abt-pq';
    el.innerHTML='<span style="font-size:18px">⚠️</span>' +
      '<div class="abt-pq-t"><strong style="color:white">Heads up!</strong> '+p.msg+'</div>' +
      '<button class="abt-pq-x" onclick="this.parentNode.remove()">✕</button>';
    document.body.appendChild(el);
    setTimeout(function(){if(el.parentNode)el.remove();},9000);
  },800);
}

function go(){
  if(!steps.length) return;
  cur=0;
  if(!document.getElementById('abt-spot')){
    var sp=document.createElement('div'); sp.id='abt-spot'; sp.className='abt-spot';
    document.body.appendChild(sp);
  }
  spotEl=document.getElementById('abt-spot');
  show(cur);
}

function show(n){
  var st=steps[n]; if(!st){finish();return;}
  var ob=document.getElementById('abt-box'); if(ob) ob.remove();

  var anch=st.anchor?document.querySelector(st.anchor):null;
  spotlight(anch);

  boxEl=document.createElement('div'); boxEl.id='abt-box'; boxEl.className='abt-box';
  var last=(n===steps.length-1);
  var icos=['🎯','📋','⚡','🔍','💡','🚀','📡','🧠','✅','💼','🗂️','🎬'];

  var prog=steps.map(function(_,i){
    return '<div class="abt-pd '+(i<n?'d':i===n?'a':'')+'"></div>';
  }).join('');

  boxEl.innerHTML=
    '<div class="abt-prog">'+prog+'</div>'+
    '<div class="abt-ico">'+icos[n%icos.length]+'</div>'+
    '<div class="abt-ttl">'+st.title+'</div>'+
    '<div class="abt-bdy">'+st.body+'</div>'+
    (st.warn?'<div class="abt-wrn"><span>⚠️</span><span>Complete this before moving forward.</span></div>':'')+
    '<div class="abt-ft">'+
      '<button class="abt-s" id="abt-sk">Skip</button>'+
      '<button class="abt-n'+(last?' fin':'')+'" id="abt-nx">'+(last?'✓ Got it!':'Next →')+'</button>'+
      '<span class="abt-sc">'+(n+1)+' / '+steps.length+'</span>'+
    '</div>';

  document.body.appendChild(boxEl);
  position(anch, st.pos);

  document.getElementById('abt-nx').onclick=function(e){e.stopPropagation();fwd();};
  document.getElementById('abt-sk').onclick=function(e){e.stopPropagation();finish();};
  document.addEventListener('keydown',onKey);
}

function fwd(){document.removeEventListener('keydown',onKey);cur++;show(cur);}
function finish(){
  document.removeEventListener('keydown',onKey);
  var b=document.getElementById('abt-box'); if(b) b.remove();
  if(spotEl) spotEl.style.display='none';
  localStorage.setItem('abt_'+PAGE,'1');
}
function onKey(e){
  if(e.key==='Escape') finish();
  if(e.key==='ArrowRight'||e.key==='Enter') fwd();
}

function spotlight(anchor){
  if(!spotEl) return;
  if(!anchor){spotEl.style.display='none';return;}
  spotEl.style.display='block';
  var r=anchor.getBoundingClientRect(),p=8;
  spotEl.style.left=(r.left-p)+'px'; spotEl.style.top=(r.top-p)+'px';
  spotEl.style.width=(r.width+p*2)+'px'; spotEl.style.height=(r.height+p*2)+'px';
}

function position(anchor,pos){
  if(!boxEl) return;
  requestAnimationFrame(function(){
    var bw=boxEl.offsetWidth||300,bh=boxEl.offsetHeight||180;
    var vw=window.innerWidth,vh=window.innerHeight,mg=12;
    var l,t;
    if(!anchor||pos==='center'){l=(vw-bw)/2;t=(vh-bh)/2;}
    else{
      var r=anchor.getBoundingClientRect();
      if(pos==='bottom'){t=r.bottom+14;l=r.left+r.width/2-bw/2;}
      else if(pos==='top'){t=r.top-bh-14;l=r.left+r.width/2-bw/2;}
      else if(pos==='right'){t=r.top+r.height/2-bh/2;l=r.right+14;}
      else if(pos==='left'){t=r.top+r.height/2-bh/2;l=r.left-bw-14;}
      else{l=(vw-bw)/2;t=(vh-bh)/2;}
    }
    l=Math.max(mg,Math.min(vw-bw-mg,l));
    t=Math.max(mg,Math.min(vh-bh-mg,t));
    boxEl.style.left=l+'px'; boxEl.style.top=t+'px';
  });
}

function addHelp(){
  if(document.getElementById('abt-hlp')) return;
  var b=document.createElement('button'); b.id='abt-hlp'; b.className='abt-hlp';
  b.innerHTML='?<div class="abt-tt">Platform guide</div>';
  b.onclick=function(){localStorage.removeItem('abt_'+PAGE);finish();setTimeout(go,80);};
  document.body.appendChild(b);
}

window.tourNext=function(){fwd();};
window.skipTour=function(){finish();};
window.ABE_TOUR={
  start:go,end:finish,
  reset:function(){
    ['dashboard','gtm','vault','accounts','leads'].forEach(function(p){
      localStorage.removeItem('abt_'+p);
    });
    go();
  }
};

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',function(){setTimeout(init,400);});
}else{
  setTimeout(init,400);
}
})();
