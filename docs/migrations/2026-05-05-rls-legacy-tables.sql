-- Enable RLS on the three legacy tables that the Supabase advisor flagged:
-- conversations / scheduled_jobs / job_runs. All are per-user data; service
-- role (used by /api/cron/execute and the in-process scheduler) keeps
-- bypassing RLS, so cron paths continue to work without changes.
--
-- Pattern: each user reads/writes only their own rows; job_runs ownership
-- is derived via the parent scheduled_job. auth.jwt() lookups are wrapped in
-- a SELECT for query-plan caching (per Supabase RLS perf guidance).

-- conversations ---------------------------------------------------------------

alter table public.conversations enable row level security;

drop policy if exists "Users can read own conversations" on public.conversations;
create policy "Users can read own conversations"
  on public.conversations for select to authenticated
  using (user_email = (select auth.jwt() ->> 'email'));

drop policy if exists "Users can write own conversations" on public.conversations;
create policy "Users can write own conversations"
  on public.conversations for all to authenticated
  using (user_email = (select auth.jwt() ->> 'email'))
  with check (user_email = (select auth.jwt() ->> 'email'));

drop policy if exists "Service role manages conversations" on public.conversations;
create policy "Service role manages conversations"
  on public.conversations for all to service_role
  using (true) with check (true);

-- scheduled_jobs --------------------------------------------------------------

alter table public.scheduled_jobs enable row level security;

drop policy if exists "Users can read own scheduled_jobs" on public.scheduled_jobs;
create policy "Users can read own scheduled_jobs"
  on public.scheduled_jobs for select to authenticated
  using (user_email = (select auth.jwt() ->> 'email'));

drop policy if exists "Users can write own scheduled_jobs" on public.scheduled_jobs;
create policy "Users can write own scheduled_jobs"
  on public.scheduled_jobs for all to authenticated
  using (user_email = (select auth.jwt() ->> 'email'))
  with check (user_email = (select auth.jwt() ->> 'email'));

drop policy if exists "Service role manages scheduled_jobs" on public.scheduled_jobs;
create policy "Service role manages scheduled_jobs"
  on public.scheduled_jobs for all to service_role
  using (true) with check (true);

-- job_runs --------------------------------------------------------------------
-- No user_email column; ownership is derived via the parent scheduled_jobs.
-- Writes only happen from cron (service role), so no authenticated write
-- policy is needed.

alter table public.job_runs enable row level security;

drop policy if exists "Users can read own job_runs" on public.job_runs;
create policy "Users can read own job_runs"
  on public.job_runs for select to authenticated
  using (
    exists (
      select 1
      from public.scheduled_jobs sj
      where sj.id = job_runs.job_id
        and sj.user_email = (select auth.jwt() ->> 'email')
    )
  );

drop policy if exists "Service role manages job_runs" on public.job_runs;
create policy "Service role manages job_runs"
  on public.job_runs for all to service_role
  using (true) with check (true);
