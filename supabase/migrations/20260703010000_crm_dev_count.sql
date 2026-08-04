-- Number of developers at the company — a key qualifying metric for a
-- dev-tooling product (distinct from the generic `size` band and from the
-- product `userCount` signal pulled via org_id).
ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS dev_count INTEGER;
