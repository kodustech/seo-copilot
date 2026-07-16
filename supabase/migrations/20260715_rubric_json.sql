-- Custom per-table rubrics: a table can carry its own rubric (compiled from a
-- natural-language ICP description) instead of referencing a built-in one.
ALTER TABLE research_tables
  ADD COLUMN IF NOT EXISTS rubric_json JSONB;
