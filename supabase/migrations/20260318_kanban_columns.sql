-- Kanban columns (shared across all users)
CREATE TABLE IF NOT EXISTS kanban_columns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed with defaults matching current KANBAN_STAGES
INSERT INTO kanban_columns (name, slug, position) VALUES
  ('Backlog',   'backlog',    0),
  ('Research',  'research',   1),
  ('SEO Ready', 'seo_ready',  2),
  ('Drafting',  'drafting',   3),
  ('Review',    'review',     4),
  ('Scheduled', 'scheduled',  5),
  ('Published', 'published',  6)
ON CONFLICT (slug) DO NOTHING;

-- Add column_id and position to work items
ALTER TABLE growth_work_items
  ADD COLUMN IF NOT EXISTS column_id UUID REFERENCES kanban_columns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;

-- Backfill column_id from existing stage values
UPDATE growth_work_items wi
SET column_id = kc.id
FROM kanban_columns kc
WHERE wi.stage = kc.slug AND wi.column_id IS NULL;

-- Allow all authenticated users to read all kanban data (shared board)
ALTER TABLE growth_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE kanban_columns ENABLE ROW LEVEL SECURITY;

-- Policies for kanban_columns (all authenticated users can CRUD)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kanban_columns_select') THEN
    CREATE POLICY kanban_columns_select ON kanban_columns FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kanban_columns_insert') THEN
    CREATE POLICY kanban_columns_insert ON kanban_columns FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kanban_columns_update') THEN
    CREATE POLICY kanban_columns_update ON kanban_columns FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kanban_columns_delete') THEN
    CREATE POLICY kanban_columns_delete ON kanban_columns FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
