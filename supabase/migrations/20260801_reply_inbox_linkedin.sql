-- Reply inbox: support LinkedIn threads from Unipile (alongside Gmail).

ALTER TABLE public.outreach_reply_threads
  ALTER COLUMN mailbox_id DROP NOT NULL;

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS unipile_account_id TEXT;

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS contact_linkedin TEXT;

-- channel check (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outreach_reply_threads_channel_check'
  ) THEN
    ALTER TABLE public.outreach_reply_threads
      ADD CONSTRAINT outreach_reply_threads_channel_check
      CHECK (channel IN ('email', 'linkedin'));
  END IF;
END $$;

-- Expand matched_how for LinkedIn profile match
ALTER TABLE public.outreach_reply_threads
  DROP CONSTRAINT IF EXISTS outreach_reply_threads_matched_how_check;

ALTER TABLE public.outreach_reply_threads
  ADD CONSTRAINT outreach_reply_threads_matched_how_check
  CHECK (matched_how IN (
    'gmail_thread',
    'in_reply_to',
    'from_email',
    'linkedin_profile',
    'unmatched'
  ));

-- Replace unique (mailbox_id, gmail_thread_id) with channel-aware indexes.
-- Postgres auto-name for UNIQUE (mailbox_id, gmail_thread_id) is typically:
-- outreach_reply_threads_mailbox_id_gmail_thread_id_key
ALTER TABLE public.outreach_reply_threads
  DROP CONSTRAINT IF EXISTS outreach_reply_threads_mailbox_id_gmail_thread_id_key;

DROP INDEX IF EXISTS outreach_reply_threads_mailbox_id_gmail_thread_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS outreach_reply_threads_email_uniq
  ON public.outreach_reply_threads (mailbox_id, gmail_thread_id)
  WHERE channel = 'email' AND mailbox_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outreach_reply_threads_linkedin_uniq
  ON public.outreach_reply_threads (unipile_account_id, gmail_thread_id)
  WHERE channel = 'linkedin' AND unipile_account_id IS NOT NULL;

COMMENT ON COLUMN public.outreach_reply_threads.channel IS
  'email = Gmail sequence replies; linkedin = Unipile LinkedIn DMs';
COMMENT ON COLUMN public.outreach_reply_threads.unipile_account_id IS
  'Unipile account id when channel=linkedin';
COMMENT ON COLUMN public.outreach_reply_threads.gmail_thread_id IS
  'Gmail thread id OR Unipile chat_id (provider thread key)';
