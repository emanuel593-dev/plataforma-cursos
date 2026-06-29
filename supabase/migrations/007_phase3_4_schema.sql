-- Phase 3 & 4: announcement_reads, class_materials, enrollment_status expansion
-- Date: 2026-04-15

-- ── 1. Expand enrollment_status enum ─────────────────────────────────────────

ALTER TYPE enrollment_status ADD VALUE IF NOT EXISTS 'graduated';
ALTER TYPE enrollment_status ADD VALUE IF NOT EXISTS 'failed';

-- ── 2. announcement_reads table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS announcement_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE(announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement ON announcement_reads(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id);

ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can see reads
DROP POLICY IF EXISTS announcement_reads_select ON announcement_reads;
CREATE POLICY announcement_reads_select ON announcement_reads
  FOR SELECT TO authenticated
  USING (true);

-- Users can only insert their own reads
DROP POLICY IF EXISTS announcement_reads_insert ON announcement_reads;
CREATE POLICY announcement_reads_insert ON announcement_reads
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- No updates allowed (read is immutable)
-- No deletes by users (cascade from announcement deletion handles cleanup)

-- ── 3. class_materials table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS class_materials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title       text NOT NULL,
  url         text NOT NULL,
  type        text NOT NULL DEFAULT 'link' CHECK (type IN ('link', 'pdf', 'video', 'other')),
  uploaded_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_materials_class ON class_materials(class_id);
CREATE INDEX IF NOT EXISTS idx_class_materials_uploaded_by ON class_materials(uploaded_by);

ALTER TABLE class_materials ENABLE ROW LEVEL SECURITY;

-- Select: coordenacao sees all; professor sees own classes; student sees enrolled classes
DROP POLICY IF EXISTS class_materials_select ON class_materials;
CREATE POLICY class_materials_select ON class_materials
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = class_materials.class_id
        AND c.professor_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id = class_materials.class_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
  );

-- Insert: coordenacao + professor of the class
DROP POLICY IF EXISTS class_materials_insert ON class_materials;
CREATE POLICY class_materials_insert ON class_materials
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND (
      get_my_role() = 'coordenacao'
      OR EXISTS (
        SELECT 1 FROM classes c
        WHERE c.id = class_materials.class_id
          AND c.professor_id = auth.uid()
      )
    )
  );

-- Delete: coordenacao + uploader
DROP POLICY IF EXISTS class_materials_delete ON class_materials;
CREATE POLICY class_materials_delete ON class_materials
  FOR DELETE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR uploaded_by = auth.uid()
  );

-- Update: coordenacao + uploader
DROP POLICY IF EXISTS class_materials_update ON class_materials;
CREATE POLICY class_materials_update ON class_materials
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR uploaded_by = auth.uid()
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR uploaded_by = auth.uid()
  );
