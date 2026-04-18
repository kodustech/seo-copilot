-- Reply Radar: per-user target X accounts + surfaced reply candidates + LLM drafts.

-- ---------------------------------------------------------------------------
-- x_target_accounts: list of X accounts a user wants monitored (max 20).
-- ---------------------------------------------------------------------------
create table if not exists public.x_target_accounts (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  x_username text not null,
  x_user_id text not null,
  display_name text,
  avatar_url text,
  enabled boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists x_target_accounts_user_username_uidx
  on public.x_target_accounts (user_email, lower(x_username));

create index if not exists x_target_accounts_user_enabled_idx
  on public.x_target_accounts (user_email, enabled);

-- Enforce hard cap of 20 targets per user
create or replace function public.enforce_x_target_accounts_limit()
returns trigger as $$
declare
  current_count int;
begin
  select count(*) into current_count
  from public.x_target_accounts
  where user_email = new.user_email;

  if current_count >= 20 then
    raise exception 'Maximum of 20 target accounts per user reached'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'x_target_accounts_enforce_limit'
  ) then
    create trigger x_target_accounts_enforce_limit
      before insert on public.x_target_accounts
      for each row execute function public.enforce_x_target_accounts_limit();
  end if;
end $$;

create or replace function public.set_x_target_accounts_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'x_target_accounts_set_updated_at'
  ) then
    create trigger x_target_accounts_set_updated_at
      before update on public.x_target_accounts
      for each row execute function public.set_x_target_accounts_updated_at();
  end if;
end $$;

alter table public.x_target_accounts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_target_accounts'
      and policyname = 'x_target_accounts_select_own'
  ) then
    create policy x_target_accounts_select_own
      on public.x_target_accounts for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_target_accounts'
      and policyname = 'x_target_accounts_insert_own'
  ) then
    create policy x_target_accounts_insert_own
      on public.x_target_accounts for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_target_accounts'
      and policyname = 'x_target_accounts_update_own'
  ) then
    create policy x_target_accounts_update_own
      on public.x_target_accounts for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_target_accounts'
      and policyname = 'x_target_accounts_delete_own'
  ) then
    create policy x_target_accounts_delete_own
      on public.x_target_accounts for delete
      using (user_email = auth.jwt() ->> 'email');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- x_reply_candidates: posts surfaced by the cron for the user to reply to.
-- ---------------------------------------------------------------------------
create table if not exists public.x_reply_candidates (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  target_account_id uuid not null references public.x_target_accounts(id) on delete cascade,
  x_post_id text not null,
  post_url text not null,
  post_text text not null,
  post_created_at timestamptz not null,
  author_username text not null,
  author_display_name text,
  author_avatar_url text,
  metrics jsonb not null default '{}'::jsonb,
  engagement_score numeric not null default 0,
  status text not null default 'new' check (status in ('new', 'drafted', 'dismissed', 'replied', 'snoozed')),
  snoozed_until timestamptz,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists x_reply_candidates_user_post_uidx
  on public.x_reply_candidates (user_email, x_post_id);

create index if not exists x_reply_candidates_user_status_idx
  on public.x_reply_candidates (user_email, status, post_created_at desc);

create index if not exists x_reply_candidates_target_idx
  on public.x_reply_candidates (target_account_id, post_created_at desc);

create or replace function public.set_x_reply_candidates_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'x_reply_candidates_set_updated_at'
  ) then
    create trigger x_reply_candidates_set_updated_at
      before update on public.x_reply_candidates
      for each row execute function public.set_x_reply_candidates_updated_at();
  end if;
end $$;

alter table public.x_reply_candidates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_reply_candidates'
      and policyname = 'x_reply_candidates_select_own'
  ) then
    create policy x_reply_candidates_select_own
      on public.x_reply_candidates for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_reply_candidates'
      and policyname = 'x_reply_candidates_update_own'
  ) then
    create policy x_reply_candidates_update_own
      on public.x_reply_candidates for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  -- Inserts come from the cron via service role; no user-facing insert policy.
end $$;

-- ---------------------------------------------------------------------------
-- x_reply_drafts: LLM-generated reply drafts per candidate (N angles).
-- ---------------------------------------------------------------------------
create table if not exists public.x_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.x_reply_candidates(id) on delete cascade,
  user_email text not null,
  position integer not null,
  angle text not null check (angle in ('contrarian', 'add_specificity', 'sharp_question')),
  draft_text text not null,
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists x_reply_drafts_candidate_position_uidx
  on public.x_reply_drafts (candidate_id, position);

create index if not exists x_reply_drafts_user_idx
  on public.x_reply_drafts (user_email);

create or replace function public.set_x_reply_drafts_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'x_reply_drafts_set_updated_at'
  ) then
    create trigger x_reply_drafts_set_updated_at
      before update on public.x_reply_drafts
      for each row execute function public.set_x_reply_drafts_updated_at();
  end if;
end $$;

alter table public.x_reply_drafts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_reply_drafts'
      and policyname = 'x_reply_drafts_select_own'
  ) then
    create policy x_reply_drafts_select_own
      on public.x_reply_drafts for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'x_reply_drafts'
      and policyname = 'x_reply_drafts_update_own'
  ) then
    create policy x_reply_drafts_update_own
      on public.x_reply_drafts for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;
end $$;
