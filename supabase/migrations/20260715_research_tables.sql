-- ---------------------------------------------------------------------------
-- Clay-like ICP research tables: spreadsheet of companies + multi-source
-- research evidence + people/email waterfall results.
-- Shared workspace RLS (same posture as CRM / ICP tables).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS research_tables (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name             TEXT NOT NULL,
  rubric_id        TEXT NOT NULL DEFAULT 'qe-kodus-v1',
  description      TEXT,
  created_by_email TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_rows (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id            UUID NOT NULL REFERENCES research_tables(id) ON DELETE CASCADE,
  company_name        TEXT NOT NULL,
  domain              TEXT,
  source              TEXT NOT NULL DEFAULT 'manual',
  -- pending | researching | researched | failed
  status              TEXT NOT NULL DEFAULT 'pending',
  icp_score           NUMERIC,
  trigger_score       NUMERIC,
  fit_score           NUMERIC,
  anti_flags          TEXT[] DEFAULT '{}',
  why_now             TEXT,
  pass                BOOLEAN,
  pack_raw            JSONB DEFAULT '{}'::jsonb,
  last_researched_at  TIMESTAMPTZ,
  error               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS research_rows_table_domain_uniq
  ON research_rows (table_id, lower(domain))
  WHERE domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS research_rows_table_score_idx
  ON research_rows (table_id, icp_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS research_rows_table_status_idx
  ON research_rows (table_id, status);

CREATE TABLE IF NOT EXISTS research_evidence (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  row_id        UUID NOT NULL REFERENCES research_rows(id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL,
  kind          TEXT NOT NULL, -- trigger | fit | anti
  status        TEXT NOT NULL, -- pass | fail | unknown
  confidence    NUMERIC DEFAULT 0,
  evidence      TEXT,
  sources       JSONB DEFAULT '[]'::jsonb,
  weight        NUMERIC DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_evidence_row_idx
  ON research_evidence (row_id);

CREATE UNIQUE INDEX IF NOT EXISTS research_evidence_row_criterion_uniq
  ON research_evidence (row_id, criterion_id);

CREATE TABLE IF NOT EXISTS research_people (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  row_id          UUID NOT NULL REFERENCES research_rows(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT,
  linkedin        TEXT,
  email           TEXT,
  email_status    TEXT,
  email_source    TEXT, -- scraped | guessed | provider
  provider_used   TEXT,
  confidence      NUMERIC,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_people_row_idx
  ON research_people (row_id);

CREATE TABLE IF NOT EXISTS research_runs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id      UUID REFERENCES research_tables(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL, -- research | people | email | full | ai_column
  status        TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  summary       JSONB DEFAULT '{}'::jsonb,
  last_error    TEXT,
  created_by    TEXT
);

CREATE INDEX IF NOT EXISTS research_runs_table_idx
  ON research_runs (table_id, started_at DESC);

CREATE TABLE IF NOT EXISTS enrichment_cache (
  cache_key     TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrichment_cache_expires_idx
  ON enrichment_cache (expires_at);

-- ---------------------------------------------------------------------------
-- RLS — shared workspace: any authenticated user can CRUD.
-- ---------------------------------------------------------------------------
ALTER TABLE research_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_cache ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'research_tables',
    'research_rows',
    'research_evidence',
    'research_people',
    'research_runs',
    'enrichment_cache'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_select', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_insert') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (true)', t || '_insert', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_update') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (true)', t || '_update', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_delete') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (true)', t || '_delete', t);
    END IF;
  END LOOP;
END $$;
