-- Voice profiles for global (brand) and per-user writing policy.

create table if not exists public.brand_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  scope text not null unique default 'kodus',
  tone text,
  persona text,
  writing_guidelines text,
  preferred_words text[] not null default '{}',
  forbidden_words text[] not null default '{}',
  additional_instructions text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.brand_voice_profiles
  add column if not exists scope text;

alter table public.brand_voice_profiles
  add column if not exists tone text;

alter table public.brand_voice_profiles
  add column if not exists persona text;

alter table public.brand_voice_profiles
  add column if not exists writing_guidelines text;

alter table public.brand_voice_profiles
  add column if not exists preferred_words text[] not null default '{}';

alter table public.brand_voice_profiles
  add column if not exists forbidden_words text[] not null default '{}';

alter table public.brand_voice_profiles
  add column if not exists additional_instructions text;

alter table public.brand_voice_profiles
  add column if not exists updated_by text;

alter table public.brand_voice_profiles
  add column if not exists created_at timestamptz not null default now();

alter table public.brand_voice_profiles
  add column if not exists updated_at timestamptz not null default now();

update public.brand_voice_profiles
set scope = 'kodus'
where scope is null;

alter table public.brand_voice_profiles
  alter column scope set not null;

create unique index if not exists brand_voice_profiles_scope_uidx
  on public.brand_voice_profiles (scope);

create table if not exists public.user_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_email text not null unique,
  tone text,
  persona text,
  writing_guidelines text,
  preferred_words text[] not null default '{}',
  forbidden_words text[] not null default '{}',
  additional_instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_voice_profiles
  add column if not exists user_email text;

alter table public.user_voice_profiles
  add column if not exists tone text;

alter table public.user_voice_profiles
  add column if not exists persona text;

alter table public.user_voice_profiles
  add column if not exists writing_guidelines text;

alter table public.user_voice_profiles
  add column if not exists preferred_words text[] not null default '{}';

alter table public.user_voice_profiles
  add column if not exists forbidden_words text[] not null default '{}';

alter table public.user_voice_profiles
  add column if not exists additional_instructions text;

alter table public.user_voice_profiles
  add column if not exists created_at timestamptz not null default now();

alter table public.user_voice_profiles
  add column if not exists updated_at timestamptz not null default now();

alter table public.user_voice_profiles
  alter column user_email set not null;

create unique index if not exists user_voice_profiles_user_email_uidx
  on public.user_voice_profiles (user_email);

alter table public.brand_voice_profiles enable row level security;
alter table public.user_voice_profiles enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'brand_voice_profiles'
      and policyname = 'brand_voice_profiles_select_authenticated'
  ) then
    create policy brand_voice_profiles_select_authenticated
      on public.brand_voice_profiles
      for select
      using (auth.role() = 'authenticated');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_voice_profiles'
      and policyname = 'user_voice_profiles_select_own'
  ) then
    create policy user_voice_profiles_select_own
      on public.user_voice_profiles
      for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_voice_profiles'
      and policyname = 'user_voice_profiles_insert_own'
  ) then
    create policy user_voice_profiles_insert_own
      on public.user_voice_profiles
      for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_voice_profiles'
      and policyname = 'user_voice_profiles_update_own'
  ) then
    create policy user_voice_profiles_update_own
      on public.user_voice_profiles
      for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_voice_profiles'
      and policyname = 'user_voice_profiles_delete_own'
  ) then
    create policy user_voice_profiles_delete_own
      on public.user_voice_profiles
      for delete
      using (user_email = auth.jwt() ->> 'email');
  end if;
end $$;
