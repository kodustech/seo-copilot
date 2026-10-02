-- ---------------------------------------------------------------------------
-- Recurring goals carry the funnel stage they are bound to.
--
-- Without it, each goal the cron materializes from a rule (for example a
-- weekly goal on ob_contacts) is born unbound and falls back to manual
-- progress, so the funnel sync stops writing it after the first week.
--
-- goal_recurrences was created by docs/migrations/2026-05-23-goals-recurrence-and-kind.sql,
-- outside this folder, so the column is only added where the table exists.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.goal_recurrences') IS NOT NULL THEN
    ALTER TABLE public.goal_recurrences ADD COLUMN IF NOT EXISTS funnel_metric TEXT;
  END IF;
END $$;
