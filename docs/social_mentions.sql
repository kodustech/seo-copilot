-- Social Mentions (Social Media Monitoring)
-- Stores qualified social media posts/comments where Kodus can engage

create table if not exists social_mentions (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('reddit', 'twitter', 'linkedin')),
  url text not null unique,
  author text,
  author_profile_url text,
  title text not null,
  content text not null,
  published_at timestamp with time zone,
  relevance text not null check (relevance in ('high', 'medium', 'low')),
  intent text not null check (intent in ('asking_help', 'complaining', 'comparing_tools', 'discussing', 'sharing_experience')),
  suggested_approach text not null,
  status text not null default 'new' check (status in ('new', 'contacted', 'replied', 'dismissed')),
  keywords_matched text[] not null default '{}',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table social_mentions enable row level security;

-- Any authenticated user can read (global data, not per-user)
create policy "Authenticated users can read mentions"
  on social_mentions for select
  to authenticated
  using (true);

-- Service role can insert/update (used by cron)
create policy "Service role can manage mentions"
  on social_mentions for all
  to service_role
  using (true)
  with check (true);

-- Indexes for dashboard queries
create index idx_social_mentions_status
  on social_mentions (status, created_at desc);

create index idx_social_mentions_platform
  on social_mentions (platform, created_at desc);

-- Auto-update updated_at
create or replace function update_social_mentions_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_social_mentions_updated_at
  before update on social_mentions
  for each row
  execute function update_social_mentions_updated_at();
