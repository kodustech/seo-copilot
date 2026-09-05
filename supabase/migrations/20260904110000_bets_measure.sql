-- ---------------------------------------------------------------------------
-- Bets carry a machine-readable measure, so an agent (or the page) can say
-- whether the hypothesis held without a human re-reading the funnel.
--
--   lever           the lever the bet belongs to (free text, groups the page)
--   owner_email     who runs it
--   measure         { kind, id, comparator, threshold, window: { start, end } }
--                   kind: funnel_stage | funnel_rate | ai_share | outbound_tag | manual
--   current_value   for kind = manual, the number typed by hand
--   action_done_at  when the action was executed (level 1 of the follow-up)
-- ---------------------------------------------------------------------------

ALTER TABLE bets ADD COLUMN IF NOT EXISTS lever TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS measure JSONB;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS current_value NUMERIC;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS action_done_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS bets_lever_idx ON bets (lever);
