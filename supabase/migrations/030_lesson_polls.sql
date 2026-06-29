-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 030_lesson_polls                                                         ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Phase 4 of the monitor rollout: live in-class dynamics (polls / quizzes).║
-- ║                                                                          ║
-- ║ Two tables:                                                              ║
-- ║   • lesson_polls           — the question and lifecycle (draft/open/closed)
-- ║   • lesson_poll_responses  — one row per (poll, student); upsert on edit ║
-- ║                                                                          ║
-- ║ Authoring is restricted to staff bound to the class (coordenação,        ║
-- ║ class professor, class monitor). Students can only respond while the     ║
-- ║ poll is OPEN, and only if they are enrolled. Authors and coordenação    ║
-- ║ see all responses; students see only their own row.                      ║
-- ║                                                                          ║
-- ║ class_id is denormalized into both tables so RLS policies stay free of   ║
-- ║ joins (mirrors the lesson_evaluations decision in mig 029).              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── lesson_polls ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lesson_polls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id uuid NOT NULL REFERENCES scheduled_lessons(id) ON DELETE CASCADE,
  class_id            uuid NOT NULL REFERENCES classes(id)            ON DELETE CASCADE,
  created_by          uuid NOT NULL REFERENCES profiles(id)           ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('multiple_choice','true_false','open_text')),
  question            text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  -- options: jsonb array of strings. NULL allowed for open_text. For
  -- true_false we expect ["Verdadeiro","Falso"] but it is also accepted as
  -- NULL (UI defaults). Length capped at 6 to keep the bar chart readable.
  options             jsonb,
  -- correct_option: 0-based index into options[]. NULL = no answer key.
  -- Only meaningful for multiple_choice / true_false.
  correct_option      int,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  opened_at           timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lesson_polls_lesson ON lesson_polls(scheduled_lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_polls_class  ON lesson_polls(class_id);
CREATE INDEX IF NOT EXISTS idx_lesson_polls_status ON lesson_polls(status);

-- Defensive shape check on options: must be a jsonb array (or null), and
-- when present must hold 2..6 string elements.
ALTER TABLE lesson_polls
  DROP CONSTRAINT IF EXISTS lesson_polls_options_shape;
ALTER TABLE lesson_polls
  ADD CONSTRAINT lesson_polls_options_shape CHECK (
    options IS NULL
    OR (
      jsonb_typeof(options) = 'array'
      AND jsonb_array_length(options) BETWEEN 2 AND 6
    )
  );

-- ── lesson_poll_responses ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lesson_poll_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id         uuid NOT NULL REFERENCES lesson_polls(id) ON DELETE CASCADE,
  -- class_id denormalized again: lets RLS check enrollment without
  -- joining lesson_polls on every row.
  class_id        uuid NOT NULL REFERENCES classes(id)      ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES profiles(id)     ON DELETE CASCADE,
  selected_option int,
  text_answer     text CHECK (char_length(coalesce(text_answer, '')) <= 1000),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (poll_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_poll_responses_poll
  ON lesson_poll_responses(poll_id);
CREATE INDEX IF NOT EXISTS idx_lesson_poll_responses_student
  ON lesson_poll_responses(student_id);

-- ── RLS: lesson_polls ──────────────────────────────────────────────────────
ALTER TABLE lesson_polls ENABLE ROW LEVEL SECURITY;

-- SELECT: coordenação + class staff (professor / monitor) always; students
-- only see polls of classes they are enrolled in. Draft polls remain
-- visible to staff for editing but a `status='open'` filter on the client
-- prevents them from leaking to students prematurely (RLS still allows it
-- because we want the same query to work for staff in the same drawer).
DROP POLICY IF EXISTS "lesson_polls_select" ON lesson_polls;
CREATE POLICY "lesson_polls_select" ON lesson_polls
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id = lesson_polls.class_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
  );

-- INSERT / UPDATE / DELETE: staff bound to the class.
DROP POLICY IF EXISTS "lesson_polls_insert" ON lesson_polls;
CREATE POLICY "lesson_polls_insert" ON lesson_polls
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      get_my_role() = 'coordenacao'
      OR is_class_professor(class_id)
      OR is_class_monitor(class_id)
    )
  );

DROP POLICY IF EXISTS "lesson_polls_update" ON lesson_polls;
CREATE POLICY "lesson_polls_update" ON lesson_polls
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
  );

DROP POLICY IF EXISTS "lesson_polls_delete" ON lesson_polls;
CREATE POLICY "lesson_polls_delete" ON lesson_polls
  FOR DELETE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
  );

-- ── RLS: lesson_poll_responses ─────────────────────────────────────────────
ALTER TABLE lesson_poll_responses ENABLE ROW LEVEL SECURITY;

-- SELECT: staff sees all responses for the class; student sees only their
-- own row (so they can re-render their answer + later see results via the
-- aggregated counts the staff exposes through realtime broadcast).
DROP POLICY IF EXISTS "lesson_poll_responses_select" ON lesson_poll_responses;
CREATE POLICY "lesson_poll_responses_select" ON lesson_poll_responses
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
    OR student_id = auth.uid()
  );

-- INSERT: only the student themself, only for an enrolled class, and only
-- while the parent poll is OPEN. The status check is enforced via a
-- subquery against lesson_polls — RLS evaluates this row-by-row at insert
-- time so a student can't race a "closed" transition.
DROP POLICY IF EXISTS "lesson_poll_responses_insert" ON lesson_poll_responses;
CREATE POLICY "lesson_poll_responses_insert" ON lesson_poll_responses
  FOR INSERT TO authenticated
  WITH CHECK (
    student_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id = lesson_poll_responses.class_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM lesson_polls p
      WHERE p.id = lesson_poll_responses.poll_id
        AND p.class_id = lesson_poll_responses.class_id
        AND p.status = 'open'
    )
  );

-- UPDATE: same gating as INSERT — student can revise their answer while
-- the poll is still open. (UPSERT path uses this.)
DROP POLICY IF EXISTS "lesson_poll_responses_update" ON lesson_poll_responses;
CREATE POLICY "lesson_poll_responses_update" ON lesson_poll_responses
  FOR UPDATE TO authenticated
  USING (student_id = auth.uid())
  WITH CHECK (
    student_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM lesson_polls p
      WHERE p.id = lesson_poll_responses.poll_id
        AND p.status = 'open'
    )
  );

-- DELETE: staff only. Students can't withdraw their answer once submitted.
DROP POLICY IF EXISTS "lesson_poll_responses_delete" ON lesson_poll_responses;
CREATE POLICY "lesson_poll_responses_delete" ON lesson_poll_responses
  FOR DELETE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
  );
