-- ---------------------------------------------------------------------------
-- Who the connected LinkedIn account is connected to, cached per Unipile
-- account (lib/outreach/linkedin-relations.ts).
--
-- A sequence DM is only released once the person has accepted the invite.
-- Unipile asks for the relations list to be read rarely and at irregular
-- times, so one read serves every DM check until next_fetch_after, which
-- carries its own random jitter. Identities are normalized (lowercased) slugs
-- and member ids, never names.
--
-- The app tolerates this table being absent (it falls back to an in-process
-- cache), so the code may deploy before or after this migration.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.linkedin_relations_cache (
  account_id       TEXT PRIMARY KEY,
  identities       TEXT[] NOT NULL DEFAULT '{}',
  -- The whole list was read: someone missing from it is not a connection.
  complete         BOOLEAN NOT NULL DEFAULT false,
  -- On a partial read: every connection made after this is in identities.
  covered_since    TIMESTAMPTZ,
  fetched_at       TIMESTAMPTZ NOT NULL,
  next_fetch_after TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.linkedin_relations_cache ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT := 'linkedin_relations_cache';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_select', t);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_insert') THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (true)', t || '_insert', t);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_update') THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (true)', t || '_update', t);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_delete') THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (true)', t || '_delete', t);
  END IF;
END $$;
