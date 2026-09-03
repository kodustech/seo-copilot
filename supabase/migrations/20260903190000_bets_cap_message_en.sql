-- The active-bet cap message in English, like the rest of the UI.
CREATE OR REPLACE FUNCTION bets_enforce_active_cap() RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bets_active_cap'));
  SELECT COUNT(*) INTO active_count FROM bets WHERE status = 'active' AND id <> NEW.id;
  IF active_count >= 3 THEN
    RAISE EXCEPTION '3 bets are already active. Decide one (won, lost or became operation) before activating another.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
