-- Supports stable newest-first keyset pagination for operator skill context.
create index if not exists persona_memory_operator_skill_keyset_idx
  on public.persona_memory (persona_id, id)
  where tags @> array['skill', 'operator']::text[];
