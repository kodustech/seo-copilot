-- Idea sessions: per-user cached output of the /ideas canvas (5 lanes of
-- ideation cards). Cache lives for ~6h; the API reads the latest session
-- for the user and regenerates if older than the TTL (enforced in app code,
-- not the DB).

create table if not exists public.idea_sessions (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  topic text,
  lanes jsonb not null default '[]'::jsonb,
  -- cards is a denormalized list to make list/filter easy without cracking lanes
  cards jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now()
);

create index if not exists idea_sessions_user_generated_idx
  on public.idea_sessions (user_email, generated_at desc);

alter table public.idea_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_sessions'
      and policyname = 'idea_sessions_select_own'
  ) then
    create policy idea_sessions_select_own
      on public.idea_sessions for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_sessions'
      and policyname = 'idea_sessions_insert_own'
  ) then
    create policy idea_sessions_insert_own
      on public.idea_sessions for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_sessions'
      and policyname = 'idea_sessions_delete_own'
  ) then
    create policy idea_sessions_delete_own
      on public.idea_sessions for delete
      using (user_email = auth.jwt() ->> 'email');
  end if;
end $$;

-- Dismissed / saved / promoted idea cards. User interactions persist even
-- after the generating session is gone, so they can be filtered out of
-- future regenerations.
create table if not exists public.idea_card_states (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  card_key text not null,
  state text not null check (state in ('saved', 'dismissed', 'promoted')),
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idea_card_states_user_card_uidx
  on public.idea_card_states (user_email, card_key);

create index if not exists idea_card_states_user_state_idx
  on public.idea_card_states (user_email, state);

create or replace function public.set_idea_card_states_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'idea_card_states_set_updated_at'
  ) then
    create trigger idea_card_states_set_updated_at
      before update on public.idea_card_states
      for each row execute function public.set_idea_card_states_updated_at();
  end if;
end $$;

alter table public.idea_card_states enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_card_states'
      and policyname = 'idea_card_states_select_own'
  ) then
    create policy idea_card_states_select_own
      on public.idea_card_states for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_card_states'
      and policyname = 'idea_card_states_insert_own'
  ) then
    create policy idea_card_states_insert_own
      on public.idea_card_states for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_card_states'
      and policyname = 'idea_card_states_update_own'
  ) then
    create policy idea_card_states_update_own
      on public.idea_card_states for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'idea_card_states'
      and policyname = 'idea_card_states_delete_own'
  ) then
    create policy idea_card_states_delete_own
      on public.idea_card_states for delete
      using (user_email = auth.jwt() ->> 'email');
  end if;
end $$;
