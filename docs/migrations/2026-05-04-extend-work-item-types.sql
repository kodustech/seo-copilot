-- Migration: extend growth_work_items to track non-content work
-- Date: 2026-05-04
-- Why: Junior + Ed need a single visual source of truth for the whole growth
-- backlog (content creation + content updates + ops/dev tasks). Previously
-- we had Notion sheets + a markdown TRACKER alongside the Kanban; consolidating
-- to one board.
--
-- Two changes:
-- 1. item_type accepts 'update' and 'task' alongside the existing content types.
-- 2. stage check constraint dropped — stage is now loose (slug-derived from
--    user-configured columns), so any string is valid. Default still 'backlog'.

begin;

-- 1. Extend item_type allowed values.
alter table public.growth_work_items
  drop constraint if exists growth_work_items_item_type_check;

alter table public.growth_work_items
  add constraint growth_work_items_item_type_check
  check (item_type in ('idea', 'keyword', 'title', 'article', 'social', 'update', 'task'));

-- 2. Drop strict stage whitelist (columns/stages are user-configured).
alter table public.growth_work_items
  drop constraint if exists growth_work_items_stage_check;

commit;
