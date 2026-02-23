-- Calendar items for manual planning (ideas/tasks/campaigns)
create table if not exists public.calendar_items (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  title text not null,
  notes text,
  starts_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'done', 'canceled')),
  source_type text not null default 'idea' check (source_type in ('idea', 'task', 'campaign')),
  source_id text,
  post_type text check (post_type in ('article', 'social')),
  created_at timestamptz not null default now()
);

alter table public.calendar_items
  add column if not exists post_type text check (post_type in ('article', 'social'));

create index if not exists calendar_items_user_email_idx
  on public.calendar_items (user_email);

create index if not exists calendar_items_starts_at_idx
  on public.calendar_items (starts_at);

alter table public.calendar_items enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'calendar_items'
      and policyname = 'calendar_items_select_own'
  ) then
    create policy calendar_items_select_own
      on public.calendar_items
      for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'calendar_items'
      and policyname = 'calendar_items_insert_own'
  ) then
    create policy calendar_items_insert_own
      on public.calendar_items
      for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'calendar_items'
      and policyname = 'calendar_items_update_own'
  ) then
    create policy calendar_items_update_own
      on public.calendar_items
      for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'calendar_items'
      and policyname = 'calendar_items_delete_own'
  ) then
    create policy calendar_items_delete_own
      on public.calendar_items
      for delete
      using (user_email = auth.jwt() ->> 'email');
  end if;
end $$;
