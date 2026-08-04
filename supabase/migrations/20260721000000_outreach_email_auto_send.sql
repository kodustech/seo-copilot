-- Workspace mailbox: whether sequence email steps auto-send or go to the human queue.

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS email_auto_send BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.outreach_mailboxes.email_auto_send IS
  'If true, due email auto steps send via mailbox. If false, they land in the activity queue for manual send.';
