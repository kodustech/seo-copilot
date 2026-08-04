-- Outreach sequences: multi-step email (auto) + LinkedIn (semi) cadences.

CREATE TABLE IF NOT EXISTS public.outreach_sequences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  default_from_email  TEXT,
  created_by_email    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.outreach_sequence_steps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id         UUID NOT NULL REFERENCES public.outreach_sequences(id) ON DELETE CASCADE,
  position            INT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  mode                TEXT NOT NULL CHECK (mode IN ('auto', 'semi')),
  delay_hours         INT NOT NULL DEFAULT 0 CHECK (delay_hours >= 0),
  linkedin_action     TEXT CHECK (linkedin_action IS NULL OR linkedin_action IN ('connect_note', 'message')),
  subject_template    TEXT,
  body_template       TEXT NOT NULL DEFAULT '',
  stop_on_reply       BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, position)
);

CREATE TABLE IF NOT EXISTS public.outreach_enrollments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id           UUID NOT NULL REFERENCES public.outreach_sequences(id) ON DELETE CASCADE,
  source                TEXT NOT NULL CHECK (source IN ('research', 'outreach', 'manual')),
  outreach_prospect_id  UUID REFERENCES public.outreach_prospects(id) ON DELETE SET NULL,
  research_row_id       UUID,
  research_person_id    UUID,
  company_name          TEXT NOT NULL,
  domain                TEXT,
  contact_name          TEXT,
  contact_email         TEXT,
  contact_linkedin      TEXT,
  contact_role          TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN (
                            'active', 'paused', 'completed', 'replied',
                            'bounced', 'failed', 'cancelled'
                          )),
  current_step_position INT NOT NULL DEFAULT 0,
  next_run_at           TIMESTAMPTZ,
  last_error            TEXT,
  enrolled_by_email     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outreach_enrollments_sequence_idx
  ON public.outreach_enrollments (sequence_id, status);
CREATE INDEX IF NOT EXISTS outreach_enrollments_next_run_idx
  ON public.outreach_enrollments (next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

-- Avoid obvious double-enroll by email within a sequence
CREATE UNIQUE INDEX IF NOT EXISTS outreach_enrollments_seq_email_uniq
  ON public.outreach_enrollments (sequence_id, lower(contact_email))
  WHERE contact_email IS NOT NULL AND status IN ('active', 'paused');

CREATE UNIQUE INDEX IF NOT EXISTS outreach_enrollments_seq_linkedin_uniq
  ON public.outreach_enrollments (sequence_id, contact_linkedin)
  WHERE contact_linkedin IS NOT NULL AND status IN ('active', 'paused');

CREATE TABLE IF NOT EXISTS public.outreach_send_tasks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id        UUID NOT NULL REFERENCES public.outreach_enrollments(id) ON DELETE CASCADE,
  step_id              UUID NOT NULL REFERENCES public.outreach_sequence_steps(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  mode                 TEXT NOT NULL CHECK (mode IN ('auto', 'semi')),
  status               TEXT NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN (
                           'scheduled', 'ready', 'sending', 'sent',
                           'failed', 'skipped', 'cancelled'
                         )),
  scheduled_for        TIMESTAMPTZ NOT NULL DEFAULT now(),
  rendered_subject     TEXT,
  rendered_body        TEXT,
  provider             TEXT,
  provider_message_id  TEXT,
  sent_at              TIMESTAMPTZ,
  sent_by_email        TEXT,
  error                TEXT,
  meta                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outreach_send_tasks_due_idx
  ON public.outreach_send_tasks (status, scheduled_for);
CREATE INDEX IF NOT EXISTS outreach_send_tasks_enrollment_idx
  ON public.outreach_send_tasks (enrollment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outreach_send_tasks_queue_idx
  ON public.outreach_send_tasks (channel, status, scheduled_for)
  WHERE status = 'ready';

ALTER TABLE public.outreach_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_send_tasks ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outreach_sequences',
    'outreach_sequence_steps',
    'outreach_enrollments',
    'outreach_send_tasks'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
        t || '_select', t
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_insert') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (true)',
        t || '_insert', t
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_update') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (true)',
        t || '_update', t
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_delete') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (true)',
        t || '_delete', t
      );
    END IF;
  END LOOP;
END $$;
