-- Recurring goals + input/output classification.
--
-- 1. `goals.kind` distinguishes leading "input" activities (effort you fully
--    control, e.g. "10 reddit comments") from lagging "output" results (what
--    you influence but don't fully control, e.g. "5 backlinks landed").
-- 2. `goal_recurrences` holds the *rule* ("10 reddits every week"). A cron job
--    materializes one concrete `goals` row per period from each active rule, so
--    every week keeps its own attainment history instead of overwriting.
-- 3. `goals.recurrence_id` links a materialized instance back to its rule and
--    is the idempotency key (rule_id + period_start is unique per instance).

-- ---------------------------------------------------------------------------
-- kind on goals
-- ---------------------------------------------------------------------------

alter table public.goals
  add column if not exists kind text not null default 'output'
    check (kind in ('input', 'output'));

-- ---------------------------------------------------------------------------
-- recurrence rules
-- ---------------------------------------------------------------------------

create table if not exists public.goal_recurrences (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  unit text,
  target_count integer not null default 1,
  kind text not null default 'output' check (kind in ('input', 'output')),
  priority text not null default 'medium' check (priority in (
    'high',
    'medium',
    'low'
  )),
  cadence text not null check (cadence in ('weekly', 'monthly')),
  active boolean not null default true,
  responsible_email text,
  project_ref text,
  notes text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists goal_recurrences_active_idx
  on public.goal_recurrences (active, cadence);

alter table public.goal_recurrences enable row level security;

drop policy if exists "Authenticated users can read goal_recurrences" on public.goal_recurrences;
create policy "Authenticated users can read goal_recurrences"
  on public.goal_recurrences for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can write goal_recurrences" on public.goal_recurrences;
create policy "Authenticated users can write goal_recurrences"
  on public.goal_recurrences for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Service role can manage goal_recurrences" on public.goal_recurrences;
create policy "Service role can manage goal_recurrences"
  on public.goal_recurrences for all
  to service_role
  using (true)
  with check (true);

create or replace function update_goal_recurrences_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_goal_recurrences_updated_at on public.goal_recurrences;
create trigger trg_goal_recurrences_updated_at
  before update on public.goal_recurrences
  for each row
  execute function update_goal_recurrences_updated_at();

-- ---------------------------------------------------------------------------
-- link materialized instances back to their rule
-- ---------------------------------------------------------------------------

alter table public.goals
  add column if not exists recurrence_id uuid
    references public.goal_recurrences(id) on delete set null;

-- One instance per rule per period. Lets the cron materializer upsert safely
-- no matter how often it runs.
create unique index if not exists goals_recurrence_period_uidx
  on public.goals (recurrence_id, period_start)
  where recurrence_id is not null;
