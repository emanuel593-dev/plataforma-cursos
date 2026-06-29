-- ── Lesson reports ────────────────────────────────────────────────────────────

CREATE TABLE lesson_reports (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id uuid        REFERENCES scheduled_lessons(id) ON DELETE SET NULL,
  professor_id        uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  professor_name      text        NOT NULL,
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz NOT NULL,
  duration_minutes    integer     NOT NULL CHECK (duration_minutes >= 0),
  participants        jsonb       NOT NULL DEFAULT '[]',
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lesson_reports ENABLE ROW LEVEL SECURITY;

-- Coordenação: full read + delete access
CREATE POLICY "coordenacao_all_reports" ON lesson_reports
  FOR ALL TO authenticated
  USING (get_my_role() = 'coordenacao')
  WITH CHECK (get_my_role() = 'coordenacao');

-- Professors: read own reports + insert own reports
CREATE POLICY "professor_read_own_reports" ON lesson_reports
  FOR SELECT TO authenticated
  USING (professor_id = auth.uid() OR get_my_role() = 'coordenacao');

CREATE POLICY "professor_insert_reports" ON lesson_reports
  FOR INSERT TO authenticated
  WITH CHECK (professor_id = auth.uid());
