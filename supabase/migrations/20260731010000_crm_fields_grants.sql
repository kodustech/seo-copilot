-- Ensure authenticated (and service_role) can use crm custom fields.
-- RLS alone is not enough if table was created without GRANTs / policies.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_field_defs TO authenticated;
GRANT ALL ON TABLE public.crm_field_defs TO service_role;

ALTER TABLE public.crm_field_defs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_field_defs_select ON public.crm_field_defs;
DROP POLICY IF EXISTS crm_field_defs_insert ON public.crm_field_defs;
DROP POLICY IF EXISTS crm_field_defs_update ON public.crm_field_defs;
DROP POLICY IF EXISTS crm_field_defs_delete ON public.crm_field_defs;

CREATE POLICY crm_field_defs_select ON public.crm_field_defs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY crm_field_defs_insert ON public.crm_field_defs
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY crm_field_defs_update ON public.crm_field_defs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY crm_field_defs_delete ON public.crm_field_defs
  FOR DELETE TO authenticated USING (true);

-- properties column is on crm_companies (already shared-workspace); no extra grants needed.
