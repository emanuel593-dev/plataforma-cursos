-- ============================================================================
-- 008 — Audit logs + Assignments & Submissions
-- ============================================================================

-- ── 1. Audit Logs ────────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  details     jsonb DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_actor    ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_entity   ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_logs_created  ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Only coordenação can read audit logs
CREATE POLICY "audit_select_coord" ON audit_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'coordenacao')
  );

-- Any authenticated user can insert (the service writes on their behalf)
CREATE POLICY "audit_insert_auth" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ── 2. Assignment Status Enum ────────────────────────────────────────────────

CREATE TYPE assignment_status AS ENUM ('draft', 'published', 'closed');
CREATE TYPE submission_status AS ENUM ('pending', 'submitted', 'graded', 'returned');

-- ── 3. Assignments ───────────────────────────────────────────────────────────

CREATE TABLE assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  due_date      timestamptz,
  max_score     numeric(5,2) NOT NULL DEFAULT 10.00,
  status        assignment_status NOT NULL DEFAULT 'draft',
  created_by    uuid NOT NULL REFERENCES profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_class ON assignments(class_id);

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;

-- Coordenação: full access
CREATE POLICY "assignments_all_coord" ON assignments FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'coordenacao')
);

-- Professor: CRUD on own classes
CREATE POLICY "assignments_prof" ON assignments FOR ALL USING (
  EXISTS (
    SELECT 1 FROM classes c
    JOIN profiles p ON p.id = auth.uid()
    WHERE c.id = assignments.class_id
      AND c.professor_id = auth.uid()
      AND p.role = 'professor'
  )
);

-- Aluno: read published assignments of enrolled classes
CREATE POLICY "assignments_student_read" ON assignments FOR SELECT USING (
  status = 'published' AND EXISTS (
    SELECT 1 FROM enrollments e
    WHERE e.class_id = assignments.class_id
      AND e.student_id = auth.uid()
      AND e.status = 'active'
  )
);

-- ── 4. Submissions ───────────────────────────────────────────────────────────

CREATE TABLE submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES profiles(id),
  content         text,
  file_url        text,
  status          submission_status NOT NULL DEFAULT 'pending',
  score           numeric(5,2),
  feedback        text,
  graded_by       uuid REFERENCES profiles(id),
  submitted_at    timestamptz,
  graded_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id)
);

CREATE INDEX idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX idx_submissions_student    ON submissions(student_id);

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Coordenação: full access
CREATE POLICY "submissions_all_coord" ON submissions FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'coordenacao')
);

-- Professor: read/update submissions of own classes
CREATE POLICY "submissions_prof_read" ON submissions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM assignments a
    JOIN classes c ON c.id = a.class_id
    WHERE a.id = submissions.assignment_id
      AND c.professor_id = auth.uid()
  )
);

CREATE POLICY "submissions_prof_update" ON submissions FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM assignments a
    JOIN classes c ON c.id = a.class_id
    WHERE a.id = submissions.assignment_id
      AND c.professor_id = auth.uid()
  )
);

-- Aluno: read own submissions, insert/update own submissions
CREATE POLICY "submissions_student_read" ON submissions FOR SELECT USING (
  student_id = auth.uid()
);

CREATE POLICY "submissions_student_insert" ON submissions FOR INSERT WITH CHECK (
  student_id = auth.uid()
);

CREATE POLICY "submissions_student_update" ON submissions FOR UPDATE USING (
  student_id = auth.uid() AND status IN ('pending', 'returned')
);
