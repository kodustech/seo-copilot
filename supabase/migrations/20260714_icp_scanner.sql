-- ---------------------------------------------------------------------------
-- ICP signal scanner: watchlist of companies (and which public ATS board they
-- use) + history of buying-intent signals detected from public sources
-- (job boards today; GitHub, statuspages, eng blogs later).
-- Shared workspace posture, same as the CRM tables. Cron/agent writes go
-- through the service-role client and bypass RLS.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS icp_watchlist (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name     TEXT NOT NULL,
  domain           TEXT,                        -- normalized, e.g. acme.com
  ats              TEXT NOT NULL,               -- greenhouse | lever | ashby
  board_slug       TEXT NOT NULL,               -- slug on the ATS public API
  active           BOOLEAN DEFAULT true,
  added_by_email   TEXT,
  last_scanned_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS icp_watchlist_board_uniq
  ON icp_watchlist (ats, lower(board_slug));
CREATE UNIQUE INDEX IF NOT EXISTS icp_watchlist_domain_uniq
  ON icp_watchlist (lower(domain)) WHERE domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS icp_signals (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  watchlist_id   UUID NOT NULL REFERENCES icp_watchlist(id) ON DELETE CASCADE,
  company_id     UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  signal_type    TEXT NOT NULL,   -- qa_automation_hiring | test_suite_rescue | e2e_tooling | ai_feature | dev_hiring_no_qa
  strength       TEXT NOT NULL,   -- strong | medium
  title          TEXT NOT NULL,   -- e.g. the job posting title
  url            TEXT NOT NULL,   -- source URL (job posting / board)
  evidence       TEXT,            -- classifier justification, quotable
  raw            JSONB DEFAULT '{}'::jsonb,
  detected_at    TIMESTAMPTZ DEFAULT now()
);

-- One row per (source URL, signal type): the same posting can carry more than
-- one signal, but re-scans must not duplicate it.
CREATE UNIQUE INDEX IF NOT EXISTS icp_signals_url_type_uniq
  ON icp_signals (url, signal_type);
CREATE INDEX IF NOT EXISTS icp_signals_watchlist_idx
  ON icp_signals (watchlist_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS icp_signals_detected_idx ON icp_signals (detected_at DESC);

-- ---------------------------------------------------------------------------
-- RLS — shared workspace: any authenticated user can CRUD.
-- ---------------------------------------------------------------------------
ALTER TABLE icp_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_signals   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['icp_watchlist','icp_signals']
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
