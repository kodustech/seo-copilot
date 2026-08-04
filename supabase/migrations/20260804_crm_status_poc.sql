-- ---------------------------------------------------------------------------
-- Rename the CRM status `trial` to `poc`.
--
-- Two different things were called trial. The product has a self-serve trial
-- that starts at signup, before anyone has spoken to the account — that is the
-- t0 tier, and it is machine-owned. The pipeline stage means something else
-- entirely: an assisted evaluation run *with* us, with agreed scope and
-- criteria, often a head-to-head against a competitor.
--
-- Sharing a name made the stage read as a duplicate of the tier, so it went
-- unused (one account) while real evaluations sat in `lead`. `poc` says what it
-- is and cannot be confused with the other one.
--
-- crm_companies.status is plain TEXT with no CHECK constraint, so this is a
-- data migration plus the SLA row; the allowed values live in the TypeScript
-- enum (lib/crm.ts).
-- ---------------------------------------------------------------------------

UPDATE crm_companies SET status = 'poc' WHERE status = 'trial';

-- Idle SLA: an assisted evaluation left untouched goes cold faster than a
-- qualified conversation, so it keeps the tighter window the stage already had.
INSERT INTO crm_status_sla (status, idle_days, label)
VALUES ('poc', 5, 'POC')
ON CONFLICT (status) DO UPDATE SET idle_days = EXCLUDED.idle_days, label = EXCLUDED.label;

DELETE FROM crm_status_sla WHERE status = 'trial';

-- The timeline records status transitions as free text; rewrite the old value
-- so history stays readable next to the new name.
UPDATE crm_activities
   SET summary = REPLACE(summary, 'trial', 'poc')
 WHERE kind = 'status_change' AND summary LIKE '%trial%';
