-- The watchlist upsert targets ON CONFLICT (ats, board_slug), but the unique
-- index was created on (ats, lower(board_slug)) — an expression index, which
-- Postgres refuses for plain-column conflict inference (42P10), so every
-- discovery insert failed. Slugs are lowercased in code before hitting the
-- table, so a plain-column index is equivalent.
DROP INDEX IF EXISTS icp_watchlist_board_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS icp_watchlist_board_uniq
  ON icp_watchlist (ats, board_slug);
