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

### Phase 21C — Gotenberg Server-Side PDF (New)
| Variable | Value | Notes |
|---|---|---|
| `PDF_RENDER_ENGINE` | `gotenberg` | Set to `gotenberg` to enable Gotenberg path. Omit or set any other value to keep JSON/browser fallback. |
| `GOTENBERG_URL` | `https://your-gotenberg-service-url` | Base URL of your deployed Gotenberg instance (no trailing slash). Required when `PDF_RENDER_ENGINE=gotenberg`. |

**Gotenberg activation:**
1. Deploy a Gotenberg instance (Docker: `gotenberg/gotenberg:8`)
2. Set `PDF_RENDER_ENGINE=gotenberg` and `GOTENBERG_URL=https://<your-gotenberg-url>` in Cloudflare Pages env vars
3. Redeploy — `/api/export-pdf` will now return `application/pdf` directly
4. The frontend `exportPDF()` auto-detects the PDF binary and downloads it without html2canvas
5. If Gotenberg fails for any reason, the JSON/HTML fallback activates automatically — no broken export

**Fallback guarantee:** If `PDF_RENDER_ENGINE` is not `gotenberg` OR `GOTENBERG_URL` is missing OR Gotenberg returns an error, the existing JSON/HTML fallback path is returned. The export never breaks.

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


## Phase 21D PDF Stabilization Patch

This package includes a controlled PDF export stabilization pass:

- Viewer mode is protected: `/api/export-pdf?mode=viewer` always returns JSON/HTML even when Gotenberg is enabled.
- Export mode diagnostics are exposed through response headers:
  - `X-ABE-PDF-Engine`
  - `X-ABE-Export-Path`
- Frontend `report.html` raw PDF fetch now awaits `window.APP.token()` before setting the Authorization header. This prevents `Bearer [object Promise]` and the 401 export regression.
- Export 401 no longer force-signs the user out from the PDF button; the global auth guard remains responsible for genuine session expiry.
- Gotenberg failures rebuild a browser-safe fallback HTML instead of returning Gotenberg-specific HTML to the client fallback renderer.
- PDF readability CSS was strengthened: body/table fonts, footer contrast, table header groups, status pills, anti-orphan rules, and chart/table block handling.

Manual validation after deploy:

1. Confirm `/api/export-pdf?mode=viewer` still loads the report viewer.
2. With `PDF_RENDER_ENGINE=gotenberg` and `GOTENBERG_URL` set, export should return `Content-Type: application/pdf`.
3. Confirm the request contains `Authorization: Bearer <token>` and not `Bearer [object Promise]`.
4. If Gotenberg fails, confirm JSON fallback still exports without redirecting to login.
5. Inspect the generated PDF for readable table fonts, visible footer tagline, reduced orphan headings, and no raw floats/placeholders.

## Phase 21E — Multi-provider PDF rendering + fallback gap fix

This build does not rely on a single PDF provider. The server export pipeline can now try multiple external PDF engines before falling back to browser rendering.

Recommended Production env:

```text
PDF_RENDER_ENGINE=auto
PDF_RENDER_PROVIDER_ORDER=gotenberg,browserless,pdfshift
GOTENBERG_URL=https://your-gotenberg-service-url
BROWSERLESS_URL=https://your-browserless-service-url
BROWSERLESS_TOKEN=optional-browserless-token
PDFSHIFT_API_KEY=optional-pdfshift-key
PDF_RENDER_TIMEOUT_MS=28000
```

Optional cover visual:

```text
UNSPLASH_ENABLED=true
UNSPLASH_ACCESS_KEY=your-unsplash-access-key
```

Expected successful server-render response headers:

```text
Content-Type: application/pdf
X-ABE-PDF-Engine: gotenberg | browserless | pdfshift
X-ABE-Export-Path: external-application-pdf:<provider>
```

If all external renderers fail, the frontend uses a readable HTML fallback and no longer slices each `.page` wrapper separately; it slices the continuous rendered canvas to reduce half-blank pages.
