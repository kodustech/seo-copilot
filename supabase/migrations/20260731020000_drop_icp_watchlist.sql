-- Remove ICP watchlist + signals product surface.
-- Job-board helpers under lib/icp remain for research find/enrich only.

DROP TABLE IF EXISTS icp_signals CASCADE;
DROP TABLE IF EXISTS icp_watchlist CASCADE;
