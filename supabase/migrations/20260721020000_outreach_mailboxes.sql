-- Outreach sending mailboxes (product config, not .env).
-- Password stored encrypted at rest; never returned to the client after save.

CREATE TABLE IF NOT EXISTS public.outreach_mailboxes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 TEXT NOT NULL DEFAULT 'Outreach',
  from_name             TEXT,
  from_email            TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'smtp'
                          CHECK (provider IN ('smtp', 'gmail')),
  smtp_host             TEXT NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port             INT NOT NULL DEFAULT 587,
  smtp_secure           BOOLEAN NOT NULL DEFAULT false,
  smtp_user             TEXT NOT NULL,
  smtp_pass_encrypted   TEXT NOT NULL,
  daily_cap             INT NOT NULL DEFAULT 40 CHECK (daily_cap > 0 AND daily_cap <= 500),
  is_default            BOOLEAN NOT NULL DEFAULT true,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  sent_today            INT NOT NULL DEFAULT 0,
  sent_today_date       DATE,
  last_tested_at        TIMESTAMPTZ,
  last_test_ok          BOOLEAN,
  last_test_error       TEXT,
  last_sent_at          TIMESTAMPTZ,
  created_by_email      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one default mailbox
CREATE UNIQUE INDEX IF NOT EXISTS outreach_mailboxes_one_default
  ON public.outreach_mailboxes (is_default)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS outreach_mailboxes_enabled_idx
  ON public.outreach_mailboxes (enabled, is_default);

ALTER TABLE public.outreach_mailboxes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'outreach_mailboxes_select'
  ) THEN
    CREATE POLICY outreach_mailboxes_select ON public.outreach_mailboxes
      FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'outreach_mailboxes_insert'
  ) THEN
    CREATE POLICY outreach_mailboxes_insert ON public.outreach_mailboxes
      FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'outreach_mailboxes_update'
  ) THEN
    CREATE POLICY outreach_mailboxes_update ON public.outreach_mailboxes
      FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'outreach_mailboxes_delete'
  ) THEN
    CREATE POLICY outreach_mailboxes_delete ON public.outreach_mailboxes
      FOR DELETE TO authenticated USING (true);
  END IF;
END $$;

COMMENT ON TABLE public.outreach_mailboxes IS
  'SMTP mailboxes for sequence email auto-send. Configure in Settings → Outreach email.';
COMMENT ON COLUMN public.outreach_mailboxes.smtp_pass_encrypted IS
  'AES-GCM ciphertext; never expose via API responses.';
