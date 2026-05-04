-- Migration: add responsible_email to growth_work_items
-- Date: 2026-05-04
-- Why: Junior + Ed need to assign each card to a person separately from
-- "createdBy" (which is just whoever made the card via UI/MCP). One person
-- often creates a card for someone else to do.

begin;

alter table public.growth_work_items
  add column if not exists responsible_email text;

create index if not exists growth_work_items_responsible_email_idx
  on public.growth_work_items (responsible_email);

commit;
