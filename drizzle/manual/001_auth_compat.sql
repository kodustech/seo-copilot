-- Supabase-Auth compatibility layer for the Railway database.
--
-- Auth stays on Supabase; only the data moved. The 39 RLS policies that scope
-- rows per user call auth.jwt()/auth.uid()/auth.role(), so rather than rewrite
-- them (39 chances to get authorization subtly wrong) we reimplement the three
-- functions with the same semantics Supabase gives them: read the verified JWT
-- claims out of a per-transaction GUC. The policies then restore verbatim from
-- any pg_dump of the source, now and later.
--
-- The app sets the GUC per request; see withUser() in lib/db/index.ts.
--
-- Not applied by drizzle-kit — it lives outside the migration journal on
-- purpose. Apply with:
--   psql "$DATABASE_ADMIN_URL" -f drizzle/manual/001_auth_compat.sql

CREATE SCHEMA IF NOT EXISTS "auth";

-- Mirrors Supabase's implementation: the claims GUC, or {} when unset.
CREATE OR REPLACE FUNCTION "auth"."jwt"() RETURNS jsonb
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    )
  $$;

CREATE OR REPLACE FUNCTION "auth"."uid"() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif("auth"."jwt"() ->> 'sub', '')::uuid $$;

CREATE OR REPLACE FUNCTION "auth"."role"() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT "auth"."jwt"() ->> 'role' $$;

-- ---------------------------------------------------------------------------
-- Application role. Deliberately NOT the table owner and NOT BYPASSRLS: an
-- owner silently ignores every policy below, which is the whole failure mode
-- this file exists to prevent.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE "app_user" LOGIN INHERIT;
  END IF;
END $$;

-- The policies are declared `TO authenticated`; a role that is not a member of
-- it matches no policy at all, and RLS then returns zero rows with no error.
GRANT "authenticated" TO "app_user";

GRANT USAGE ON SCHEMA "public", "auth" TO "app_user", "authenticated";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "auth" TO "app_user", "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public"
  TO "app_user", "authenticated";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public"
  TO "app_user", "authenticated";

ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app_user", "authenticated";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "app_user", "authenticated";
