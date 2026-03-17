-- ============================================================
-- AB GTM Platform — Supabase Schema
-- Run this in your Supabase SQL editor: 
-- https://supabase.com/dashboard/project/cwcvneluhlimhlzowabv/sql
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── strategies ──────────────────────────────────────────────────
create table if not exists public.strategies (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  company_name     text not null,
  industry         text,
  company_url      text,
  scraped_profile  jsonb default '{}'::jsonb,
  step_1_market    jsonb,
  step_2_tam       jsonb,
  step_3_icp       jsonb,
  step_4_sourcing  jsonb,
  step_5_keywords  jsonb,
  step_6_messaging jsonb,
  steps_completed  integer default 0,
  total_tokens     integer default 0,
  status           text default 'in_progress' check (status in ('in_progress','complete','archived')),
  cache_key        text unique,
  last_viewed_at   timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Row Level Security
alter table public.strategies enable row level security;
create policy "Users manage own strategies"
  on public.strategies for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── strategy_summary VIEW (lightweight vault list) ──────────────
create or replace view public.strategy_summary as
select
  s.id,
  s.user_id,
  s.company_name,
  s.industry,
  s.steps_completed,
  s.status,
  s.total_tokens,
  s.cache_key,
  s.created_at,
  s.updated_at,
  (s.step_1_market->>'gtm_relevance_score')::int   as gtm_score,
  s.step_2_tam->>'tam_size_estimate'               as tam_size,
  s.step_3_icp->>'primary_icp'                     as primary_icp
from public.strategies s;

-- ── icp_profiles ────────────────────────────────────────────────
create table if not exists public.icp_profiles (
  id               uuid primary key default uuid_generate_v4(),
  strategy_id      uuid unique references public.strategies(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  company_name     text,
  primary_icp      text,
  secondary_icp    text,
  firmographics    text,
  buying_triggers  jsonb,
  core_pain_points text,
  decision_makers  jsonb,
  deal_cycle       text,
  objections       jsonb,
  created_at       timestamptz default now()
);
alter table public.icp_profiles enable row level security;
create policy "Users manage own ICP" on public.icp_profiles for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── keywords ────────────────────────────────────────────────────
create table if not exists public.keywords (
  id                uuid primary key default uuid_generate_v4(),
  strategy_id       uuid unique references public.strategies(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  company_name      text,
  primary_keywords  jsonb,
  secondary_keywords jsonb,
  boolean_query     text,
  linkedin_search   text,
  intent_signals    jsonb,
  content_topics    jsonb,
  created_at        timestamptz default now()
);
alter table public.keywords enable row level security;
create policy "Users manage own keywords" on public.keywords for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── messaging_sequences ─────────────────────────────────────────
create table if not exists public.messaging_sequences (
  id           uuid primary key default uuid_generate_v4(),
  strategy_id  uuid unique references public.strategies(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  company_name text,
  email_1      jsonb,
  email_2      jsonb,
  email_3      jsonb,
  follow_up    text,
  created_at   timestamptz default now()
);
alter table public.messaging_sequences enable row level security;
create policy "Users manage own messaging" on public.messaging_sequences for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── leads ───────────────────────────────────────────────────────
create table if not exists public.leads (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text,
  title          text,
  company        text,
  email          text,
  linkedin_url   text,
  website        text,
  location       text,
  source_file    text,
  source_type    text default 'csv',
  score          integer default 50,
  status         text default 'unprocessed',
  tags           jsonb default '["Imported"]'::jsonb,
  notes          text,
  action_taken   text,
  gtm_analysis   jsonb,
  activity_log   jsonb default '[]'::jsonb,
  score_override boolean default false,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
alter table public.leads enable row level security;
create policy "Users manage own leads" on public.leads for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── rate_limits ─────────────────────────────────────────────────
create table if not exists public.rate_limits (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer default 0,
  tokens_used   integer default 0,
  unique (user_id, window_start)
);
alter table public.rate_limits enable row level security;
create policy "Users manage own rate limits" on public.rate_limits for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── analysis_runs (usage logging) ───────────────────────────────
create table if not exists public.analysis_runs (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete set null,
  strategy_id  uuid references public.strategies(id) on delete set null,
  run_type     text,
  step_number  integer,
  company_name text,
  tokens_used  integer default 0,
  cost_usd     numeric(10,6) default 0,
  model        text default 'gpt-4o-mini',
  cache_hit    boolean default false,
  duration_ms  integer,
  created_at   timestamptz default now()
);
alter table public.analysis_runs enable row level security;
create policy "Users view own runs" on public.analysis_runs for select
  using (auth.uid() = user_id);
create policy "Service inserts runs" on public.analysis_runs for insert
  with check (true);

-- ── Indexes for performance ──────────────────────────────────────
create index if not exists strategies_user_updated on public.strategies(user_id, updated_at desc);
create index if not exists strategies_cache_key    on public.strategies(cache_key);
create index if not exists strategies_status       on public.strategies(user_id, status);
create index if not exists leads_user_id           on public.leads(user_id);
create index if not exists leads_company           on public.leads(user_id, company);
create index if not exists analysis_runs_user      on public.analysis_runs(user_id, created_at desc);

