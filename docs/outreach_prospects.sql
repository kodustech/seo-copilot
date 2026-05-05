-- Outreach CRM — backlink / guest-post / podcast / awesome-list / newsletter
-- prospects we want to pitch. One row per (domain, target_type) tuple in
-- practice; the unique constraint is on URL only since that's the
-- backlink-target identity when present.

create table if not exists outreach_prospects (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  url text,
  target_type text not null check (target_type in (
    'listicle',
    'guest_post',
    'podcast',
    'awesome_list',
    'article',
    'newsletter',
    'other'
  )),
  contact_name text,
  contact_email text,
  contact_url text,
  dr integer,
  niche text,
  status text not null default 'prospect' check (status in (
    'prospect',
    'researching',
    'drafted',
    'contacted',
    'replied',
    'won',
    'lost',
    'snoozed'
  )),
  priority text not null default 'medium' check (priority in (
    'high',
    'medium',
    'low'
  )),
  last_touch_at timestamptz,
  next_followup_at timestamptz,
  notes text,
  responsible_email text,
  source text,
  source_mention_id uuid references social_mentions(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists outreach_prospects_url_unique
  on outreach_prospects (url) where url is not null;

create index if not exists outreach_prospects_status_idx
  on outreach_prospects (status, created_at desc);

create index if not exists outreach_prospects_responsible_idx
  on outreach_prospects (responsible_email, status);

create index if not exists outreach_prospects_domain_idx
  on outreach_prospects (domain);

create index if not exists outreach_prospects_followup_idx
  on outreach_prospects (next_followup_at)
  where next_followup_at is not null;

alter table outreach_prospects enable row level security;

create policy "Authenticated users can read prospects"
  on outreach_prospects for select
  to authenticated
  using (true);

create policy "Authenticated users can write prospects"
  on outreach_prospects for all
  to authenticated
  using (true)
  with check (true);

create policy "Service role can manage prospects"
  on outreach_prospects for all
  to service_role
  using (true)
  with check (true);

create or replace function update_outreach_prospects_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_outreach_prospects_updated_at
  before update on outreach_prospects
  for each row
  execute function update_outreach_prospects_updated_at();
