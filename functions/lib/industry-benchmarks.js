/**
 * industry-benchmarks.js  —  Layer 3: Grounded Industry Reference Data
 * ABE GTM Platform  ·  Cloudflare Workers compatible
 *
 * Purpose:
 *   Provides factual, source-cited industry benchmark data that is injected
 *   into Step 2 (TAM/Scoring) and Step 3 (Verdict) prompts as hard reference
 *   ranges. This prevents the AI from inventing TAM figures from thin air.
 *
 * Architecture role:
 *   Called by enrichment-pipeline.js during the pre-generation research phase.
 *   Output is merged into the EVIDENCE LAYER injected into buildStepPrompt.
 *
 * Data sources (embedded, periodically updated):
 *   - Gartner Market Data Guide 2024
 *   - Grand View Research industry reports
 *   - Statista market sizing 2023–2024
 *   - McKinsey Global Institute sector analyses
 *   - IBISWorld industry reports
 *
 * Update cadence: Review annually. Major market shifts warrant interim updates.
 *
 * Usage:
 *   getBenchmarks(industry)         → BenchmarkRecord | null
 *   getMatchedBenchmarks(industry)  → BenchmarkRecord (with fuzzy matching)
 */

// ── Benchmark record schema ────────────────────────────────────────
/**
 * BenchmarkRecord {
 *   vertical:          string        canonical vertical name
 *   tam_range_usd:     [number, number]  [low, high] in USD (real numbers)
 *   tam_display:       string        human-readable range e.g. "$12B – $18B"
 *   tam_source:        string        citation
 *   tam_year:          number        data year
 *   cagr_range_pct:    [number, number]  [low, high] YoY growth %
 *   cagr_display:      string
 *   typical_deal_size: { smb: string, mid_market: string, enterprise: string }
 *   common_icp_roles:  string[]      top buyer titles in this vertical
 *   sales_cycle_days:  { smb: number, mid_market: number, enterprise: number }
 *   key_buying_triggers: string[]
 *   competitive_density: 'low' | 'medium' | 'high' | 'very_high'
 * }
 */

