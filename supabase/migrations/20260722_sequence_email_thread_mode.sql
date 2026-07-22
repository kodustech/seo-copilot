-- Per email step: start a new thread or reply in the previous one.
ALTER TABLE public.outreach_sequence_steps
  ADD COLUMN IF NOT EXISTS email_thread_mode TEXT
    CHECK (
      email_thread_mode IS NULL
      OR email_thread_mode IN ('new', 'reply')
    );

-- Existing multi-step cadences: default follow-ups to reply (previous behavior).
UPDATE public.outreach_sequence_steps
SET email_thread_mode = 'reply'
WHERE channel = 'email' AND email_thread_mode IS NULL;

COMMENT ON COLUMN public.outreach_sequence_steps.email_thread_mode IS
  'email only: new = open a new conversation; reply = In-Reply-To previous email in this enrollment';
