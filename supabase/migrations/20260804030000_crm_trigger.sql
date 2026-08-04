-- ---------------------------------------------------------------------------
-- Denormalise `trigger` onto crm_companies, the way `tier` already is.
--
-- The outbound playbook splits the two deliberately: tier decides *when* to
-- touch an account, trigger decides *what to say*. Only tier was denormalised,
-- so anything filtering crm_companies — the accounts list, and now auto-enroll
-- rules — could express the timing and not the message.
--
-- The cost of that shows up in the data: t0 currently holds an account with 492
-- reviews in 30 days deciding whether to pay (cloud_trial) next to one hitting
-- the free-plan ceiling (free_limit), and t1 holds accounts running 80 reviews a
-- month (healthy_usage) next to ten that have gone silent (went_quiet). One
-- sequence per tier necessarily sends the wrong message to half of each group.
--
-- Machine-owned, exactly like tier: the sweep writes it, humans do not.
-- ---------------------------------------------------------------------------

ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS trigger TEXT;

CREATE INDEX IF NOT EXISTS crm_companies_trigger_idx
  ON crm_companies (trigger) WHERE trigger IS NOT NULL;

-- Backfill from the signals table so filters work before the next sweep runs.
UPDATE crm_companies c
   SET trigger = s.trigger
  FROM product_signals_latest s
 WHERE s.org_id = c.org_id
   AND c.trigger IS DISTINCT FROM s.trigger;