const BENCHMARKS = {

  // ── SaaS / Cloud Software ──────────────────────────────────────
  'saas': {
    vertical: 'SaaS / Cloud Software',
    tam_range_usd: [195_000_000_000, 232_000_000_000],
    tam_display: '$195B – $232B',
    tam_source: 'Gartner Forecast: Enterprise Software, 2024',
    tam_year: 2024,
    cagr_range_pct: [11, 18],
    cagr_display: '11%–18% CAGR',
    typical_deal_size: { smb: '$5K–$25K', mid_market: '$25K–$150K', enterprise: '$150K–$2M+' },
    common_icp_roles: ['CTO', 'VP Engineering', 'Head of Product', 'COO', 'IT Director'],
    sales_cycle_days: { smb: 14, mid_market: 60, enterprise: 120 },
    key_buying_triggers: ['Tech stack modernization', 'Headcount scaling', 'Compliance requirement', 'Competitor adoption'],
    competitive_density: 'very_high',
  },

  // ── HR Tech / Workforce Management ────────────────────────────
  'hr tech': {
    vertical: 'HR Technology',
    tam_range_usd: [32_000_000_000, 39_000_000_000],
    tam_display: '$32B – $39B',
    tam_source: 'Grand View Research: HR Technology Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [9, 14],
    cagr_display: '9%–14% CAGR',
    typical_deal_size: { smb: '$3K–$15K', mid_market: '$15K–$80K', enterprise: '$80K–$500K' },
    common_icp_roles: ['CHRO', 'VP People', 'Head of Talent', 'HR Director', 'COO'],
    sales_cycle_days: { smb: 21, mid_market: 45, enterprise: 90 },
    key_buying_triggers: ['Rapid hiring', 'Remote workforce expansion', 'Compliance audit', 'HRIS replacement'],
    competitive_density: 'high',
  },

  // ── Fintech / Financial Services ──────────────────────────────
  'fintech': {
    vertical: 'Financial Technology',
    tam_range_usd: [226_000_000_000, 310_000_000_000],
    tam_display: '$226B – $310B',
    tam_source: 'Statista: Global Fintech Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [16, 24],
    cagr_display: '16%–24% CAGR',
    typical_deal_size: { smb: '$10K–$50K', mid_market: '$50K–$300K', enterprise: '$300K–$5M+' },
    common_icp_roles: ['CFO', 'CRO', 'Head of Treasury', 'VP Finance', 'Head of Compliance'],
    sales_cycle_days: { smb: 30, mid_market: 90, enterprise: 180 },
    key_buying_triggers: ['Regulatory change', 'Payment modernization', 'Fraud spike', 'M&A activity'],
    competitive_density: 'very_high',
  },

  // ── Cybersecurity ─────────────────────────────────────────────
  'cybersecurity': {
    vertical: 'Cybersecurity',
    tam_range_usd: [173_000_000_000, 211_000_000_000],
    tam_display: '$173B – $211B',
    tam_source: 'Gartner: Information Security & Risk Management, 2024',
    tam_year: 2024,
    cagr_range_pct: [12, 19],
    cagr_display: '12%–19% CAGR',
    typical_deal_size: { smb: '$8K–$40K', mid_market: '$40K–$250K', enterprise: '$250K–$10M+' },
    common_icp_roles: ['CISO', 'CTO', 'VP Security', 'IT Security Director', 'Head of Risk'],
    sales_cycle_days: { smb: 21, mid_market: 60, enterprise: 150 },
    key_buying_triggers: ['Security breach', 'Compliance audit (SOC2/ISO)', 'Remote access expansion', 'Board mandate'],
    competitive_density: 'very_high',
  },

  // ── Marketing Tech ────────────────────────────────────────────
  'martech': {
    vertical: 'Marketing Technology',
    tam_range_usd: [344_000_000_000, 390_000_000_000],
    tam_display: '$344B – $390B',
    tam_source: 'Statista: Global MarTech Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [13, 20],
    cagr_display: '13%–20% CAGR',
    typical_deal_size: { smb: '$5K–$30K', mid_market: '$30K–$200K', enterprise: '$200K–$2M' },
    common_icp_roles: ['CMO', 'VP Marketing', 'Head of Growth', 'Demand Gen Director', 'Marketing Ops'],
    sales_cycle_days: { smb: 14, mid_market: 45, enterprise: 90 },
    key_buying_triggers: ['Pipeline shortfall', 'Ad spend ROI pressure', 'Data privacy change', 'CRM migration'],
    competitive_density: 'very_high',
  },

  // ── Healthcare / HealthTech ───────────────────────────────────
  'healthtech': {
    vertical: 'Health Technology',
    tam_range_usd: [140_000_000_000, 175_000_000_000],
    tam_display: '$140B – $175B',
    tam_source: 'Grand View Research: Digital Health Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [17, 26],
    cagr_display: '17%–26% CAGR',
    typical_deal_size: { smb: '$15K–$60K', mid_market: '$60K–$400K', enterprise: '$400K–$5M+' },
    common_icp_roles: ['CIO', 'CMO (Medical)', 'VP Clinical Operations', 'Head of Digital Health', 'CFO'],
    sales_cycle_days: { smb: 45, mid_market: 120, enterprise: 270 },
    key_buying_triggers: ['EHR upgrade', 'Value-based care mandate', 'Interoperability requirement', 'Patient experience initiative'],
    competitive_density: 'high',
  },

  // ── E-commerce / Retail Tech ──────────────────────────────────
  'ecommerce': {
    vertical: 'E-commerce & Retail Technology',
    tam_range_usd: [6_800_000_000_000, 8_100_000_000_000],
    tam_display: '$6.8T – $8.1T (total market); tech segment $180B–$220B',
    tam_source: 'Statista: E-commerce Global, 2024 — note: tech segment is the relevant TAM for B2B',
    tam_year: 2024,
    cagr_range_pct: [9, 16],
    cagr_display: '9%–16% CAGR (tech segment)',
    typical_deal_size: { smb: '$5K–$20K', mid_market: '$20K–$100K', enterprise: '$100K–$1M' },
    common_icp_roles: ['VP E-commerce', 'Head of Digital', 'CTO', 'VP Merchandising', 'COO'],
    sales_cycle_days: { smb: 14, mid_market: 30, enterprise: 90 },
    key_buying_triggers: ['Peak season preparation', 'Cart abandonment spike', 'Platform migration', 'Mobile traffic growth'],
    competitive_density: 'high',
  },

  // ── Real Estate Tech ──────────────────────────────────────────
  'proptech': {
    vertical: 'Property Technology (PropTech)',
    tam_range_usd: [18_000_000_000, 27_000_000_000],
    tam_display: '$18B – $27B',
    tam_source: 'McKinsey: Real Estate Technology, 2024',
    tam_year: 2024,
    cagr_range_pct: [12, 18],
    cagr_display: '12%–18% CAGR',
    typical_deal_size: { smb: '$8K–$30K', mid_market: '$30K–$150K', enterprise: '$150K–$1M' },
    common_icp_roles: ['CTO', 'Head of Operations', 'VP Technology', 'Asset Manager', 'CFO'],
    sales_cycle_days: { smb: 21, mid_market: 60, enterprise: 120 },
    key_buying_triggers: ['Portfolio expansion', 'Lease management modernization', 'Market data gap', 'ESG reporting requirement'],
    competitive_density: 'medium',
  },

  // ── Legal Tech ────────────────────────────────────────────────
  'legaltech': {
    vertical: 'Legal Technology',
    tam_range_usd: [27_000_000_000, 35_000_000_000],
    tam_display: '$27B – $35B',
    tam_source: 'Grand View Research: Legal Tech Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [9, 16],
    cagr_display: '9%–16% CAGR',
    typical_deal_size: { smb: '$5K–$25K', mid_market: '$25K–$120K', enterprise: '$120K–$800K' },
    common_icp_roles: ['General Counsel', 'Chief Legal Officer', 'Head of Legal Ops', 'Partner (Law Firm)', 'Compliance Director'],
    sales_cycle_days: { smb: 30, mid_market: 75, enterprise: 180 },
    key_buying_triggers: ['Regulatory change', 'Contract volume spike', 'Compliance audit', 'Remote team expansion'],
    competitive_density: 'medium',
  },

  // ── EdTech / Learning & Development ──────────────────────────
  'edtech': {
    vertical: 'Education Technology',
    tam_range_usd: [232_000_000_000, 280_000_000_000],
    tam_display: '$232B – $280B',
    tam_source: 'HolonIQ: Global EdTech Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [13, 18],
    cagr_display: '13%–18% CAGR',
    typical_deal_size: { smb: '$3K–$20K', mid_market: '$20K–$100K', enterprise: '$100K–$1M' },
    common_icp_roles: ['CLO', 'VP Learning & Development', 'Head of HR', 'CTO', 'VP People Ops'],
    sales_cycle_days: { smb: 14, mid_market: 45, enterprise: 90 },
    key_buying_triggers: ['Skills gap initiative', 'Remote onboarding scale', 'Compliance training mandate', 'Upskilling program'],
    competitive_density: 'high',
  },

  // ── Supply Chain / Logistics Tech ────────────────────────────
  'supply chain': {
    vertical: 'Supply Chain & Logistics Technology',
    tam_range_usd: [22_000_000_000, 30_000_000_000],
    tam_display: '$22B – $30B',
    tam_source: 'Gartner: Supply Chain Management Software, 2024',
    tam_year: 2024,
    cagr_range_pct: [10, 17],
    cagr_display: '10%–17% CAGR',
    typical_deal_size: { smb: '$10K–$40K', mid_market: '$40K–$200K', enterprise: '$200K–$2M' },
    common_icp_roles: ['VP Supply Chain', 'COO', 'Head of Logistics', 'VP Procurement', 'CTO'],
    sales_cycle_days: { smb: 30, mid_market: 75, enterprise: 150 },
    key_buying_triggers: ['Supply disruption event', 'Inventory cost spike', 'ESG compliance', 'ERP modernization'],
    competitive_density: 'medium',
  },

  // ── Analytics / Business Intelligence ─────────────────────────
  'analytics': {
    vertical: 'Analytics & Business Intelligence',
    tam_range_usd: [29_000_000_000, 38_000_000_000],
    tam_display: '$29B – $38B',
    tam_source: 'Gartner: Analytics & BI Platforms, 2024',
    tam_year: 2024,
    cagr_range_pct: [10, 16],
    cagr_display: '10%–16% CAGR',
    typical_deal_size: { smb: '$5K–$30K', mid_market: '$30K–$200K', enterprise: '$200K–$2M' },
    common_icp_roles: ['CDO', 'VP Data', 'Head of Analytics', 'CTO', 'CFO'],
    sales_cycle_days: { smb: 21, mid_market: 60, enterprise: 120 },
    key_buying_triggers: ['Data stack consolidation', 'Executive reporting initiative', 'Compliance audit', 'ML/AI adoption'],
    competitive_density: 'high',
  },

  // ── DevOps / Developer Tools ──────────────────────────────────
  'devops': {
    vertical: 'DevOps & Developer Tools',
    tam_range_usd: [10_000_000_000, 14_500_000_000],
    tam_display: '$10B – $14.5B',
    tam_source: 'Grand View Research: DevOps Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [18, 26],
    cagr_display: '18%–26% CAGR',
    typical_deal_size: { smb: '$2K–$15K', mid_market: '$15K–$80K', enterprise: '$80K–$500K' },
    common_icp_roles: ['VP Engineering', 'CTO', 'Head of Platform', 'Engineering Manager', 'DevOps Lead'],
    sales_cycle_days: { smb: 7, mid_market: 30, enterprise: 75 },
    key_buying_triggers: ['CI/CD pipeline modernization', 'Engineering team scaling', 'Release frequency goal', 'Security scan requirement'],
    competitive_density: 'very_high',
  },

  // ── Customer Success / CX ─────────────────────────────────────
  'customer success': {
    vertical: 'Customer Success & CX Platforms',
    tam_range_usd: [13_000_000_000, 18_000_000_000],
    tam_display: '$13B – $18B',
    tam_source: 'Statista: Customer Experience Management Market, 2024',
    tam_year: 2024,
    cagr_range_pct: [14, 21],
    cagr_display: '14%–21% CAGR',
    typical_deal_size: { smb: '$5K–$25K', mid_market: '$25K–$120K', enterprise: '$120K–$1M' },
    common_icp_roles: ['Chief Customer Officer', 'VP Customer Success', 'Head of CX', 'VP Renewals', 'COO'],
    sales_cycle_days: { smb: 21, mid_market: 45, enterprise: 90 },
    key_buying_triggers: ['Churn spike', 'NPS decline', 'CS team scaling', 'CRM migration', 'Product-led growth launch'],
    competitive_density: 'high',
  },

  // ── General B2B Software (default fallback) ───────────────────
  'b2b software': {
    vertical: 'B2B Software (General)',
    tam_range_usd: [500_000_000_000, 700_000_000_000],
    tam_display: '$500B – $700B (broad B2B software market)',
    tam_source: 'Gartner: Enterprise IT Spending Forecast, 2024',
    tam_year: 2024,
    cagr_range_pct: [8, 15],
    cagr_display: '8%–15% CAGR',
    typical_deal_size: { smb: '$5K–$30K', mid_market: '$30K–$150K', enterprise: '$150K–$1M+' },
    common_icp_roles: ['CTO', 'COO', 'CFO', 'VP Operations', 'IT Director'],
    sales_cycle_days: { smb: 21, mid_market: 60, enterprise: 120 },
    key_buying_triggers: ['Digital transformation initiative', 'Compliance requirement', 'Cost reduction mandate', 'Competitive pressure'],
    competitive_density: 'high',
  },
};

