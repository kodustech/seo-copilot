-- ---------------------------------------------------------------------------
-- Bet journal: what was actually done for a bet, entry by entry, with a
-- date, an author and an optional link (an article, a sequence, a list).
-- The page shows it as a timeline; evaluateBet hands it to the agent next to
-- the numbers, so "did we do the thing" is answered from the record, not
-- from memory.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bet_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id        UUID NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'artifact', 'result', 'decision')),
  text          TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  url           TEXT,
  author_email  TEXT,
  happened_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bet_entries_bet_idx ON bet_entries (bet_id, happened_on DESC, created_at DESC);

ALTER TABLE bet_entries ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bet_entries_select') THEN
    CREATE POLICY bet_entries_select ON bet_entries FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bet_entries_insert') THEN
    CREATE POLICY bet_entries_insert ON bet_entries FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bet_entries_update') THEN
    CREATE POLICY bet_entries_update ON bet_entries FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bet_entries_delete') THEN
    CREATE POLICY bet_entries_delete ON bet_entries FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
