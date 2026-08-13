-- Persona memory: a place for a persona to save studies, findings, and notes
-- across shifts so it builds on past work instead of re-researching from zero.
-- Simple append + keyword search; no embeddings yet.
--
-- Safe to re-run.

create table if not exists public.persona_memory (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  title text not null,
  content text not null,
  tags text[] not null default '{}',
  created_by text not null default 'agent',
  created_at timestamptz not null default now()
);

create index if not exists persona_memory_persona_idx
  on public.persona_memory (persona_id, created_at desc);

alter table public.persona_memory enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'persona_memory'
      and policyname = 'persona_memory_authenticated_all'
  ) then
    create policy persona_memory_authenticated_all
      on public.persona_memory
      for all to authenticated
      using (true) with check (true);
  end if;
end $$;
