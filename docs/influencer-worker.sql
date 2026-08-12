-- Digital worker: the persona plans its own work and executes it autonomously.
--   - disclosure becomes optional (the creator decides whether it's openly AI)
--   - persona_tasks is the persona's own backlog/plan: what it intends to do,
--     across channels, on a schedule. A planner fills it; a worker executes it.
--   - personas.mailbox_id links a persona to an outreach mailbox so it can send
--     and read email.
--
-- Safe to re-run.

-- Disclosure no longer mandatory.
alter table public.personas alter column disclosure drop not null;

-- Optional email identity: reuse the outreach mailbox infra.
alter table public.personas
  add column if not exists mailbox_id uuid;

create table if not exists public.persona_tasks (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  kind text not null default 'post'
    check (kind in ('post', 'article', 'reply', 'benchmark', 'site_update', 'email', 'research', 'other')),
  channel_platform text,
  title text not null,
  -- The instruction the worker hands to the agent for this task.
  goal text not null,
  status text not null default 'planned'
    check (status in ('planned', 'doing', 'done', 'failed', 'cancelled')),
  scheduled_for timestamptz not null default now(),
  session_id uuid references public.persona_sessions(id) on delete set null,
  result_summary text,
  error text,
  created_by text not null default 'planner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists persona_tasks_persona_status_idx
  on public.persona_tasks (persona_id, status);

create index if not exists persona_tasks_due_idx
  on public.persona_tasks (status, scheduled_for);

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'persona_tasks_set_updated_at'
  ) then
    create trigger persona_tasks_set_updated_at
      before update on public.persona_tasks
      for each row execute function public.set_influencer_updated_at();
  end if;
end $$;

alter table public.persona_tasks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'persona_tasks'
      and policyname = 'persona_tasks_authenticated_all'
  ) then
    create policy persona_tasks_authenticated_all
      on public.persona_tasks
      for all to authenticated using (true) with check (true);
  end if;
end $$;
