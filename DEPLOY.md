# AB GTM Platform — Deployment Guide

## One-Time Setup (do this before first push)

### 1. Set Cloudflare secrets
```bash
npx wrangler pages secret put OPENAI_API_KEY        --project-name ab-gtm-platform
npx wrangler pages secret put SUPABASE_SERVICE_KEY  --project-name ab-gtm-platform
```

### 2. Run Supabase schema
Open https://supabase.com/dashboard/project/cwcvneluhlimhlzowabv/sql  
Paste and run the contents of `supabase-schema.sql`

### 3. Enable Supabase Email Auth
Dashboard → Authentication → Providers → Email: **Enable**

---

## Deploy

```bash
git add .
git commit -m "production: fix auth headers, KV binding, middleware, report page"
git push
```

Cloudflare Pages builds automatically on push.

---

## Verify after deploy

| Test | URL | Expected |
|------|-----|----------|
| Login | /login.html | Sign in works |
| Strategy | /gtm-strategy.html | All 6 steps run |
| Save | Save button | Toast "saved to vault" |
| Vault | /vault.html | Cards appear |
| Open strategy | Click card | Drawer + report loads |
| Report page | /report.html?id=UUID | Full report renders |
| PDF export | Export PDF button | PDF downloads |

---

## What was fixed

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `wrangler.toml` | KV binding `CACHE` ≠ code expects `STRATEGY_CACHE` | Renamed to `STRATEGY_CACHE` |
| 2 | `functions/_middleware.js` | Missing root middleware (global OPTIONS handling) | Created with dual KV name support |
| 3 | `functions/api/_middleware.js` | Full implementation in wrong location | Now re-exports from root |
| 4 | `vault.html` | ALL fetch calls missing `Authorization: Bearer` token → 401 on every request | Added `apiCall()` helper with token on all calls |
| 5 | `vault.html` | `exportStrategy` only handled `html2pdf` fallback, missed `pdf_base64` branch | Both branches handled |
| 6 | `vault.html` | `archiveStrategy` called Supabase SDK directly (bypasses auth proxy) | Routes through `/api/gtm` action:archive_strategy |
| 7 | `vault.html` | "Re-run" linked to `?company=` not `?resume=STRATEGY_ID` | Fixed to `gtm-strategy.html?resume=ID` |
| 8 | `vault.html` | Card click "Full Report" missing | Added link to `report.html?id=ID` |
| 9 | `dashboard.html` | `supabaseClient` variable undefined → cloud save crashes | Replaced with `window.APP.sb` |
| 10 | `dashboard.html` | `<script src="auth-guard.js">` floating as raw text inside JS comment block | Moved to correct HTML position |
| 11 | `gtm-strategy.html` | `handleSignOut` creates new Supabase client with wrong key | Uses `window.APP.sb` |
| 12 | `gtm-strategy.html` | No URL param handler for `?resume=ID` from vault | Added async `handleUrlParams()` |
| 13 | `index.html` | Meta-refresh to dashboard without auth check → exposes app to unauthenticated users | Auth-aware redirect via Supabase session check |
| 14 | `report.html` | File missing entirely (spec requirement, vault links to it) | Created full standalone report page |
| 15 | `functions/api/strategy.js` | Missing spec endpoint POST /api/strategy | Created as 6-step orchestration wrapper |
| 16 | `functions/api/save-report.js` | Missing spec endpoint POST /api/save-report | Created as save_strategy delegate |
| 17 | `functions/api/vault.js` | Missing spec endpoint GET /api/vault | Created with GET + POST support |
| 18 | `supabase-schema.sql` | No schema file in repo | Created complete schema with RLS policies |
