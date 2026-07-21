-- People history: never lose contacts when enrich/agent overwrites a row.
-- Snapshots store the full people list for a research_row before mutations.

CREATE TABLE IF NOT EXISTS public.research_people_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id       UUID NOT NULL REFERENCES public.research_rows(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL DEFAULT 'save',
  -- Full people array at snapshot time (JSON objects, camelCase fields)
  people       JSONB NOT NULL DEFAULT '[]'::jsonb,
  person_count INT NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_people_snapshots_row_idx
  ON public.research_people_snapshots (row_id, created_at DESC);

ALTER TABLE public.research_people_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'research_people_snapshots_select'
  ) THEN
    CREATE POLICY research_people_snapshots_select
      ON public.research_people_snapshots FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'research_people_snapshots_insert'
  ) THEN
    CREATE POLICY research_people_snapshots_insert
      ON public.research_people_snapshots FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  -- No update/delete for authenticated — history is append-only via service role
END $$;
