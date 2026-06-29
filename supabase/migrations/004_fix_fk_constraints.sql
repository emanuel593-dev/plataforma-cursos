-- ============================================================================
-- IV Platform — Fix FK constraints with proper ON DELETE actions
-- ============================================================================

-- ── classes.professor_id → SET NULL on professor delete ──────────────────────
-- PostgreSQL auto-named this constraint as classes_professor_id_fkey
ALTER TABLE classes
  DROP CONSTRAINT IF EXISTS classes_professor_id_fkey,
  ADD CONSTRAINT classes_professor_id_fkey
    FOREIGN KEY (professor_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- ── classes.module_id → RESTRICT (block deletion if classes exist) ────────────
-- Keep explicit RESTRICT to make intent clear; was implicit NO ACTION
ALTER TABLE classes
  DROP CONSTRAINT IF EXISTS classes_module_id_fkey,
  ADD CONSTRAINT classes_module_id_fkey
    FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE RESTRICT;

-- ── scheduled_lessons.lesson_id → SET NULL on lesson template delete ─────────
ALTER TABLE scheduled_lessons
  DROP CONSTRAINT IF EXISTS scheduled_lessons_lesson_id_fkey,
  ADD CONSTRAINT scheduled_lessons_lesson_id_fkey
    FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL;

-- ── enrollments.student_id → CASCADE on student delete ───────────────────────
ALTER TABLE enrollments
  DROP CONSTRAINT IF EXISTS enrollments_student_id_fkey,
  ADD CONSTRAINT enrollments_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── attendance.student_id → CASCADE on student delete ────────────────────────
ALTER TABLE attendance
  DROP CONSTRAINT IF EXISTS attendance_student_id_fkey,
  ADD CONSTRAINT attendance_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── attendance.marked_by → SET NULL on professor delete ──────────────────────
ALTER TABLE attendance
  DROP CONSTRAINT IF EXISTS attendance_marked_by_fkey,
  ADD CONSTRAINT attendance_marked_by_fkey
    FOREIGN KEY (marked_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- ── Index on scheduled_lessons.room_id for O(1) room lookups ─────────────────
CREATE INDEX IF NOT EXISTS idx_scheduled_lessons_room ON scheduled_lessons(room_id)
  WHERE room_id IS NOT NULL;
