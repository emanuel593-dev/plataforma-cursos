-- ============================================================================
-- 011 — Multi-professor per class, per-lesson assignment, swap requests,
--       Web Push subscriptions, and RLS rewrite.
-- ============================================================================
-- Decisions accepted by product owner:
--   1. No "titular" concept — pure N:N (class_professors)
--   2. Coordination edits the schedule; professors can request a swap
--      (peer ↔ peer) which the counterparty must accept
--   3. Coordination can perform emergency substitution at any time
--   4. History/audit of swaps & substitutions exposed in Reports tab
--   5. (Conflict detection deferred — not enforced here)
--   6. Realtime publications + Web Push (VAPID) plumbing
--   7. Drop legacy `classes.professor_id` column
-- ============================================================================

-- ── 1) Junction: class_professors ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS class_professors (
  class_id     uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  professor_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (class_id, professor_id)
);

CREATE INDEX IF NOT EXISTS idx_class_professors_class       ON class_professors(class_id);
CREATE INDEX IF NOT EXISTS idx_class_professors_professor   ON class_professors(professor_id);

-- Backfill from current single-professor model
INSERT INTO class_professors (class_id, professor_id)
SELECT id, professor_id FROM classes WHERE professor_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 2) Per-lesson assignment ────────────────────────────────────────────────

ALTER TABLE scheduled_lessons
  ADD COLUMN IF NOT EXISTS professor_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_lessons_professor
  ON scheduled_lessons(professor_id);

-- Backfill: each existing scheduled lesson inherits the class's previous titular
UPDATE scheduled_lessons sl
SET professor_id = c.professor_id
FROM classes c
WHERE sl.class_id = c.id
  AND c.professor_id IS NOT NULL
  AND sl.professor_id IS NULL;

-- ── 3) Lesson swap requests (professor ↔ professor) ────────────────────────

CREATE TYPE swap_request_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled', 'expired');

CREATE TABLE IF NOT EXISTS lesson_swap_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id uuid NOT NULL REFERENCES scheduled_lessons(id) ON DELETE CASCADE,
  -- Requester is currently assigned to the lesson and wants to swap it OUT.
  requester_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Target is the colleague being asked to take the lesson.
  target_id           uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Optional: if requester also offers to take one of target's lessons in return.
  offered_lesson_id   uuid REFERENCES scheduled_lessons(id) ON DELETE SET NULL,
  message             text,
  status              swap_request_status NOT NULL DEFAULT 'pending',
  responded_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swap_requests_target    ON lesson_swap_requests(target_id, status);
CREATE INDEX IF NOT EXISTS idx_swap_requests_requester ON lesson_swap_requests(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_swap_requests_lesson    ON lesson_swap_requests(scheduled_lesson_id);

-- ── 4) Substitution / assignment history (audit-friendly) ──────────────────

CREATE TABLE IF NOT EXISTS lesson_assignment_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id uuid NOT NULL REFERENCES scheduled_lessons(id) ON DELETE CASCADE,
  previous_professor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  new_professor_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  changed_by          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reason              text,
  -- 'substitution' (coord force-replace), 'swap' (peer swap), 'assignment' (initial)
  kind                text NOT NULL DEFAULT 'substitution',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lesson_assignment_history_lesson
  ON lesson_assignment_history(scheduled_lesson_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lesson_assignment_history_new_prof
  ON lesson_assignment_history(new_professor_id);
CREATE INDEX IF NOT EXISTS idx_lesson_assignment_history_prev_prof
  ON lesson_assignment_history(previous_professor_id);

-- Auto-record professor changes on scheduled_lessons
CREATE OR REPLACE FUNCTION record_lesson_assignment_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.professor_id IS NOT NULL) THEN
    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES (NEW.id, NULL, NEW.professor_id, auth.uid(), 'assignment');
  ELSIF (TG_OP = 'UPDATE' AND COALESCE(OLD.professor_id::text,'') <> COALESCE(NEW.professor_id::text,'')) THEN
    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES (NEW.id, OLD.professor_id, NEW.professor_id, auth.uid(), 'substitution');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS scheduled_lessons_assignment_history ON scheduled_lessons;
CREATE TRIGGER scheduled_lessons_assignment_history
  AFTER INSERT OR UPDATE OF professor_id ON scheduled_lessons
  FOR EACH ROW EXECUTE FUNCTION record_lesson_assignment_change();

-- ── 5) Web Push subscriptions ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ── 6) Helper: is_class_professor(class_id) ────────────────────────────────

CREATE OR REPLACE FUNCTION is_class_professor(p_class_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM class_professors
    WHERE class_id = p_class_id AND professor_id = auth.uid()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ── 7) Drop legacy RLS policies that reference classes.professor_id ────────

