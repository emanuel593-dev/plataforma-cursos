-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 026_monitor_role                                                         ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Phase 1 (Foundation) of the "Class Monitor" feature.                     ║
-- ║                                                                          ║
-- ║   1. Adds 'monitor' to the user_role enum.                               ║
-- ║   2. Creates the N:N junction `class_monitors` (mirrors                  ║
-- ║      `class_professors`).                                                ║
-- ║   3. Adds the SECURITY DEFINER helper `is_class_monitor(class_id)`.      ║
-- ║   4. Extends RLS policies on existing tables so a monitor can SELECT     ║
-- ║      and (where appropriate) INSERT/UPDATE/DELETE rows scoped to the    ║
-- ║      classes they are linked to.                                         ║
-- ║                                                                          ║
-- ║ Tables touched (RLS only, no schema change):                            ║
-- ║   - scheduled_lessons (select/update)                                    ║
-- ║   - attendance        (select/insert/update)                             ║
-- ║   - enrollments       (select)                                           ║
-- ║   - class_materials   (select)                                           ║
-- ║   - lesson_chat_messages (select/delete  ← chat moderation)              ║
-- ║   - assignments       (select)                                           ║
-- ║   - recordings        (select)                                           ║
-- ║   - makeup_submissions (select/update — review along coord/prof)         ║
-- ║                                                                          ║
-- ║ Tables intentionally NOT extended (out of scope for the monitor role):   ║
-- ║   - lesson_reports     (professor's internal report)                     ║
-- ║   - announcements      (monitor cannot create official announcements)    ║
-- ║   - lesson_swap_requests / lesson_assignment_history (peer-to-peer       ║
-- ║     workflow between professors).                                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1) Junction: class_monitors ────────────────────────────────────────────
-- (The 'monitor' enum value is added in migration 026 — see header note.)

CREATE TABLE IF NOT EXISTS class_monitors (
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (class_id, monitor_id)
);

CREATE INDEX IF NOT EXISTS idx_class_monitors_class   ON class_monitors(class_id);
CREATE INDEX IF NOT EXISTS idx_class_monitors_monitor ON class_monitors(monitor_id);

ALTER TABLE class_monitors ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated may read the junction (used by every other policy);
-- only coordenação inserts/deletes assignments.
DROP POLICY IF EXISTS "class_monitors_select" ON class_monitors;
CREATE POLICY "class_monitors_select" ON class_monitors
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "class_monitors_insert" ON class_monitors;
CREATE POLICY "class_monitors_insert" ON class_monitors
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'coordenacao');

DROP POLICY IF EXISTS "class_monitors_delete" ON class_monitors;
CREATE POLICY "class_monitors_delete" ON class_monitors
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- Realtime publication (mirrors class_professors).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE class_monitors;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ── 2) Helper: is_class_monitor(class_id) ──────────────────────────────────

CREATE OR REPLACE FUNCTION is_class_monitor(p_class_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM class_monitors
    WHERE class_id = p_class_id AND monitor_id = auth.uid()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ── 3) Extend existing RLS policies ────────────────────────────────────────

-- 3a) scheduled_lessons -----------------------------------------------------
DROP POLICY IF EXISTS "scheduled_lessons_select" ON scheduled_lessons;
CREATE POLICY "scheduled_lessons_select" ON scheduled_lessons
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(scheduled_lessons.class_id)
    OR is_class_monitor(scheduled_lessons.class_id)
    OR scheduled_lessons.professor_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id   = scheduled_lessons.class_id
        AND e.student_id = auth.uid()
        AND e.status     = 'active'
    )
  );

-- Monitors may NOT insert/update/cancel lessons.

-- 3b) attendance ------------------------------------------------------------
DROP POLICY IF EXISTS "attendance_select" ON attendance;
CREATE POLICY "attendance_select" ON attendance
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (
          is_class_professor(sl.class_id)
          OR is_class_monitor(sl.class_id)
          OR sl.professor_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "attendance_insert" ON attendance;
CREATE POLICY "attendance_insert" ON attendance
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (
          is_class_professor(sl.class_id)
          OR is_class_monitor(sl.class_id)
          OR sl.professor_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "attendance_update" ON attendance;
CREATE POLICY "attendance_update" ON attendance
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (
          is_class_professor(sl.class_id)
          OR is_class_monitor(sl.class_id)
          OR sl.professor_id = auth.uid()
        )
    )
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = attendance.scheduled_lesson_id
        AND (
          is_class_professor(sl.class_id)
          OR is_class_monitor(sl.class_id)
          OR sl.professor_id = auth.uid()
        )
    )
  );

-- 3c) enrollments -----------------------------------------------------------
-- Monitor needs to see the class roster (for attendance UI, evaluation
-- context). Insert/update/delete remain coordenação-only.
DROP POLICY IF EXISTS "enrollments_select" ON enrollments;
CREATE POLICY "enrollments_select" ON enrollments
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR is_class_professor(enrollments.class_id)
    OR is_class_monitor(enrollments.class_id)
  );

