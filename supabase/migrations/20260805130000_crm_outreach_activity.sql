-- ---------------------------------------------------------------------------
-- Record outbound sends on the account they went to.
--
-- crm_activities carries created / comment / signal / status_change / note /
-- owner_change / property_change. No kind meant "we messaged them", so the CRM
-- could not answer "have I already written to this account" — the fact lived in
-- outreach_send_tasks, one join and one UI away, and in practice unknowable at a
-- glance.
--
-- No backfill, because there is nothing to backfill: of 459 sent tasks, zero
-- belong to an enrollment carrying a crm_company_id. Every send so far came
-- from the research-table sequences, which never touch the CRM. This starts the
-- history rather than reconstructing it.
--
-- The column is added here rather than tracked in code alone so that the
-- accounts list can sort and filter on it without walking the activity table:
-- last_activity_at already moves on every signal sweep (342 of the 500 most
-- recent activities are signals), so it cannot stand in for "last time a human
-- reached out".
-- ---------------------------------------------------------------------------

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS last_outreach_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outreach_sent_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS crm_companies_last_outreach_at_idx
  ON crm_companies (last_outreach_at DESC NULLS LAST);
