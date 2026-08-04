-- ---------------------------------------------------------------------------
-- ICP gate for the product-signals sweep.
--
-- Two things the sweep could not do before:
--   1. know how big an org's engineering team actually is, and
--   2. decide whether an org that never connected git is worth a CRM account.
--
-- (1) now has a real source: kodus_postgres.organizations.code_host_member_count,
-- persisted by kodus-ai at finish-onboarding. It only covers orgs onboarded
-- after 2026-07-28, so the sweep falls back to distinct PR authors. Both are
-- stored side by side so the fallback stays auditable — and so we can watch
-- code_host_member_count coverage grow without re-querying BigQuery.
--
-- NEITHER is ever seats. total_licenses/assigned_licenses/user_count are Kodus
-- seats and must never reach dev_count (see kodustech/seo-copilot 52da752).
--
-- (2) has no product-side signal at all for t2 (never connected git → no member
-- count, no PRs), so it needs external firmographics. company_enrichment caches
-- those per domain because NinjaPear bills 3 credits per lookup and several
-- orgs can share one domain.
-- ---------------------------------------------------------------------------

ALTER TABLE product_signals_latest
  ADD COLUMN IF NOT EXISTS code_host_member_count INTEGER,
  ADD COLUMN IF NOT EXISTS code_host_member_count_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pr_author_count INTEGER,
  -- Resolved team size: code_host_member_count when present, else pr_author_count.
  ADD COLUMN IF NOT EXISTS dev_count INTEGER,
  ADD COLUMN IF NOT EXISTS dev_count_source TEXT;  -- code_host | pr_authors | none

CREATE INDEX IF NOT EXISTS product_signals_latest_dev_count_idx
  ON product_signals_latest (dev_count) WHERE dev_count IS NOT NULL;

-- Firmographic cache, keyed by domain. Rows are written by the sweep; a row
-- with error set is a negative cache entry so a failing domain does not burn
-- credits on every run.
CREATE TABLE IF NOT EXISTS company_enrichment (
  domain         TEXT PRIMARY KEY,
  employee_count INTEGER,
  industry       TEXT,
  company_type   TEXT,
  country        TEXT,
  founded_year   INTEGER,
  name           TEXT,
  provider       TEXT NOT NULL DEFAULT 'ninjapear',
  error          TEXT,
  raw            JSONB,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_enrichment_fetched_idx
  ON company_enrichment (fetched_at DESC);

ALTER TABLE company_enrichment ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'company_enrichment_select') THEN
    EXECUTE 'CREATE POLICY company_enrichment_select ON company_enrichment FOR SELECT TO authenticated USING (true)';
  END IF;
END $$;
