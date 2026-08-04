-- Google OAuth connect for outreach mailbox (product "Sign in with Google").

ALTER TABLE public.outreach_mailboxes
  DROP CONSTRAINT IF EXISTS outreach_mailboxes_provider_check;

ALTER TABLE public.outreach_mailboxes
  ADD CONSTRAINT outreach_mailboxes_provider_check
  CHECK (provider IN ('smtp', 'gmail', 'google_oauth'));

ALTER TABLE public.outreach_mailboxes
  ALTER COLUMN smtp_user DROP NOT NULL;

ALTER TABLE public.outreach_mailboxes
  ALTER COLUMN smtp_pass_encrypted DROP NOT NULL;

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'smtp'
    CHECK (auth_method IN ('smtp', 'oauth'));

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS oauth_refresh_token_encrypted TEXT;

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS oauth_access_token_encrypted TEXT;

ALTER TABLE public.outreach_mailboxes
  ADD COLUMN IF NOT EXISTS oauth_token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN public.outreach_mailboxes.auth_method IS
  'smtp = app password; oauth = Google Sign-In (gmail.send)';
