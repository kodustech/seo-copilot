-- Personal MCP access tokens (PATs) for multi-user MCP auth.
-- Raw token is shown once at creation; only sha256 hash is stored.

CREATE TABLE IF NOT EXISTS public.mcp_personal_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email   TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_personal_tokens_user_id_idx
  ON public.mcp_personal_tokens (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS mcp_personal_tokens_hash_idx
  ON public.mcp_personal_tokens (token_hash)
  WHERE revoked_at IS NULL;

ALTER TABLE public.mcp_personal_tokens ENABLE ROW LEVEL SECURITY;

-- Authenticated users can list/update their own rows (service role used for
-- hash lookup on /api/mcp and for create after ownership checks in API).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'mcp_personal_tokens_select'
  ) THEN
    CREATE POLICY mcp_personal_tokens_select ON public.mcp_personal_tokens
      FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'mcp_personal_tokens_update'
  ) THEN
    CREATE POLICY mcp_personal_tokens_update ON public.mcp_personal_tokens
      FOR UPDATE TO authenticated
      USING (user_id = auth.uid());
  END IF;
END $$;

COMMENT ON TABLE public.mcp_personal_tokens IS
  'Personal MCP Bearer tokens. Hash only; mint via Settings → MCP access.';