-- 3d) class_materials -------------------------------------------------------
-- The legacy policy (migration 007) still references the dropped column
-- `classes.professor_id`. Rewrite it to use the junction helpers and add
-- monitor visibility. Insert/update/delete remain unchanged.
DROP POLICY IF EXISTS class_materials_select ON class_materials;
CREATE POLICY class_materials_select ON class_materials
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_materials.class_id)
    OR is_class_monitor(class_materials.class_id)
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id   = class_materials.class_id
        AND e.student_id = auth.uid()
        AND e.status     = 'active'
    )
  );

-- 3e) lesson_chat_messages --------------------------------------------------
-- Replaces the policy from migration 014. Adds monitor as both reader and
-- moderator (delete) for messages from classes they monitor.
DROP POLICY IF EXISTS "lesson_chat_messages_select" ON lesson_chat_messages;
CREATE POLICY "lesson_chat_messages_select" ON lesson_chat_messages
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND (
      get_my_role() = 'coordenacao'
      OR EXISTS (
        SELECT 1 FROM scheduled_lessons sl
        WHERE sl.id = lesson_chat_messages.scheduled_lesson_id
          AND (
            sl.professor_id = auth.uid()
            OR is_class_professor(sl.class_id)
            OR is_class_monitor(sl.class_id)
            OR EXISTS (
              SELECT 1 FROM enrollments e
              WHERE e.class_id   = sl.class_id
                AND e.student_id = auth.uid()
                AND e.status     = 'active'
            )
          )
      )
    )
  );

DROP POLICY IF EXISTS "lesson_chat_messages_delete" ON lesson_chat_messages;
CREATE POLICY "lesson_chat_messages_delete" ON lesson_chat_messages
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR get_my_role() = 'coordenacao'
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = lesson_chat_messages.scheduled_lesson_id
        AND is_class_monitor(sl.class_id)
    )
  );

-- 3f) assignments -----------------------------------------------------------
-- Add a dedicated SELECT policy for monitors (existing prof/coord/student
-- policies stay untouched; they all OR together).
DROP POLICY IF EXISTS "assignments_monitor_read" ON assignments;
CREATE POLICY "assignments_monitor_read" ON assignments
  FOR SELECT
  USING (is_class_monitor(assignments.class_id));

-- 3g) recordings ------------------------------------------------------------
-- Recordings already grant SELECT to any prof/coord (broad). Add a
-- class-scoped SELECT for monitors so they can review the lesson video.
DROP POLICY IF EXISTS "recordings_monitor_select" ON recordings;
CREATE POLICY "recordings_monitor_select" ON recordings
  FOR SELECT
  USING (
    class_id IS NOT NULL
    AND is_class_monitor(class_id)
  );

-- 3h) makeup_submissions ----------------------------------------------------
-- Extend the staff SELECT/UPDATE policies (from migration 022) to include
-- the monitors of the same class. Staff column-restriction trigger from
-- migration 022 already permits coord/prof to write any column; treat
-- monitors the same way (they are staff for this lesson).
DROP POLICY IF EXISTS "makeup_staff_select" ON makeup_submissions;
CREATE POLICY "makeup_staff_select"
  ON makeup_submissions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'coordenacao'
    )
    OR EXISTS (
      SELECT 1 FROM class_professors cp
      WHERE cp.professor_id = auth.uid()
        AND cp.class_id     = makeup_submissions.class_id
    )
    OR is_class_monitor(makeup_submissions.class_id)
  );

DROP POLICY IF EXISTS "makeup_staff_update" ON makeup_submissions;
CREATE POLICY "makeup_staff_update"
  ON makeup_submissions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'coordenacao'
    )
    OR EXISTS (
      SELECT 1 FROM class_professors cp
      WHERE cp.professor_id = auth.uid()
        AND cp.class_id     = makeup_submissions.class_id
    )
    OR is_class_monitor(makeup_submissions.class_id)
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'coordenacao'
    )
    OR EXISTS (
      SELECT 1 FROM class_professors cp
      WHERE cp.professor_id = auth.uid()
        AND cp.class_id     = makeup_submissions.class_id
    )
    OR is_class_monitor(makeup_submissions.class_id)
  );

-- The column-enforcement trigger `enforce_makeup_submission_writes` (from
-- migration 022) currently bypasses coord/professor. Update it to also
-- bypass 'monitor' so a monitor can write reviewer fields just like staff.
CREATE OR REPLACE FUNCTION enforce_makeup_submission_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();

  IF v_role IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_role IN ('coordenacao', 'professor', 'monitor') THEN
    RETURN NEW;
  END IF;

  -- Student path (unchanged from migration 022).
  IF OLD.student_id          IS DISTINCT FROM NEW.student_id
     OR OLD.recording_id        IS DISTINCT FROM NEW.recording_id
     OR OLD.class_id            IS DISTINCT FROM NEW.class_id
     OR OLD.scheduled_lesson_id IS DISTINCT FROM NEW.scheduled_lesson_id
  THEN
    RAISE EXCEPTION 'Students cannot reassign a makeup submission.'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT (OLD.status IN ('pending', 'rejected') AND NEW.status = 'submitted') THEN
      RAISE EXCEPTION 'Students may only submit (or re-submit) a makeup; current status: %, new: %',
        OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.reviewer_notes IS NOT NULL
     OR NEW.reviewed_at  IS NOT NULL
     OR NEW.reviewed_by  IS NOT NULL
  THEN
    RAISE EXCEPTION 'Students cannot set reviewer fields.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
