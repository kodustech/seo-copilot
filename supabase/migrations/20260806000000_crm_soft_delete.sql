-- ---------------------------------------------------------------------------
-- `archived_at`: excluding an account has to be remembered.
--
-- Deleting was a real DELETE, and nothing recorded that a human had said no.
-- The product-signals sweep looks an account up by org_id, then by domain, and
-- creates one when neither matches — so every account someone removed came
-- back on the next run, with the signup contacts recreated and prep_status
-- reset to 'not_started'. The ON DELETE CASCADE took the manually added people
-- with it on the way out, which is why accounts that had been vetted 'ready'
-- reappeared as 'enriched' holding the wrong people: they were not the same
-- row at all, they were a new one wearing the same domain.
--
-- Soft delete fixes both halves at once, and specifically because the row
-- stays: crm_companies_domain_uniq covers archived rows, so the sweep's own
-- domain lookup finds the account it would otherwise recreate. There is
-- nothing extra for the sweep to consult and no exclusion list to keep in sync
-- — the account is its own tombstone, with its timeline, comments and vetting
-- history intact for whoever asks later why it was dropped.
--
-- Contacts get the same column for the same reason on a smaller scale: the
-- people lookup merges against the contacts that exist, so a person you
-- deleted was invisible to the matcher and got created again by the next
-- "Find people". Archived, they are visible to the matcher and skipped.
-- ---------------------------------------------------------------------------

ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE crm_contacts  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Every list in the product is "the accounts that are not archived, newest
-- activity first". Partial indexes so the archived rows cost nothing to skip.
CREATE INDEX IF NOT EXISTS crm_companies_active_idx
  ON crm_companies (last_activity_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS crm_contacts_active_idx
  ON crm_contacts (company_id)
  WHERE archived_at IS NULL;
