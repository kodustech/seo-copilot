-- ---------------------------------------------------------------------------
-- CRM: companies, contacts, markdown comments, activity timeline, status SLA.
-- Shared workspace (all authenticated @kodus.io users can read/write), same
-- posture as the kanban board. Webhook writes go through the service-role
-- client and bypass RLS.
-- ---------------------------------------------------------------------------

-- Companies (accounts). `org_id` optionally links to a product organization
-- (kodus_postgres.organizations.uuid) so we can pull real usage signals.
CREATE TABLE IF NOT EXISTS crm_companies (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name           TEXT NOT NULL,
  domain         TEXT,
  org_id         TEXT,                       -- product org uuid, when known
  status         TEXT NOT NULL DEFAULT 'lead',
  priority       TEXT NOT NULL DEFAULT 'medium',
  owner_email    TEXT,                       -- responsible teammate
  industry       TEXT,
  size           TEXT,
  country        TEXT,
  website        TEXT,
  linkedin       TEXT,
  arr            NUMERIC,                     -- estimated deal value / MRR·12
  tags           TEXT[] DEFAULT '{}',
  enrichment     JSONB DEFAULT '{}'::jsonb,   -- free-form payload from webhook
  source         TEXT DEFAULT 'manual',       -- manual | webhook | agent
  notes          TEXT,
  last_activity_at TIMESTAMPTZ DEFAULT now(), -- drives the "idle" alert
  created_by_email TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Dedup keys for idempotent webhook upserts. Partial unique indexes so NULLs
-- don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS crm_companies_org_id_uniq
  ON crm_companies (org_id) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_companies_domain_uniq
  ON crm_companies (lower(domain)) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_companies_status_idx ON crm_companies (status);
CREATE INDEX IF NOT EXISTS crm_companies_last_activity_idx ON crm_companies (last_activity_at);

-- People inside a company.
CREATE TABLE IF NOT EXISTS crm_contacts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT,
  role         TEXT,
  phone        TEXT,
  linkedin     TEXT,
  is_primary   BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_contacts_company_idx ON crm_contacts (company_id);

-- Markdown comments (1:N).
CREATE TABLE IF NOT EXISTS crm_comments (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  author_email TEXT,
  body_md      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_comments_company_idx ON crm_comments (company_id);

-- Auto-generated activity timeline (status/owner changes, webhook hits, etc.).
CREATE TABLE IF NOT EXISTS crm_activities (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,   -- created | status_change | owner_change | comment | webhook | note
  summary      TEXT,
  meta         JSONB DEFAULT '{}'::jsonb,
  actor_email  TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_activities_company_idx ON crm_activities (company_id, created_at DESC);

-- Idle SLA per status: how many days of no activity before we alert.
CREATE TABLE IF NOT EXISTS crm_status_sla (
  status     TEXT PRIMARY KEY,
  idle_days  INTEGER NOT NULL DEFAULT 14,
  label      TEXT
);

INSERT INTO crm_status_sla (status, idle_days, label) VALUES
  ('lead',        14, 'Lead'),
  ('qualified',   10, 'Qualified'),
  ('trial',        5, 'Trial'),
  ('negotiation',  3, 'Negotiation'),
  ('customer',    30, 'Customer'),
  ('churned',    999, 'Churned'),
  ('lost',       999, 'Lost')
ON CONFLICT (status) DO NOTHING;

-- keep updated_at fresh
CREATE OR REPLACE FUNCTION crm_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_companies_touch ON crm_companies;
CREATE TRIGGER crm_companies_touch BEFORE UPDATE ON crm_companies
  FOR EACH ROW EXECUTE FUNCTION crm_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — shared workspace: any authenticated user can CRUD.
-- ---------------------------------------------------------------------------
ALTER TABLE crm_companies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_comments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_status_sla ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_companies','crm_contacts','crm_comments','crm_activities','crm_status_sla']
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
