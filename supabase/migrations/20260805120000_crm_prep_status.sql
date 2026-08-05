-- ---------------------------------------------------------------------------
-- `prep_status`: is this account ready to be worked?
--
-- `status` (lead / engaged / qualified / poc / ...) describes the *relationship*.
-- Nothing described the *preparation*, so there was no way to answer the only
-- question that matters when you sit down to do outbound: which of these 107
-- accounts have I already vetted?
--
-- The gap is not automatable, and one account shows exactly why. A signup
-- arrived on a starian.com address; the people actually working there are at
-- Checklist Fácil, and Starian is a Softplan company. The signer-up was not at
-- the company the domain claimed. That was discovered by opening their GitHub —
-- a judgement no lookup makes on its own. So the machine collects and a human
-- decides, and this column is where the decision is written down.
--
--   not_started  nothing has been done: not enriched, not contacted, not in a
--                sequence. What every account arrives as.
--   enriched     the lookup ran (found people, or established there are none)
--   ready        a human vetted it: right company, right people — may be enrolled
--   parked       a human vetted it and it is not worth working
--
-- `parked` is what lets the queue drain. Without it the same dead accounts get
-- re-examined every week, which is how a review queue quietly stops being used.
-- ---------------------------------------------------------------------------

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS prep_status TEXT NOT NULL DEFAULT 'not_started';

DO $$
BEGIN
  ALTER TABLE crm_companies
    ADD CONSTRAINT crm_companies_prep_status_check
    CHECK (prep_status IN ('not_started', 'enriched', 'ready', 'parked'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Partial index: the review queue is a filter on the two unfinished states, and
-- 'ready' is read on every auto-enroll run. Nothing ever queries for 'parked'.
CREATE INDEX IF NOT EXISTS crm_companies_prep_status_idx
  ON crm_companies (prep_status)
  WHERE prep_status IN ('not_started', 'enriched', 'ready');

-- Backfill: an account holding a contact with a LinkedIn URL has been through
-- the lookup already — that is the one field the signup flow never provides and
-- only enrichment writes. Deliberately does not promote anything to 'ready':
-- that word means a person looked, and nobody has yet.
UPDATE crm_companies c
   SET prep_status = 'enriched'
 WHERE c.prep_status = 'not_started'
   AND EXISTS (
     SELECT 1 FROM crm_contacts ct
      WHERE ct.company_id = c.id
        AND ct.linkedin IS NOT NULL
        AND ct.linkedin <> ''
   );
