-- ---------------------------------------------------------------------------
-- Auto-enroll: a saved CRM filter pointed at a sequence.
--
-- Both halves already existed and nothing joined them. The accounts list takes
-- filters (status, tier, priority, deployment, source, owner, stale);
-- enrollFromCrm() takes a list of company ids. In between sat a human who had
-- to ask the AI agent, because that tool was the only caller — so in practice
-- nobody did, and zero enrollments have ever come from a CRM account while 12
-- t0 accounts sat untouched with a trial expiring.
--
-- This is deliberately not a rules engine. One row is one filter and one
-- destination; the cron re-runs the filter and enrolls whoever is new.
-- Suppression stays where it already lives, inside enrollFromCrm: paying and
-- closed accounts are skipped, and so is anyone already in a sequence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outreach_auto_enroll_rules (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sequence_id   UUID NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE,
  name          TEXT,
  -- CompanyFilters shape (lib/crm.ts). Stored as given so the rule keeps
  -- meaning the same thing the list view meant when it was saved.
  filters       JSONB NOT NULL DEFAULT '{}'::jsonb,
  active        BOOLEAN NOT NULL DEFAULT false,
  -- A wide filter against real inboxes has no undo. The cap bounds a mistake
  -- to one run instead of the whole base.
  max_per_run   INTEGER NOT NULL DEFAULT 10,
  /** Enroll every contact of the account, or the primary one only. */
  all_contacts  BOOLEAN NOT NULL DEFAULT false,
  last_run_at   TIMESTAMPTZ,
  last_result   JSONB,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outreach_auto_enroll_rules_sequence_idx
  ON outreach_auto_enroll_rules (sequence_id);
CREATE INDEX IF NOT EXISTS outreach_auto_enroll_rules_active_idx
  ON outreach_auto_enroll_rules (active) WHERE active = true;

ALTER TABLE outreach_auto_enroll_rules ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT := 'outreach_auto_enroll_rules';
BEGIN
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
END $$;
