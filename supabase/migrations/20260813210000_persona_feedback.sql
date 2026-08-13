-- Persona feedback: a channel for the operator to talk to a persona. The
-- persona reads new feedback on its next shift, applies it, and can distill it
-- into a durable "skill" (stored in personas.content_config.skills) that it
-- then applies on every shift.
--
-- Safe to re-run.

create table if not exists public.persona_feedback (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  body text not null,
  status text not null default 'new' check (status in ('new', 'applied')),
  created_by text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists persona_feedback_persona_idx
  on public.persona_feedback (persona_id, status, created_at desc);

alter table public.persona_feedback enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'persona_feedback'
      and policyname = 'persona_feedback_authenticated_all'
  ) then
    create policy persona_feedback_authenticated_all
      on public.persona_feedback
      for all to authenticated
      using (true) with check (true);
  end if;
end $$;