// ── Keyword-to-vertical mapping ────────────────────────────────────
// Used for fuzzy industry string matching.
const KEYWORD_MAP = {
  'software':          'saas',
  'saas':              'saas',
  'cloud':             'saas',
  'platform':          'saas',
  'app':               'saas',
  'hr':                'hr tech',
  'human resources':   'hr tech',
  'recruiting':        'hr tech',
  'payroll':           'hr tech',
  'workforce':         'hr tech',
  'talent':            'hr tech',
  'finance':           'fintech',
  'fintech':           'fintech',
  'payments':          'fintech',
  'banking':           'fintech',
  'lending':           'fintech',
  'insurance':         'fintech',
  'security':          'cybersecurity',
  'cyber':             'cybersecurity',
  'compliance':        'cybersecurity',
  'identity':          'cybersecurity',
  'marketing':         'martech',
  'martech':           'martech',
  'advertising':       'martech',
  'demand generation': 'martech',
  'email marketing':   'martech',
  'health':            'healthtech',
  'healthcare':        'healthtech',
  'medical':           'healthtech',
  'clinical':          'healthtech',
  'pharma':            'healthtech',
  'ecommerce':         'ecommerce',
  'retail':            'ecommerce',
  'commerce':          'ecommerce',
  'real estate':       'proptech',
  'property':          'proptech',
  'proptech':          'proptech',
  'legal':             'legaltech',
  'law':               'legaltech',
  'contract':          'legaltech',
  'education':         'edtech',
  'learning':          'edtech',
  'training':          'edtech',
  'edtech':            'edtech',
  'supply chain':      'supply chain',
  'logistics':         'supply chain',
  'procurement':       'supply chain',
  'inventory':         'supply chain',
  'analytics':         'analytics',
  'data':              'analytics',
  'business intelligence': 'analytics',
  'reporting':         'analytics',
  'devops':            'devops',
  'developer':         'devops',
  'engineering':       'devops',
  'ci/cd':             'devops',
  'customer success':  'customer success',
  'customer experience': 'customer success',
  'cx':                'customer success',
  'churn':             'customer success',
};

