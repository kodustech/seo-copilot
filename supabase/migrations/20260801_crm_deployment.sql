-- Deployment model of the account's Kodus usage.
--   cloud       — uses Kodus Cloud (set automatically by the product-signals
--                 sweep whenever the account is linked to a product org)
--   self_hosted — runs Kodus self-hosted (set by a human; there is no
--                 identity in self-hosted telemetry to automate this)
-- NULL means unknown.
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS deployment TEXT;
CREATE INDEX IF NOT EXISTS crm_companies_deployment_idx
  ON crm_companies (deployment) WHERE deployment IS NOT NULL;
