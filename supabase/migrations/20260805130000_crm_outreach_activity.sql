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

-- Atomic increment.
--
-- Read-then-write from the application loses a send whenever two go out to the
-- same account close together: both read the same base value and both write
-- base + 1. That is not a rare shape here — one account can hold several
-- contacts on the same sequence, and the auto-send cron and a human completing
-- a task from the queue can land in the same second.
--
-- GREATEST on the timestamp so an out-of-order write (a retry finishing after a
-- later send) cannot drag last_outreach_at backwards.
CREATE OR REPLACE FUNCTION bump_outreach_counters(
  p_company_id UUID,
  p_sent_at TIMESTAMPTZ
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE crm_companies
     SET outreach_sent_count = COALESCE(outreach_sent_count, 0) + 1,
         last_outreach_at = GREATEST(COALESCE(last_outreach_at, p_sent_at), p_sent_at)
   WHERE id = p_company_id;
$$;
