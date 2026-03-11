-- LLM Mentions Snapshots (DataForSEO)
-- Daily cache of AI visibility data to avoid per-request API costs

create table if not exists llm_mentions_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  platform text not null check (platform in ('google', 'chat_gpt')),
  mentions integer not null default 0,
  ai_search_volume bigint not null default 0,
  impressions bigint not null default 0,
  top_sources jsonb not null default '[]'::jsonb,
  top_questions jsonb not null default '[]'::jsonb,
  raw_response jsonb,
  created_at timestamp with time zone default now(),
  unique (snapshot_date, platform)
);

-- RLS: any authenticated user can read (global data, not per-user)
alter table llm_mentions_snapshots enable row level security;

create policy "Authenticated users can read snapshots"
  on llm_mentions_snapshots for select
  to authenticated
  using (true);

-- Service role can insert/update (used by cron)
create policy "Service role can manage snapshots"
  on llm_mentions_snapshots for all
  to service_role
  using (true)
  with check (true);

-- Index for fast dashboard queries
create index idx_llm_mentions_snapshots_latest
  on llm_mentions_snapshots (snapshot_date desc, platform);
