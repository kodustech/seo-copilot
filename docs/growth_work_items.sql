-- Unified kanban items for growth workflow
create table if not exists public.growth_work_items (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  title text not null,
  description text,
  -- 'update' and 'task' added 2026-05-04 to track non-content work on the same
  -- board (CTR fixes, schema sweeps, ops/dev tasks, decisions). See migrations/.
  item_type text not null default 'idea'
    check (item_type in ('idea', 'keyword', 'title', 'article', 'social', 'update', 'task')),
  -- Stage is intentionally loose: it gets set to the column slug when a card moves
  -- between user-configured columns. Any non-empty string is valid; 'backlog' is
  -- the default fallback.
  stage text not null default 'backlog',
  source text not null default 'manual'
    check (source in ('manual', 'blog', 'changelog', 'agent', 'n8n')),
  source_ref text,
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high')),
  link text,
  due_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists growth_work_items_user_email_idx
  on public.growth_work_items (user_email);

create index if not exists growth_work_items_stage_idx
  on public.growth_work_items (stage);

create index if not exists growth_work_items_updated_at_idx
  on public.growth_work_items (updated_at desc);

create unique index if not exists growth_work_items_user_source_ref_unique_idx
  on public.growth_work_items (user_email, source_ref)
  where source_ref is not null;

create or replace function public.set_growth_work_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_growth_work_items_updated_at on public.growth_work_items;

create trigger trg_growth_work_items_updated_at
before update on public.growth_work_items
for each row
execute function public.set_growth_work_items_updated_at();

alter table public.growth_work_items enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'growth_work_items'
      and policyname = 'growth_work_items_select_own'
  ) then
    create policy growth_work_items_select_own
      on public.growth_work_items
      for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'growth_work_items'
      and policyname = 'growth_work_items_insert_own'
  ) then
    create policy growth_work_items_insert_own
      on public.growth_work_items
      for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'growth_work_items'
      and policyname = 'growth_work_items_update_own'
  ) then
    create policy growth_work_items_update_own
      on public.growth_work_items
      for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;
end $$;