DROP POLICY IF EXISTS "enrollments_select"        ON enrollments;
DROP POLICY IF EXISTS "scheduled_lessons_select"  ON scheduled_lessons;
DROP POLICY IF EXISTS "scheduled_lessons_insert"  ON scheduled_lessons;
DROP POLICY IF EXISTS "scheduled_lessons_update"  ON scheduled_lessons;
DROP POLICY IF EXISTS "attendance_select"         ON attendance;
DROP POLICY IF EXISTS "attendance_insert"         ON attendance;
DROP POLICY IF EXISTS "attendance_update"         ON attendance;

-- ── 8) Recreate RLS using junction (+ per-lesson professor where relevant) ─

CREATE POLICY "enrollments_select" ON enrollments
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR is_class_professor(enrollments.class_id)
  );

CREATE POLICY "scheduled_lessons_select" ON scheduled_lessons
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(scheduled_lessons.class_id)
    OR scheduled_lessons.professor_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id = scheduled_lessons.class_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
  );

CREATE POLICY "scheduled_lessons_insert" ON scheduled_lessons
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR is_class_professor(scheduled_lessons.class_id)
  );

CREATE POLICY "scheduled_lessons_update" ON scheduled_lessons
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(scheduled_lessons.class_id)
    OR scheduled_lessons.professor_id = auth.uid()
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR is_class_professor(scheduled_lessons.class_id)
    OR scheduled_lessons.professor_id = auth.uid()
  );

CREATE POLICY "attendance_select" ON attendance
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (is_class_professor(sl.class_id) OR sl.professor_id = auth.uid())
    )
  );

CREATE POLICY "attendance_insert" ON attendance
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (is_class_professor(sl.class_id) OR sl.professor_id = auth.uid())
    )
  );

CREATE POLICY "attendance_update" ON attendance
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (is_class_professor(sl.class_id) OR sl.professor_id = auth.uid())
    )
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (is_class_professor(sl.class_id) OR sl.professor_id = auth.uid())
    )
  );

-- ── 9) RLS for new tables ──────────────────────────────────────────────────

ALTER TABLE class_professors           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_swap_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_assignment_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions         ENABLE ROW LEVEL SECURITY;

-- class_professors: everyone authenticated reads (used by all other queries);
-- only coordination writes.
CREATE POLICY "class_professors_select" ON class_professors
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "class_professors_insert" ON class_professors
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "class_professors_delete" ON class_professors
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- swap requests: requester or target can see their own; coord sees all.
CREATE POLICY "lesson_swap_requests_select" ON lesson_swap_requests
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR requester_id = auth.uid()
    OR target_id = auth.uid()
  );

-- requester (currently-assigned professor) creates the request
CREATE POLICY "lesson_swap_requests_insert" ON lesson_swap_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    requester_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = scheduled_lesson_id
        AND sl.professor_id = auth.uid()
    )
  );

-- requester can cancel; target can accept/reject; coord can do anything
CREATE POLICY "lesson_swap_requests_update" ON lesson_swap_requests
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR requester_id = auth.uid()
    OR target_id = auth.uid()
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR requester_id = auth.uid()
    OR target_id = auth.uid()
  );

-- assignment history: coord sees all; professors see entries that touch them
CREATE POLICY "lesson_assignment_history_select" ON lesson_assignment_history
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR previous_professor_id = auth.uid()
    OR new_professor_id = auth.uid()
    OR changed_by = auth.uid()
  );

-- history is written exclusively by the trigger (SECURITY DEFINER), but allow
-- explicit inserts from accepted swap flow as a fallback.
CREATE POLICY "lesson_assignment_history_insert" ON lesson_assignment_history
  FOR INSERT TO authenticated
  WITH CHECK (changed_by = auth.uid() OR get_my_role() = 'coordenacao');

-- push subscriptions: each user manages their own
CREATE POLICY "push_subscriptions_select" ON push_subscriptions
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR get_my_role() = 'coordenacao');

CREATE POLICY "push_subscriptions_insert" ON push_subscriptions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "push_subscriptions_update" ON push_subscriptions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "push_subscriptions_delete" ON push_subscriptions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ── 10) Drop legacy classes.professor_id column ────────────────────────────
-- All policies above are fully migrated to the junction; the column is no
-- longer used by any RLS policy or backend service.

ALTER TABLE classes DROP COLUMN IF EXISTS professor_id;
DROP INDEX IF EXISTS idx_classes_professor;

-- ── 11) Realtime publication ───────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE class_professors; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE lesson_swap_requests; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE lesson_assignment_history; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
