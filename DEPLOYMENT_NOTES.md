# ABE GTM Platform — Deployment Notes
## Phase 19 — Controlled Deployment Package

**Baseline:** Phase 1–18 approved  
**Target platform:** Cloudflare Pages  
**Date prepared:** Phase 19 QA pass

---

## Deployment Folder Structure

```
abe-gtm-platform/
├── frontend/                  # Static assets → Cloudflare Pages public root
│   ├── index.html
│   ├── login.html
│   ├── dashboard.html
│   ├── gtm-strategy.html
│   ├── report.html
│   ├── vault.html
│   ├── accounts.html
│   ├── admin.html
│   ├── leads.html
│   ├── auth-callback.html
│   ├── ga4-tag.js             # Pure JS IIFE — GA4 frontend tag (G-KBPQTQPSZH)
│   ├── auth-guard.js
│   ├── faq-chat.js
│   ├── tour.js
│   └── _headers               # Cloudflare Pages security headers
├── functions/                 # Cloudflare Pages Functions (server-side)
│   ├── _middleware.js
│   └── api/
│       ├── export-pdf.js      # PDF + viewer mode — DO NOT MODIFY
│       ├── gtm-intelligence.js
│       ├── integration-readiness.js
│       ├── gtm.js
│       ├── save-report.js
│       ├── vault.js
│       └── connectors/
│           ├── ga4-connector.js
│           ├── rag-connector.js
│           ├── agent-connector.js
│           ├── crm-connector.js
│           └── source-validation-connector.js
├── wrangler.toml
├── supabase-schema.sql        # Reference only — do not re-run against live DB
└── schema_phase5_backend_intelligence.sql  # Reference only
```

---

## Required Cloudflare Environment Variables

Set all variables in: **Cloudflare Dashboard → Pages → Settings → Environment Variables**

### Core Runtime (Required)
| Variable | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | `eyJ...` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Supabase service role key (backend only) |
| `OPENAI_API_KEY` | `sk-...` | Required for GTM intelligence generation |
| `ALLOWED_ORIGIN` | `https://abe-gtm-platform.pages.dev` | CORS allowed origin |

### GA4 Frontend Tracking (Active)
| Variable | Value | Notes |
|---|---|---|
| `GA4_MEASUREMENT_ID` | `G-KBPQTQPSZH` | Frontend tag only — ga4-tag.js hardcodes this |

### GA4 Backend Data API (Access Pending)
| Variable | Value | Notes |
|---|---|---|
| `GA4_ENABLED` | `true` | Feature flag — set true when ready |
| `GA4_PROPERTY_ID` | `536562958` | Numeric property ID |
| `GOOGLE_ANALYTICS_CLIENT_EMAIL` | `abe-gtm-ga4-reader@abe-gtm-ga4-integration.iam.gserviceaccount.com` | Service account email |
| `GOOGLE_ANALYTICS_PRIVATE_KEY` | `-----BEGIN RSA PRIVATE KEY-----\n...` | PEM format — escape newlines as `\n` |
| `GA4_ACCESS_CONFIRMED` | **`false`** | **Must remain false until GA4 UI grants property access to service account** |

### Integration Feature Flags (All Inactive at Launch)
| Variable | Value | Notes |
|---|---|---|
| `RAG_ENABLED` | `false` | Set true + add RAG_ENDPOINT + RAG_API_KEY when ready |
| `AGENTS_ENABLED` | `false` | Set true + add AGENT_ENDPOINT + AGENT_API_KEY when ready |
| `SOURCE_VALIDATION_ENABLED` | `false` | Set true when source validation provider is configured |
| `CRM_ENRICHMENT_ENABLED` | `false` | Set true + add CRM_ENRICHMENT_API_KEY + CRM_ENRICHMENT_PROVIDER when ready |

---

## GA4 Access Activation Path (Post-Deployment)

GA4 backend reads are blocked by `GA4_ACCESS_CONFIRMED=false`. No code change is required to activate.

1. Go to **Google Analytics → Admin → Account Access Management**
2. Add `abe-gtm-ga4-reader@abe-gtm-ga4-integration.iam.gserviceaccount.com` as **Viewer**
3. Confirm access is granted in the GA4 UI
4. In Cloudflare Dashboard → Pages → Environment Variables:
   - Set `GA4_ACCESS_CONFIRMED=true`
5. Redeploy or trigger a new Pages build
6. GA4 backend contract will advance from `access_pending` → `ready`
7. Implement the live fetch block in `functions/api/connectors/ga4-connector.js`

---

## Integration Activation Paths (Future)

### RAG Source Validation
Set: `RAG_ENABLED=true`, `RAG_ENDPOINT=<vector-db-url>`, `RAG_API_KEY=<key>`

### Agent Recommendations
Set: `AGENTS_ENABLED=true`, `AGENT_ENDPOINT=<agent-url>`, `AGENT_API_KEY=<key>`

### CRM Enrichment
Set: `CRM_ENRICHMENT_ENABLED=true`, `CRM_ENRICHMENT_API_KEY=<key>`, `CRM_ENRICHMENT_PROVIDER=<provider>`

No code changes required for any of the above — env vars alone activate each integration.

---

## Current Safe State at Deployment

| Feature | Status |
|---|---|
| GTM report generation | ✅ Live |
| PDF export (full document) | ✅ Live |
| PDF viewer mode | ✅ Live |
| Vault load/save | ✅ Live |
| GA4 frontend tracking | ✅ Live (G-KBPQTQPSZH) |
| GA4 backend Data API | ⏳ access_pending (no live calls) |
| RAG source validation | 🔒 Inactive (flag=false) |
| Agent recommendations | 🔒 Inactive (flag=false) |
| CRM enrichment | 🔒 Inactive (flag=false) |
| Source validation | 🔒 Inactive (flag=false) |
| Fake data | ❌ None |
| Schema migrations pending | ❌ None |

---

## Do Not Modify at Deployment Time

- `functions/api/export-pdf.js` — PDF/viewer architecture locked
- `functions/api/gtm-intelligence.js` — backend formula layer locked
- `supabase-schema.sql` — reference only, do not re-run
- `frontend/ga4-tag.js` — pure JS IIFE, do not add HTML tags

---

*Plan with clarity. Build with intent. Grow through trust.*
