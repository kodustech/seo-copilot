-- ---------------------------------------------------------------------------
-- Add the `engaged` stage between lead and qualified.
--
-- "They replied" was being recorded as a tag (outbound-reply) and a priority
-- bump, neither of which is visible in the accounts list. So an account that
-- answered an email sat in `lead` looking identical to one nobody has ever
-- contacted, and the only way to tell them apart was to open each one.
--
-- It is not qualification. gtm.md wants a substantive conversation AND a
-- nameable next step; a reply may well be "who are you?" or "take me off this
-- list". `engaged` says the conversation is live, nothing more.
--
-- Idle window sits between the two it separates: a live conversation left
-- hanging goes cold faster than an untouched lead (14d), but has not yet earned
-- the attention a real opportunity gets (10d).
-- ---------------------------------------------------------------------------

INSERT INTO crm_status_sla (status, idle_days, label)
VALUES ('engaged', 7, 'Engaged')
ON CONFLICT (status) DO UPDATE SET idle_days = EXCLUDED.idle_days, label = EXCLUDED.label;

-- Backfill: accounts the reply handler already created carry the outbound-reply
-- tag, which is exactly the population this stage exists to name. Only accounts
-- still sitting in `lead` move — anything a human has since advanced stays put.
UPDATE crm_companies
   SET status = 'engaged'
 WHERE status = 'lead'
   AND tags @> ARRAY['outbound-reply']::text[];
