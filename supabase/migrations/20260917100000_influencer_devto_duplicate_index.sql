-- Keep the bounded Dev.to duplicate scan on the published timeline.
-- The partial predicate avoids indexing drafts and other non-published queue rows.
create index if not exists persona_activities_published_at_idx
  on public.persona_activities (published_at desc nulls last, id)
  where status = 'published';
