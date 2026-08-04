-- Recovery history for destructive research-list and outreach-sequence changes.
-- Payloads are deliberately self-contained: a deleted parent can be restored
-- with the same IDs, including its rows, contacts, and delivery queue.

CREATE TABLE IF NOT EXISTS public.research_table_snapshots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id         UUID NOT NULL,
  reason           TEXT NOT NULL DEFAULT 'save',
  table_data       JSONB NOT NULL,
  rows_data        JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count        INT NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_table_snapshots_table_idx
  ON public.research_table_snapshots (table_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.outreach_sequence_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id       UUID NOT NULL,
  reason            TEXT NOT NULL DEFAULT 'save',
  sequence_data     JSONB NOT NULL,
  steps_data        JSONB NOT NULL DEFAULT '[]'::jsonb,
  enrollments_data  JSONB NOT NULL DEFAULT '[]'::jsonb,
  tasks_data        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outreach_sequence_snapshots_sequence_idx
  ON public.outreach_sequence_snapshots (sequence_id, created_at DESC);

ALTER TABLE public.research_table_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_sequence_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['research_table_snapshots', 'outreach_sequence_snapshots']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_select', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_insert') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', t || '_insert', t);
    END IF;
  END LOOP;
END $$;
