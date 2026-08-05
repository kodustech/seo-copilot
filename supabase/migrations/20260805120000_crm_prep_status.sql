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

-- Every statement below is written to be correct whether this file has run
-- before or not, and specifically whether it ran in its first form, where the
-- initial state was called 'raw'.
--
-- Supabase records migrations by version, so a file edited after some
-- environment applied it never runs again there. An earlier revision of this
-- one shipped 'raw' as the default and inside the CHECK constraint; had it been
-- applied anywhere, an in-place rename would have left that environment
-- rejecting every write of 'not_started' at the constraint while the code
-- queried for a value the column could never hold. No environment did apply it
-- — production shows all three of this batch pending — but the fix is cheaper
-- than the verification, so the file simply does not depend on the answer.
ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS prep_status TEXT NOT NULL DEFAULT 'not_started';

ALTER TABLE crm_companies
  ALTER COLUMN prep_status SET DEFAULT 'not_started';

UPDATE crm_companies SET prep_status = 'not_started' WHERE prep_status = 'raw';

-- Dropped and recreated rather than added-if-absent: an existing constraint
-- here is the *old* one, listing 'raw', and keeping it is the failure.
ALTER TABLE crm_companies
  DROP CONSTRAINT IF EXISTS crm_companies_prep_status_check;
ALTER TABLE crm_companies
  ADD CONSTRAINT crm_companies_prep_status_check
  CHECK (prep_status IN ('not_started', 'enriched', 'ready', 'parked'));

-- Partial index: the review queue is a filter on the two unfinished states, and
-- 'ready' is read on every auto-enroll run. Nothing ever queries for 'parked'.
-- Same reasoning as the constraint — an index left over from the first revision
-- has 'raw' in its WHERE clause and would never match a row again.
DROP INDEX IF EXISTS crm_companies_prep_status_idx;
CREATE INDEX crm_companies_prep_status_idx
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
