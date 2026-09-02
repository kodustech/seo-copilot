-- ---------------------------------------------------------------------------
-- Goals bound to a funnel metric, and bets.
--
-- A goal with `funnel_metric` targets a number the funnel already measures
-- (icp, conversations, closed_brl...). The weekly funnel sync writes the
-- measured value into current_count, so a goal can never drift from the
-- number it claims to track, and nobody types progress by hand.
--
-- A bet is what we run to move a goal: hypothesis, action, the metric that
-- proves it, and the date the verdict is due. It is not a task; tasks live
-- on the Kanban. At most three bets are active at a time (enforced in the
-- application), the rest queue.
-- ---------------------------------------------------------------------------

ALTER TABLE goals ADD COLUMN IF NOT EXISTS funnel_metric TEXT;
CREATE INDEX IF NOT EXISTS goals_funnel_metric_idx ON goals (funnel_metric) WHERE funnel_metric IS NOT NULL;

CREATE TABLE IF NOT EXISTS bets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id          UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  hypothesis       TEXT NOT NULL,
  action           TEXT NOT NULL,
  metric           TEXT NOT NULL,
  decision_at      DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('queued', 'active', 'won', 'lost', 'operation')),
  verdict          TEXT,
  notes            TEXT,
  kanban_item_id   UUID,
  created_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bets_goal_idx ON bets (goal_id, status);
CREATE INDEX IF NOT EXISTS bets_decision_idx ON bets (status, decision_at);

ALTER TABLE bets ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bets_select') THEN
    CREATE POLICY bets_select ON bets FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bets_insert') THEN
    CREATE POLICY bets_insert ON bets FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bets_update') THEN
    CREATE POLICY bets_update ON bets FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bets_delete') THEN
    CREATE POLICY bets_delete ON bets FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
