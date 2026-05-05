-- Create goals table. Same content as docs/goals.sql. Run once against prod.

create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  unit text,
  target_count integer not null default 1,
  current_count integer not null default 0,
  period_start date not null,
  period_end date not null,
  status text not null default 'active' check (status in (
    'active',
    'completed',
    'missed',
    'paused',
    'archived'
  )),
  priority text not null default 'medium' check (priority in (
    'high',
    'medium',
    'low'
  )),
  responsible_email text,
  project_ref text,
  notes text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists goals_status_idx
  on goals (status, period_end desc);

create index if not exists goals_period_idx
  on goals (period_start, period_end);

create index if not exists goals_responsible_idx
  on goals (responsible_email, status);

alter table goals enable row level security;

create policy "Authenticated users can read goals"
  on goals for select
  to authenticated
  using (true);

create policy "Authenticated users can write goals"
  on goals for all
  to authenticated
  using (true)
  with check (true);

create policy "Service role can manage goals"
  on goals for all
  to service_role
  using (true)
  with check (true);

create or replace function update_goals_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_goals_updated_at
  before update on goals
  for each row
  execute function update_goals_updated_at();
