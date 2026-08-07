-- ---------------------------------------------------------------------------
-- Exclusion list per research list.
--
-- Deduplication in addRows only compared against rows currently in the list,
-- so deleting a company had no lasting effect: the next researchFindIcp run on
-- the same list re-imported it with a fresh id. Cleaning a list and continuing
-- to source into it were mutually exclusive.
--
-- Deleting rows now records them here, and the import path consults it. A
-- deliberate re-add (manual/agent "add these domains") clears the entry, so an
-- exclusion is never a one-way door.
--
-- Deliberately no FK to research_tables: restoreResearchTableSnapshot deletes
-- and re-inserts the research_tables row, which a cascade would silently wipe.
-- deleteTable clears exclusions explicitly instead. Same posture as
-- research_table_snapshots.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS research_excluded_companies (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id      UUID NOT NULL,
  -- Normalized domain (host, no www) when the deleted row had one.
  domain        TEXT,
  -- Normalized company name: lowercase, accent- and punctuation-stripped.
  -- Set on every entry, so a domainless discovery row is still excludable.
  company_key   TEXT NOT NULL,
  -- Name as it was displayed, for the UI and for auditing.
  company_name  TEXT NOT NULL,
  reason        TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS research_excluded_table_domain_uniq
  ON research_excluded_companies (table_id, lower(domain))
  WHERE domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS research_excluded_table_company_uniq
  ON research_excluded_companies (table_id, company_key);

ALTER TABLE research_excluded_companies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'research_excluded_companies_select') THEN
    CREATE POLICY research_excluded_companies_select ON research_excluded_companies
      FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'research_excluded_companies_insert') THEN
    CREATE POLICY research_excluded_companies_insert ON research_excluded_companies
      FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'research_excluded_companies_update') THEN
    CREATE POLICY research_excluded_companies_update ON research_excluded_companies
      FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'research_excluded_companies_delete') THEN
    CREATE POLICY research_excluded_companies_delete ON research_excluded_companies
      FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
