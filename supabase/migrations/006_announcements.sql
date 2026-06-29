-- Add announcements table for dashboard notices and engagement

CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid REFERENCES classes(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  is_pinned boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_class ON announcements(class_id);
CREATE INDEX IF NOT EXISTS idx_announcements_author ON announcements(author_id);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_pinned ON announcements(is_pinned, created_at DESC);

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS announcements_select ON announcements;
CREATE POLICY announcements_select ON announcements
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR class_id IS NULL
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = announcements.class_id
        AND c.professor_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id = announcements.class_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
  );

DROP POLICY IF EXISTS announcements_insert ON announcements;
CREATE POLICY announcements_insert ON announcements
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'coordenacao' AND author_id = auth.uid())
    OR (
      get_my_role() = 'professor'
      AND author_id = auth.uid()
      AND class_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM classes c
        WHERE c.id = announcements.class_id
          AND c.professor_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS announcements_update ON announcements;
CREATE POLICY announcements_update ON announcements
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR (get_my_role() = 'professor' AND author_id = auth.uid())
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR (
      get_my_role() = 'professor'
      AND author_id = auth.uid()
      AND class_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM classes c
        WHERE c.id = announcements.class_id
          AND c.professor_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS announcements_delete ON announcements;
CREATE POLICY announcements_delete ON announcements
  FOR DELETE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR (get_my_role() = 'professor' AND author_id = auth.uid())
  );
