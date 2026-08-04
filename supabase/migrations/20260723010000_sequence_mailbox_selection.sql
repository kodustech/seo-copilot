-- A sequence chooses one connected sender. NULL keeps the legacy workspace
-- default mailbox for existing campaigns.
ALTER TABLE public.outreach_sequences
  ADD COLUMN IF NOT EXISTS mailbox_id UUID
  REFERENCES public.outreach_mailboxes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS outreach_sequences_mailbox_idx
  ON public.outreach_sequences (mailbox_id)
  WHERE mailbox_id IS NOT NULL;
