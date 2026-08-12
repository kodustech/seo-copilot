-- Influencer module: fleet of openly-AI personas that draft, publish and learn.
-- Five tables: personas (identity), persona_channels (where + how much rein),
-- persona_activities (the queue and the audit trail), persona_activity_metrics
-- (engagement snapshots), persona_learnings (what worked / what to avoid).
--
-- Safe to re-run.

create table if not exists public.personas (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  display_name text not null,
  bio text not null,
  avatar_url text,
  backstory text not null,
  -- Mandatory "I am an AI operated by Kodus" line. Every persona is openly AI;
  -- onboarding checks it is in the platform bio before a channel activates.
  disclosure text not null,
  beat text not null,
  tone text,
  writing_guidelines text,
  preferred_words text[] not null default '{}',
  forbidden_words text[] not null default '{}',
  allowed_topics text[] not null default '{}',
  forbidden_topics text[] not null default '{}',
  -- lanes, feeds, themes, cadence — generation config, free-form on purpose
  content_config jsonb not null default '{}',
  status text not null default 'paused' check (status in ('active', 'paused')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.persona_channels (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  platform text not null check (
    platform in ('x', 'devto', 'blog', 'medium', 'reddit', 'hackernews')
  ),
  external_handle text,
  publish_via text not null check (
    publish_via in ('post_bridge', 'api', 'n8n', 'manual')
  ),
  automation_level text not null default 'approve_first' check (
    automation_level in ('auto', 'approve_first', 'draft_only')
  ),
  max_posts_per_day integer not null default 2,
  max_replies_per_day integer not null default 5,
  -- Name of the env var / external account ref. Never the credential itself.
  credentials_ref text,
  -- e.g. { "post_bridge_account_id": 123 } or { "canonical_base_url": "..." }
  channel_config jsonb not null default '{}',
  -- checklist: { "account_created": true, "automation_label": true, ... }
  onboarding jsonb not null default '{}',
  status text not null default 'pending_setup' check (
    status in ('pending_setup', 'active', 'paused')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (persona_id, platform)
);

create table if not exists public.persona_activities (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  channel_id uuid not null references public.persona_channels(id) on delete cascade,
  kind text not null check (
    kind in ('post', 'reply', 'quote', 'article', 'crosspost')
  ),
  status text not null default 'draft' check (
    status in ('draft', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'discarded')
  ),
  title text,
  content text not null,
  -- hook, cta, hashtags, lane, theme, canonical_url, reply target…
  content_meta jsonb not null default '{}',
  source_kind text,
  source_ref text,
  parent_activity_id uuid references public.persona_activities(id) on delete set null,
  scheduled_at timestamptz,
  published_at timestamptz,
  external_id text,
  external_url text,
  error text,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists persona_activities_persona_status_idx
  on public.persona_activities (persona_id, status);

create index if not exists persona_activities_status_scheduled_idx
  on public.persona_activities (status, scheduled_at);

create index if not exists persona_activities_created_idx
  on public.persona_activities (created_at desc);

create table if not exists public.persona_activity_metrics (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.persona_activities(id) on delete cascade,
  collected_at timestamptz not null default now(),
  metrics jsonb not null default '{}',
  engagement_score numeric not null default 0
);

create index if not exists persona_activity_metrics_activity_idx
  on public.persona_activity_metrics (activity_id, collected_at desc);

create table if not exists public.persona_learnings (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  kind text not null check (kind in ('works', 'avoid')),
  insight text not null,
  evidence jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now()
);

create index if not exists persona_learnings_persona_status_idx
  on public.persona_learnings (persona_id, status);

-- updated_at trigger, shared by the three mutable tables
create or replace function public.set_influencer_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array['personas', 'persona_channels', 'persona_activities']
  loop
    if not exists (
      select 1 from pg_trigger where tgname = t || '_set_updated_at'
    ) then
      execute format(
        'create trigger %I before update on public.%I for each row execute function public.set_influencer_updated_at()',
        t || '_set_updated_at', t
      );
    end if;
  end loop;
end $$;

-- RLS: the fleet is a team-level surface, not per-user data. Any authenticated
-- app user can see and manage it; crons run on the admin handle and bypass RLS.
do $$
declare
  t text;
begin
  foreach t in array array[
    'personas', 'persona_channels', 'persona_activities',
    'persona_activity_metrics', 'persona_learnings'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = t || '_authenticated_all'
    ) then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated_all', t
      );
    end if;
  end loop;
end $$;
