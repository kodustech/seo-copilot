-- Many-to-many link table between goals and growth_work_items. A card can
-- contribute to multiple goals; a goal can be backed by multiple cards.
-- When a goal has at least one link, its current_count switches to auto
-- mode: count of linked work items whose stage is in the "done" set.

create table if not exists public.goal_links (
  goal_id uuid not null references public.goals(id) on delete cascade,
  work_item_id uuid not null
    references public.growth_work_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by_email text,
  primary key (goal_id, work_item_id)
);

create index if not exists goal_links_work_item_idx
  on public.goal_links (work_item_id);

create index if not exists goal_links_goal_idx
  on public.goal_links (goal_id);

alter table public.goal_links enable row level security;

drop policy if exists "Authenticated users can read goal_links" on public.goal_links;
create policy "Authenticated users can read goal_links"
  on public.goal_links for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can write goal_links" on public.goal_links;
create policy "Authenticated users can write goal_links"
  on public.goal_links for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Service role can manage goal_links" on public.goal_links;
create policy "Service role can manage goal_links"
  on public.goal_links for all
  to service_role
  using (true)
  with check (true);