// ── Main exports ───────────────────────────────────────────────────

/**
 * getBenchmarks(industry)
 * Exact match on canonical vertical name.
 * Returns BenchmarkRecord | null
 */
export function getBenchmarks(industry) {
  if (!industry) return null;
  const key = industry.toLowerCase().trim();
  return BENCHMARKS[key] || null;
}

/**
 * getMatchedBenchmarks(industry)
 * Fuzzy match via keyword map. Always returns a benchmark
 * (falls back to 'b2b software' if no vertical matches).
 *
 * @returns { benchmark: BenchmarkRecord, matchedVertical: string, matchConfidence: 'exact'|'fuzzy'|'default' }
 */
export function getMatchedBenchmarks(industry) {
  if (!industry) {
    return { benchmark: BENCHMARKS['b2b software'], matchedVertical: 'B2B Software (General)', matchConfidence: 'default' };
  }

  const lower = industry.toLowerCase().trim();

  // 1. Exact match
  if (BENCHMARKS[lower]) {
    return { benchmark: BENCHMARKS[lower], matchedVertical: BENCHMARKS[lower].vertical, matchConfidence: 'exact' };
  }

  // 2. Keyword match
  for (const [keyword, verticalKey] of Object.entries(KEYWORD_MAP)) {
    if (lower.includes(keyword)) {
      const bm = BENCHMARKS[verticalKey];
      if (bm) return { benchmark: bm, matchedVertical: bm.vertical, matchConfidence: 'fuzzy' };
    }
  }

  // 3. Default fallback
  return { benchmark: BENCHMARKS['b2b software'], matchedVertical: 'B2B Software (General)', matchConfidence: 'default' };
}

