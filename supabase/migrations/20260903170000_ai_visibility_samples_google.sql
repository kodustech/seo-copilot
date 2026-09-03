-- ---------------------------------------------------------------------------
-- AI visibility: several samples per prompt, and Google AI Overview.
--
-- One answer per week is a sample of one, and assistants vary between runs;
-- a prompt can now be asked N times per engine (samples) and the share is
-- read over samples. Google AI Overview joins as an engine of its own
-- (DataForSEO SERP API with the overview loaded), with engine-specific
-- facts (overview present, organic rank) kept in `extra`.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_prompt_runs ADD COLUMN IF NOT EXISTS sample SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE ai_prompt_runs ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';
ALTER TABLE ai_prompt_runs DROP CONSTRAINT IF EXISTS ai_prompt_runs_prompt_id_engine_run_on_key;
ALTER TABLE ai_prompt_runs DROP CONSTRAINT IF EXISTS ai_prompt_runs_prompt_engine_run_on_sample_key;
ALTER TABLE ai_prompt_runs ADD CONSTRAINT ai_prompt_runs_prompt_engine_run_on_sample_key UNIQUE (prompt_id, engine, run_on, sample);

-- Existing settings: Perplexity gets three samples (cheap), Google AI
-- Overview is added once. New installs get the same from the defaults.
UPDATE ai_visibility_settings
SET engines = (
  SELECT COALESCE(jsonb_agg(CASE WHEN e->>'engine' = 'perplexity' THEN e || '{"samples":3}'::jsonb ELSE e END), '[]'::jsonb)
  FROM jsonb_array_elements(engines) e
) || CASE
  WHEN engines::text LIKE '%google_ai%' THEN '[]'::jsonb
  ELSE '[{"engine":"google_ai","model":"ai_overview","samples":1}]'::jsonb
END,
updated_at = now()
WHERE id = 1;

ALTER TABLE ai_visibility_settings
  ALTER COLUMN engines SET DEFAULT '[{"engine":"perplexity","model":"sonar","samples":3},{"engine":"chat_gpt","model":"gpt-5.5","samples":1},{"engine":"google_ai","model":"ai_overview","samples":1}]';

-- Distinct run dates aggregated in the database, so the summary reads the
-- last N dates instead of every row. The existing (run_on DESC, engine)
-- index leads on run_on and serves the GROUP BY. security_invoker keeps the
-- table's RLS in force.
CREATE OR REPLACE VIEW ai_prompt_run_dates WITH (security_invoker = true) AS
  SELECT run_on, COUNT(*) AS runs FROM ai_prompt_runs GROUP BY run_on;
GRANT SELECT ON ai_prompt_run_dates TO authenticated, service_role;
