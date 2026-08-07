-- ---------------------------------------------------------------------------
-- Suggestion counts on the signals snapshot, so outbound copy can say what Kody
-- actually did for an account: "reviewed N pull requests, left N suggestions,
-- your team applied N of them".
--
-- Until now these existed only in lib/crm-signals.ts (single-org, on demand,
-- for the CRM drawer). The sweep never collected them, so there was no token to
-- put in a template — copy claiming a suggestion count had to be hand-typed,
-- which also meant it carried no {{token}} and slipped past the send guard that
-- blocks unresolved tokens.
--
-- Both implementation columns are kept: partial routinely outnumbers full, and
-- "applied" (the sum) and "implemented" (the strict number) are different
-- claims. The rendering layer decides which one the copy makes.
-- ---------------------------------------------------------------------------

ALTER TABLE product_signals_latest
  -- Distinct PRs with a delivered review, last 30d. Not reviews_30d, which
  -- counts successful executions and runs several times higher: the same PR is
  -- re-reviewed on every push.
  ADD COLUMN IF NOT EXISTS prs_reviewed_30d           INTEGER,
  -- Delivered suggestions only (deliveryStatus = 'sent'), last 30d.
  ADD COLUMN IF NOT EXISTS suggestions_30d            INTEGER,
  ADD COLUMN IF NOT EXISTS suggestions_implemented_30d INTEGER,
  ADD COLUMN IF NOT EXISTS suggestions_partial_30d    INTEGER;
