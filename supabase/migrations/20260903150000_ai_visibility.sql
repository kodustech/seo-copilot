-- ---------------------------------------------------------------------------
-- AI visibility: buyer prompts run weekly through the assistants people use
-- (ChatGPT, Perplexity, Gemini, Claude) via DataForSEO LLM Responses, with
-- the answer, whether the brand shows up, in which position, which
-- competitors are named and which pages the model cited.
--
-- Replaces the LLM Mentions snapshot (llm_mentions_snapshots), which never
-- saw the brand: seven days of zeros in a row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_visibility_settings (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Day of week the weekly run happens, 0 = Sunday, in UTC.
  weekday          SMALLINT NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  -- Assistants to ask, with the model DataForSEO should use for each.
  engines          JSONB NOT NULL DEFAULT '[{"engine":"perplexity","model":"sonar"},{"engine":"chat_gpt","model":"gpt-5.5"}]',
  brand_terms      TEXT[] NOT NULL DEFAULT ARRAY['kodus', 'kody'],
  competitor_terms TEXT[] NOT NULL DEFAULT ARRAY[
    'CodeRabbit', 'Qodo', 'PR-Agent', 'Greptile', 'GitLab Duo', 'GitHub Copilot', 'Copilot',
    'Bito', 'CodeAnt', 'Panto', 'Graphite', 'Sourcery', 'Codacy', 'SonarQube', 'Cursor', 'Bugbot',
    'Augment', 'Macroscope', 'Ellipsis', 'Baz', 'Korbit', 'Codium', 'Gemini Code Assist', 'Amazon Q',
    'CodeGuru', 'Devin', 'Sweep', 'Snyk', 'DeepSource', 'Semgrep', 'Code Turtle', 'Codeward', 'Reviewdog',
    'Optimal AI', 'Entelligence', 'CodeScene', 'Claude Code'
  ],
  last_run_on      DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ai_visibility_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_prompts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt           TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 5 AND 500),
  language         TEXT NOT NULL DEFAULT 'en',
  tags             TEXT[] NOT NULL DEFAULT '{}',
  active           BOOLEAN NOT NULL DEFAULT true,
  created_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_prompts_active_idx ON ai_prompts (active, created_at);

CREATE TABLE IF NOT EXISTS ai_prompt_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id        UUID NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
  run_on           DATE NOT NULL,
  engine           TEXT NOT NULL,
  model_name       TEXT,
  mentioned        BOOLEAN NOT NULL DEFAULT false,
  -- 1-based place of the first list item naming the brand; null when the
  -- answer is not a list or the brand is absent.
  position         INTEGER,
  list_size        INTEGER,
  -- The model cited one of our pages as a source.
  brand_cited      BOOLEAN NOT NULL DEFAULT false,
  competitors      TEXT[] NOT NULL DEFAULT '{}',
  cited_domains    TEXT[] NOT NULL DEFAULT '{}',
  citations        JSONB NOT NULL DEFAULT '[]',
  fan_out_queries  JSONB NOT NULL DEFAULT '[]',
  answer           TEXT,
  cost_usd         NUMERIC(10, 6),
  error            TEXT,
  raw              JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, engine, run_on)
);
CREATE INDEX IF NOT EXISTS ai_prompt_runs_run_on_idx ON ai_prompt_runs (run_on DESC, engine);
CREATE INDEX IF NOT EXISTS ai_prompt_runs_prompt_idx ON ai_prompt_runs (prompt_id, run_on DESC);

ALTER TABLE ai_visibility_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prompt_runs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_visibility_settings', 'ai_prompts', 'ai_prompt_runs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_select') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_select', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_insert') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (true)', t || '_insert', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_update') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (true)', t || '_update', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = t || '_delete') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (true)', t || '_delete', t);
    END IF;
  END LOOP;
END $$;
