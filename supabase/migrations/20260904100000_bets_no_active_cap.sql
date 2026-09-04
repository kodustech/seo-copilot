-- No cap on active bets: the team runs as many hypotheses as it has owners
-- for. The queue stays for what has not started yet.
DROP TRIGGER IF EXISTS bets_active_cap ON bets;
DROP FUNCTION IF EXISTS bets_enforce_active_cap();
