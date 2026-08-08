-- ---------------------------------------------------------------------------
-- LinkedIn commenters: people who publicly commented on a post about a topic
-- we sell into. Unlike research_rows (companies) these are named humans, and
-- the thing that makes them worth contacting is not fit but the comment —
-- dated, public, quotable.
--
-- Two tables, because a person is not a trigger:
--   linkedin_commenters          — one row per person per list, deduped on
--                                  profile_url. Identity + role + degree.
--   linkedin_commenter_triggers  — append-only, one row per comment. The same
--                                  person commenting on three posts is one
--                                  commenter with three triggers.
--
-- Nothing is written here unless the caller passes a research table to harvest
-- into, so exploring topics stays read-only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS linkedin_commenters (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The list this person was harvested into. Scoping to a table mirrors how
  -- research_rows dedupes per table: the same person can legitimately appear
  -- in two lists built for two different motions.
  research_table_id   UUID NOT NULL REFERENCES research_tables(id) ON DELETE CASCADE,
  -- Canonical https://www.linkedin.com/in/<slug>. The dedupe key.
  profile_url         TEXT NOT NULL,
  name                TEXT NOT NULL,
  headline            TEXT,                       -- role, as LinkedIn shows it
  -- DISTANCE_1 | DISTANCE_2 | DISTANCE_3 | OUT_OF_NETWORK. Decides whether
  -- this person gets a direct message or goes to the cold queue.
  network_distance    TEXT,
  provider_id         TEXT,                       -- ACoAA… member id, for Unipile sends
  public_identifier   TEXT,                       -- vanity slug
  profile_picture_url TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT linkedin_commenters_table_profile_key UNIQUE (research_table_id, profile_url)
);

CREATE INDEX IF NOT EXISTS linkedin_commenters_table_idx
  ON linkedin_commenters (research_table_id, last_seen_at DESC);
-- Partial index on the degrees that route to a direct message.
CREATE INDEX IF NOT EXISTS linkedin_commenters_distance_idx
  ON linkedin_commenters (research_table_id, network_distance)
  WHERE network_distance IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_commenter_triggers (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  commenter_id  UUID NOT NULL REFERENCES linkedin_commenters(id) ON DELETE CASCADE,
  -- Unipile's comment id. Re-running a harvest over the same post must not
  -- add the same trigger twice.
  comment_id    TEXT NOT NULL,
  post_url      TEXT NOT NULL,                    -- the source post — never null
  activity_id   TEXT,                             -- 7462609441322926081
  post_social_id TEXT,                            -- urn:li:activity:… / ugcPost id
  comment_text  TEXT,
  commented_at  TIMESTAMPTZ,                      -- the trigger date
  is_reply      BOOLEAN NOT NULL DEFAULT false,   -- reply to a comment, not top level
  reaction_count INTEGER,
  reply_count   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT linkedin_commenter_triggers_comment_key UNIQUE (commenter_id, comment_id)
);

CREATE INDEX IF NOT EXISTS linkedin_commenter_triggers_commenter_idx
  ON linkedin_commenter_triggers (commenter_id, commented_at DESC);
CREATE INDEX IF NOT EXISTS linkedin_commenter_triggers_post_idx
  ON linkedin_commenter_triggers (post_url);

-- RLS: authenticated users read; writes go through the service-role client
-- (the harvest tools), which bypasses RLS. No insert/update policies on
-- purpose — same convention as product_signals.
ALTER TABLE linkedin_commenters         ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_commenter_triggers ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['linkedin_commenters','linkedin_commenter_triggers']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_select', t);
    END IF;
  END LOOP;
END $$;
