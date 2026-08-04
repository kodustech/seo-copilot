-- Workspace-wide outreach schedule: which weekdays the tool is allowed to run.
-- Applies to BOTH sides of the sequence engine:
--   1. when the next step's activity/task is generated (scheduled_for)
--   2. when the cron is allowed to actually send / release to the human queue
--
-- Single-row table (id is pinned to 'default') so it behaves like workspace config.

CREATE TABLE IF NOT EXISTS public.outreach_settings (
  id TEXT PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  -- 0 = Sunday … 6 = Saturday (matches JS Date#getDay)
  sending_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- Weekday is resolved in this timezone, not UTC: Saturday 22:00 in São Paulo
  -- is already Sunday in UTC, and we must not treat it as a sending day.
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  updated_by_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outreach_settings_sending_days_not_empty
    CHECK (array_length(sending_days, 1) >= 1),
  CONSTRAINT outreach_settings_sending_days_range
    CHECK (sending_days <@ '{0,1,2,3,4,5,6}'::SMALLINT[])
);

COMMENT ON COLUMN public.outreach_settings.sending_days IS
  'Weekdays outreach may schedule and send on. 0=Sunday .. 6=Saturday. Default Mon-Fri.';
COMMENT ON COLUMN public.outreach_settings.timezone IS
  'IANA timezone used to resolve which weekday a timestamp falls on.';

INSERT INTO public.outreach_settings (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;
