-- Per-persona model + provider credentials.
-- Each persona can run on its own provider/model with its own API key, so
-- billing is isolated (one key running dry pauses one persona, not the fleet)
-- and personas are genuinely independent. Keys are encrypted at rest; the
-- ciphertext is never returned to clients and never enters an agent sandbox.
--
-- Safe to re-run.

-- Which provider/model this persona operates on. NULL = fall back to the
-- global AI_PROVIDER default (keeps existing personas working unchanged).
alter table public.personas
  add column if not exists model_provider text
    check (model_provider is null or model_provider in ('kimi', 'google', 'openai', 'anthropic')),
  add column if not exists model_name text;

create table if not exists public.persona_credentials (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  provider text not null
    check (provider in ('kimi', 'google', 'openai', 'anthropic')),
  -- AES-256-GCM payload (v1.<iv>.<tag>.<ciphertext>). Never selected by normal
  -- reads — only the server-side model resolver decrypts it.
  encrypted_key text not null,
  key_last4 text not null default '',
  label text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One active credential per (persona, provider). Re-adding replaces it.
  unique (persona_id, provider)
);

create index if not exists persona_credentials_persona_idx
  on public.persona_credentials (persona_id);

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'persona_credentials_set_updated_at'
  ) then
    create trigger persona_credentials_set_updated_at
      before update on public.persona_credentials
      for each row execute function public.set_influencer_updated_at();
  end if;
end $$;

alter table public.persona_credentials enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'persona_credentials'
      and policyname = 'persona_credentials_authenticated_all'
  ) then
    create policy persona_credentials_authenticated_all
      on public.persona_credentials
      for all to authenticated using (true) with check (true);
  end if;
end $$;
