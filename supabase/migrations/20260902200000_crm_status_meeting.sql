-- ---------------------------------------------------------------------------
-- Add the `meeting` stage between engaged and qualified, and the column the
-- calendar sync writes.
--
-- `engaged` is set automatically when someone replies, so it means "they
-- answered", not "we are talking". Everything after that (a call booked, a
-- call held, "ping me Thursday") was invisible: same status, same list. The
-- funnel could not measure reply → meeting because the state did not exist.
--
-- `meeting` is not a mandatory stop. Inbound accounts go engaged → qualified
-- on a written conversation; self-serve ones go lead → customer with nobody
-- talking to us. It is the state for "a meeting is on the calendar or just
-- happened, and the four qualification fields are still missing".
--
-- Idle window: a booked meeting that produced neither a qualification nor a
-- new date within two weeks is a conversation going cold.
-- ---------------------------------------------------------------------------

INSERT INTO crm_status_sla (status, idle_days, label)
VALUES ('meeting', 14, 'Meeting')
ON CONFLICT (status) DO UPDATE SET idle_days = EXCLUDED.idle_days, label = EXCLUDED.label;

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS meeting_at TIMESTAMPTZ;

-- One row per calendar event matched to an account, so the sync is idempotent
-- and the drawer can show which meetings moved the status.
CREATE TABLE IF NOT EXISTS crm_meetings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'google',
  event_id      TEXT NOT NULL,
  calendar_email TEXT,
  title         TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ,
  attendees     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id, company_id)
);
CREATE INDEX IF NOT EXISTS crm_meetings_company_idx ON crm_meetings (company_id, starts_at DESC);
ALTER TABLE crm_meetings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_meetings_select') THEN
    CREATE POLICY crm_meetings_select ON crm_meetings FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_meetings_insert') THEN
    CREATE POLICY crm_meetings_insert ON crm_meetings FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_meetings_update') THEN
    CREATE POLICY crm_meetings_update ON crm_meetings FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_meetings_delete') THEN
    CREATE POLICY crm_meetings_delete ON crm_meetings FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
