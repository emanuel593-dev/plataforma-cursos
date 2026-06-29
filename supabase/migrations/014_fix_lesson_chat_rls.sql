-- ── Fix lesson_chat_messages SELECT policy ──────────────────────────────────
-- Migration 010 created the policy referencing `classes.professor_id`, but
-- migration 011 dropped that column in favour of the `class_professors`
-- junction. Without this fix, any SELECT on lesson_chat_messages by a
-- non-coordenacao user errors out (column does not exist), so the chat
-- history silently returns empty for professors and enrolled students.
--
-- Idempotent: drops + recreates the policy using the `is_class_professor`
-- helper introduced in migration 011. No data is touched.

DROP POLICY IF EXISTS "lesson_chat_messages_select" ON lesson_chat_messages;

CREATE POLICY "lesson_chat_messages_select" ON lesson_chat_messages
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND (
      get_my_role() = 'coordenacao'
      OR EXISTS (
        SELECT 1 FROM scheduled_lessons sl
        JOIN classes c ON c.id = sl.class_id
        WHERE sl.id = lesson_chat_messages.scheduled_lesson_id
          AND (
            -- Per-lesson assignee (multi-professor model)
            sl.professor_id = auth.uid()
            -- Any professor in the class junction
            OR is_class_professor(c.id)
            -- Active enrolled student
            OR EXISTS (
              SELECT 1 FROM enrollments e
              WHERE e.class_id = c.id
                AND e.student_id = auth.uid()
                AND e.status = 'active'
            )
          )
      )
    )
  );
