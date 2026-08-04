-- ---------------------------------------------------------------------------
-- Product signals: machine-owned snapshot of product usage per kodus-ai org,
-- computed by the product-signals cron from BigQuery. Humans never write here.
--
-- Two tables:
--   product_signals_latest  — one row per org, upserted every sweep (freshness
--                             comes from computed_at).
--   product_signals_history — append-only; a row is written only when the
--                             classification (tier/trigger/health/plan)
--                             changes, so it reads as a transition log.
--
-- The CRM joins on crm_companies.org_id. crm_companies.tier is a denormalized
-- copy of the latest tier kept by the same sweep so list filtering stays cheap;
-- by convention it is machine-owned.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_signals_latest (
  org_id             TEXT PRIMARY KEY,           -- kodus_postgres.organizations.uuid
  org_name           TEXT,
  org_type           TEXT,                        -- organization | user (personal git account)
  signup_at          TIMESTAMPTZ,
  connected_git      BOOLEAN NOT NULL DEFAULT false,
  plan_type          TEXT,                        -- free_byok | teams_* | enterprise_*
  subscription_status TEXT,                       -- active | trial | expired | canceled
  trial_end          TIMESTAMPTZ,
  total_licenses     INTEGER,
  assigned_licenses  INTEGER,
  user_count         INTEGER,
  reviews_7d         INTEGER,                     -- successful automation executions
  reviews_30d        INTEGER,
  last_review_at     TIMESTAMPTZ,
  skips_30d          INTEGER,
  top_skip_reason    TEXT,                        -- most frequent errorMessage, last 30d
  tier               TEXT,                        -- t0 | t1 | t2 | t3 | customer | NULL
  trigger            TEXT,                        -- cloud_trial | free_limit | broken_activation | ...
  health             TEXT,                        -- active | cooling | at_risk | dormant | unknown
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_signals_latest_tier_idx
  ON product_signals_latest (tier) WHERE tier IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_signals_history (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id             TEXT NOT NULL,
  tier               TEXT,
  trigger            TEXT,
  health             TEXT,
  plan_type          TEXT,
  subscription_status TEXT,
  prev_tier          TEXT,
  prev_trigger       TEXT,
  reviews_30d        INTEGER,
  skips_30d          INTEGER,
  top_skip_reason    TEXT,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_signals_history_org_idx
  ON product_signals_history (org_id, computed_at DESC);

-- Denormalized tier on the account for cheap list filtering (machine-owned).
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS tier TEXT;
CREATE INDEX IF NOT EXISTS crm_companies_tier_idx
  ON crm_companies (tier) WHERE tier IS NOT NULL;

-- Enrollments can now come straight from a CRM account.
ALTER TABLE outreach_enrollments
  ADD COLUMN IF NOT EXISTS crm_company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS outreach_enrollments_crm_company_idx
  ON outreach_enrollments (crm_company_id) WHERE crm_company_id IS NOT NULL;

-- Extra {{token}} values frozen at enrollment time (e.g. skip_reason, tier,
-- dev_count for CRM-sourced enrollments). Merged into template rendering.
ALTER TABLE outreach_enrollments
  ADD COLUMN IF NOT EXISTS template_vars JSONB DEFAULT '{}'::jsonb;

ALTER TABLE outreach_enrollments DROP CONSTRAINT IF EXISTS outreach_enrollments_source_check;
ALTER TABLE outreach_enrollments
  ADD CONSTRAINT outreach_enrollments_source_check
  CHECK (source IN ('research', 'outreach', 'manual', 'crm'));

-- RLS: authenticated users read; writes go through the service-role client
-- (the cron), which bypasses RLS. No insert/update policies on purpose.
ALTER TABLE product_signals_latest  ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_signals_history ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_signals_latest','product_signals_history']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_select', t);
    END IF;
  END LOOP;
END $$;
