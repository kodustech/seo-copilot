-- Dynamic Clay-style columns on research tables + cell values on rows.
-- Also stable slug for MCP / deep links (?table=slug).

ALTER TABLE public.research_tables
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS columns JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.research_rows
  ADD COLUMN IF NOT EXISTS cells JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill slugs for existing tables (id prefix keeps uniqueness).
UPDATE public.research_tables
SET slug = lower(regexp_replace(
  coalesce(nullif(trim(name), ''), 'list') || '-' || substr(id::text, 1, 8),
  '[^a-z0-9]+',
  '-',
  'g'
))
WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS research_tables_slug_uniq
  ON public.research_tables (slug)
  WHERE slug IS NOT NULL;

COMMENT ON COLUMN public.research_tables.slug IS
  'Stable human-readable id for MCP and /research?table=slug';
COMMENT ON COLUMN public.research_tables.columns IS
  'Array of column defs: {key,label,type,enrich,...}';
COMMENT ON COLUMN public.research_rows.cells IS
  'Map column_key -> {value,status,evidence,sources,updatedAt}';