/**
 * formatBenchmarkForPrompt(benchmarkResult)
 * Returns a compact, prompt-injectable string that gives the AI
 * a hard reference range it cannot contradict.
 */
export function formatBenchmarkForPrompt(benchmarkResult) {
  const { benchmark: bm, matchedVertical, matchConfidence } = benchmarkResult;
  const confidenceNote = matchConfidence === 'exact' ? '(exact vertical match)' :
                         matchConfidence === 'fuzzy' ? '(closest vertical match)' :
                         '(default B2B reference — narrow with company-specific context)';

  return `INDUSTRY BENCHMARK REFERENCE ${confidenceNote}:
Vertical: ${matchedVertical}
TAM range: ${bm.tam_display} — Source: ${bm.tam_source} (${bm.tam_year})
Market growth: ${bm.cagr_display}
Typical deal sizes: SMB ${bm.typical_deal_size.smb} · Mid-Market ${bm.typical_deal_size.mid_market} · Enterprise ${bm.typical_deal_size.enterprise}
Primary ICP roles: ${bm.common_icp_roles.slice(0, 4).join(', ')}
Sales cycle: SMB ${bm.sales_cycle_days.smb}d · Mid-Market ${bm.sales_cycle_days.mid_market}d · Enterprise ${bm.sales_cycle_days.enterprise}d
Key buying triggers: ${bm.key_buying_triggers.slice(0, 3).join('; ')}
Competitive density: ${bm.competitive_density}

IMPORTANT: Your TAM estimate MUST fall within or near the benchmark range above. Deviations > 2x require explicit justification citing a specific market segment or company niche.`;
}
