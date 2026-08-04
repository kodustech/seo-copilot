-- Outbound reply inbox: Gmail sync of sequence thread replies.

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS gmail_history_id TEXT;

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS oauth_granted_scopes TEXT;

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS gmail_readonly_ok BOOLEAN;

COMMENT ON COLUMN public.outreach_mailboxes.gmail_history_id IS
  'Gmail users.history cursor for incremental inbox sync.';
COMMENT ON COLUMN public.outreach_mailboxes.oauth_granted_scopes IS
  'Space-separated scopes from last OAuth token grant.';
COMMENT ON COLUMN public.outreach_mailboxes.gmail_readonly_ok IS
  'True when gmail.readonly is available for reply sync.';

CREATE TABLE IF NOT EXISTS public.outreach_reply_threads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id          UUID NOT NULL REFERENCES public.outreach_mailboxes(id) ON DELETE CASCADE,
  enrollment_id       UUID REFERENCES public.outreach_enrollments(id) ON DELETE SET NULL,
  sequence_id         UUID REFERENCES public.outreach_sequences(id) ON DELETE SET NULL,
  gmail_thread_id     TEXT NOT NULL,
  contact_email       TEXT,
  contact_name        TEXT,
  company_name        TEXT,
  subject             TEXT,
  snippet             TEXT,
  status              TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new', 'open', 'done', 'snoozed')),
  snoozed_until       TIMESTAMPTZ,
  matched_how         TEXT NOT NULL DEFAULT 'unmatched'
                        CHECK (matched_how IN (
                          'gmail_thread', 'in_reply_to', 'from_email', 'unmatched'
                        )),
  message_count       INT NOT NULL DEFAULT 0,
  first_inbound_at    TIMESTAMPTZ,
  last_inbound_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, gmail_thread_id)
);

CREATE INDEX IF NOT EXISTS outreach_reply_threads_status_idx
  ON public.outreach_reply_threads (status, last_inbound_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS outreach_reply_threads_enrollment_idx
  ON public.outreach_reply_threads (enrollment_id)
  WHERE enrollment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outreach_reply_threads_sequence_idx
  ON public.outreach_reply_threads (sequence_id)
  WHERE sequence_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.outreach_reply_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           UUID NOT NULL REFERENCES public.outreach_reply_threads(id) ON DELETE CASCADE,
  gmail_message_id    TEXT NOT NULL,
  direction           TEXT NOT NULL
                        CHECK (direction IN ('inbound', 'outbound_ours')),
  from_email          TEXT,
  to_emails           TEXT[] NOT NULL DEFAULT '{}',
  subject             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  snippet             TEXT,
  rfc_message_id      TEXT,
  in_reply_to         TEXT,
  internal_date       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS outreach_reply_messages_thread_idx
  ON public.outreach_reply_messages (thread_id, internal_date ASC NULLS LAST);

CREATE INDEX IF NOT EXISTS outreach_reply_messages_rfc_idx
  ON public.outreach_reply_messages (rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;

ALTER TABLE public.outreach_reply_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_reply_messages ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outreach_reply_threads',
    'outreach_reply_messages'
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

COMMENT ON TABLE public.outreach_reply_threads IS
  'Inbound reply threads matched to sequence enrollments via Gmail sync.';
COMMENT ON TABLE public.outreach_reply_messages IS
  'Messages inside a reply thread (ours + inbound).';
