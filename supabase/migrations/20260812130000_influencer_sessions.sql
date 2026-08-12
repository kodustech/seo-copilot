-- Agent runtime: a "job" a persona does is a session with a step-by-step
-- trace. This is the auditable record of everything the agent did to get to a
-- draft — not just the final post. The drafts it produces still land in
-- persona_activities and still pass the publish walls; a session never
-- publishes anything itself.
--
-- Safe to re-run.

create table if not exists public.persona_sessions (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  trigger text not null default 'manual'
    check (trigger in ('manual', 'scheduled', 'reactive')),
  goal text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  -- Snapshot of what it actually ran on, for auditing cost/behavior.
  model_provider text,
  model_name text,
  result_summary text,
  error text,
  created_by text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists persona_sessions_persona_idx
  on public.persona_sessions (persona_id, started_at desc);

create index if not exists persona_sessions_status_idx
  on public.persona_sessions (status);

create table if not exists public.persona_session_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.persona_sessions(id) on delete cascade,
  idx integer not null,
  kind text not null
    check (kind in ('tool_call', 'tool_result', 'message', 'error')),
  tool text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists persona_session_steps_session_idx
  on public.persona_session_steps (session_id, idx);

do $$
declare
  t text;
begin
  foreach t in array array['persona_sessions', 'persona_session_steps']
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
