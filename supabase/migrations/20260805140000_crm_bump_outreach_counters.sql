-- ---------------------------------------------------------------------------
-- Atomic increment for the outreach counters.
--
-- Read-then-write from the application loses a send whenever two go out to the
-- same account close together: both read the same base value and both write
-- base + 1. Not a rare shape here — one account can hold several contacts on
-- the same sequence, and the auto-send cron and a human completing a task from
-- the queue can land in the same second.
--
-- Its own migration rather than appended to 20260805130000, which introduced
-- the columns. That file already existed in an earlier commit of this branch,
-- and Supabase records migrations by version: any environment that applied it
-- before the function was written would never run the appended statement, and
-- the RPC would then fail with function-not-found. recordOutreachOnCrm swallows
-- that error by design (a bookkeeping failure must not fail a delivered email),
-- so the symptom would be counters that silently never move — the hardest kind
-- of broken to notice, since sending keeps working.
--
-- GREATEST on the timestamp so an out-of-order write (a retry finishing after a
-- later send) cannot drag last_outreach_at backwards.
-- ---------------------------------------------------------------------------

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
