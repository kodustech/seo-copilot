-- Daily YOLO social queue (pre-generated cards per user)
create table if not exists public.social_yolo_posts (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  batch_date date not null,
  position integer not null,
  lane text not null check (lane in ('blog', 'changelog', 'mixed')),
  theme text not null,
  platform text not null,
  hook text not null default '',
  content text not null,
  cta text not null default '',
  hashtags text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'selected', 'discarded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.social_yolo_posts
  add column if not exists lane text not null default 'mixed' check (lane in ('blog', 'changelog', 'mixed')),
  add column if not exists theme text not null default '',
  add column if not exists platform text not null default 'Social',
  add column if not exists hook text not null default '',
  add column if not exists content text not null default '',
  add column if not exists cta text not null default '',
  add column if not exists hashtags text[] not null default '{}',
  add column if not exists status text not null default 'draft' check (status in ('draft', 'selected', 'discarded')),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists social_yolo_posts_user_batch_position_idx
  on public.social_yolo_posts (user_email, batch_date, position);

create index if not exists social_yolo_posts_user_batch_idx
  on public.social_yolo_posts (user_email, batch_date desc);

create index if not exists social_yolo_posts_status_idx
  on public.social_yolo_posts (status);

create or replace function public.set_social_yolo_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'social_yolo_posts_set_updated_at'
  ) then
    create trigger social_yolo_posts_set_updated_at
      before update on public.social_yolo_posts
      for each row execute function public.set_social_yolo_updated_at();
  end if;
end $$;

alter table public.social_yolo_posts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'social_yolo_posts'
      and policyname = 'social_yolo_posts_select_own'
  ) then
    create policy social_yolo_posts_select_own
      on public.social_yolo_posts
      for select
      using (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'social_yolo_posts'
      and policyname = 'social_yolo_posts_insert_own'
  ) then
    create policy social_yolo_posts_insert_own
      on public.social_yolo_posts
      for insert
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'social_yolo_posts'
      and policyname = 'social_yolo_posts_update_own'
  ) then
    create policy social_yolo_posts_update_own
      on public.social_yolo_posts
      for update
      using (user_email = auth.jwt() ->> 'email')
      with check (user_email = auth.jwt() ->> 'email');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'social_yolo_posts'
      and policyname = 'social_yolo_posts_delete_own'
  ) then
    create policy social_yolo_posts_delete_own
      on public.social_yolo_posts
      for delete
      using (user_email = auth.jwt() ->> 'email');
  end if;
end $$;
