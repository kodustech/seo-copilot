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

-- The timeline stores each transition twice: as free text in `summary` and as
-- structured values in `meta` ({from, to} — see logActivity in lib/crm.ts).
-- Rewriting only the prose would leave rows disagreeing with themselves
-- ("Status: lead → poc" carrying meta {"to":"trial"}), and `meta` is what the
-- API and the AI tools read, so the retired value would keep circulating in
-- structured data long after it stopped existing anywhere else.
--
-- Scoped to the two keys rather than a blanket text replace: a status_change
-- row can legitimately mention the product's own trial elsewhere in meta, and
-- that one is not being renamed.
-- Gated on the structured values, never on the prose. `meta` is what actually
-- states the transition; `summary` is a rendering of it. Selecting rows by
-- `summary LIKE '%trial%'` would sweep in any row whose text happens to mention
-- a trial for some other reason and rewrite it while its meta stayed put —
-- reintroducing the very divergence this statement exists to remove.
--
-- \m and \M anchor to word boundaries so only the standalone status token is
-- touched: a plain REPLACE would turn "industrial" into "industpoc".
UPDATE crm_activities
   SET summary = regexp_replace(summary, '\mtrial\M', 'poc', 'g'),
       meta = CASE
                WHEN meta->>'from' = 'trial' AND meta->>'to' = 'trial'
                  THEN jsonb_set(jsonb_set(meta, '{from}', '"poc"'), '{to}', '"poc"')
                WHEN meta->>'from' = 'trial'
                  THEN jsonb_set(meta, '{from}', '"poc"')
                WHEN meta->>'to' = 'trial'
                  THEN jsonb_set(meta, '{to}', '"poc"')
                ELSE meta
              END
 WHERE kind = 'status_change'
   AND (meta->>'from' = 'trial' OR meta->>'to' = 'trial');
