-- ---------------------------------------------------------------------------
-- Personal notifications for the User Control Center.
-- Each row belongs to one user (by email). The generator (cron / on-demand)
-- upserts idempotently by dedupe_key so a standing condition (idle account,
-- overdue card) produces exactly one notification until acted on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_notifications (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email  TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- crm_idle | kanban_overdue | outreach_followup | goal_at_risk | job_failed | reply_pending | system
  severity    TEXT NOT NULL DEFAULT 'info',  -- info | warning | error
  title       TEXT NOT NULL,
  body        TEXT,
  source      TEXT,                 -- kanban | crm | outreach | goals | jobs | reply_radar
  source_id   TEXT,                 -- id of the originating record
  link        TEXT,                 -- in-app href to act on it
  dedupe_key  TEXT NOT NULL,        -- unique per user; prevents duplicate nudges
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_dedupe_uniq
  ON user_notifications (user_email, dedupe_key);
CREATE INDEX IF NOT EXISTS user_notifications_user_idx
  ON user_notifications (user_email, read_at, created_at DESC);

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

-- Personal scope: a user only sees/edits their own notifications. The email
-- claim is present in the Supabase auth JWT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'user_notifications_select') THEN
    CREATE POLICY user_notifications_select ON user_notifications
      FOR SELECT TO authenticated
      USING (user_email = (auth.jwt() ->> 'email'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'user_notifications_update') THEN
    CREATE POLICY user_notifications_update ON user_notifications
      FOR UPDATE TO authenticated
      USING (user_email = (auth.jwt() ->> 'email'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'user_notifications_delete') THEN
    CREATE POLICY user_notifications_delete ON user_notifications
      FOR DELETE TO authenticated
      USING (user_email = (auth.jwt() ->> 'email'));
  END IF;
  -- Inserts happen via the service-role generator (bypasses RLS). No INSERT
  -- policy for authenticated users on purpose.
END $$;
