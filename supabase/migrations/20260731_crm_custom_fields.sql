-- CRM custom properties (Notion-style): workspace field defs + values on companies.
-- Fixed columns (status, priority, …) stay first-class; properties are extra.

CREATE TABLE IF NOT EXISTS crm_field_defs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'select')),
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- select: [{ "id": "yes", "label": "Yes" }, ...]
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT crm_field_defs_key_uniq UNIQUE (key)
);

CREATE INDEX IF NOT EXISTS crm_field_defs_position_idx
  ON crm_field_defs (position, label);

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS properties JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON TABLE crm_field_defs IS
  'Workspace-level CRM property definitions (text/number/boolean/select).';
COMMENT ON COLUMN crm_companies.properties IS
  'Map field key -> primitive value (string|number|boolean). Select stores option id.';

DROP TRIGGER IF EXISTS crm_field_defs_touch ON crm_field_defs;
CREATE TRIGGER crm_field_defs_touch BEFORE UPDATE ON crm_field_defs
  FOR EACH ROW EXECUTE FUNCTION crm_touch_updated_at();

ALTER TABLE crm_field_defs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_field_defs_select') THEN
    CREATE POLICY crm_field_defs_select ON crm_field_defs
      FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_field_defs_insert') THEN
    CREATE POLICY crm_field_defs_insert ON crm_field_defs
      FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_field_defs_update') THEN
    CREATE POLICY crm_field_defs_update ON crm_field_defs
      FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_field_defs_delete') THEN
    CREATE POLICY crm_field_defs_delete ON crm_field_defs
      FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
