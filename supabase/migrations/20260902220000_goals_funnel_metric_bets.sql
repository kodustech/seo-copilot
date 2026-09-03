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
-- on the Kanban. At most three bets are active at a time, the rest queue;
-- the cap is enforced by a constraint trigger below so two concurrent
-- activations cannot both slip past an application-side count.
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

CREATE OR REPLACE FUNCTION bets_enforce_active_cap() RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  -- Serialise concurrent activations: the lock is per statement, released at
  -- commit, so the count below sees every committed activation.
  PERFORM pg_advisory_xact_lock(hashtext('bets_active_cap'));
  SELECT COUNT(*) INTO active_count FROM bets WHERE status = 'active' AND id <> NEW.id;
  IF active_count >= 3 THEN
    RAISE EXCEPTION 'Já existem 3 apostas ativas. Decida uma (ganhou, perdeu ou virou operação) antes de ativar outra.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bets_active_cap ON bets;
CREATE CONSTRAINT TRIGGER bets_active_cap
  AFTER INSERT OR UPDATE OF status ON bets
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION bets_enforce_active_cap();

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
