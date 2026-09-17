-- Keep the bounded Dev.to duplicate scan on the published timeline without
-- blocking the influencer queue while PostgreSQL builds the index.
create index concurrently if not exists persona_activities_published_at_idx
  on public.persona_activities (published_at desc nulls last, id)
  where status = 'published';
