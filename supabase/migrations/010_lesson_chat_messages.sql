-- ── lesson_chat_messages ─────────────────────────────────────────────────────
-- Persists classroom chat so participants joining late can see history,
-- and so the chat survives reload / reconnect.

CREATE TABLE lesson_chat_messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id  uuid        REFERENCES scheduled_lessons(id) ON DELETE CASCADE,
  room_id              text        NOT NULL,
  user_id              uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_name            text        NOT NULL,
  text                 text        NOT NULL CHECK (length(text) > 0 AND length(text) <= 2000),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lesson_chat_room        ON lesson_chat_messages(room_id, created_at);
CREATE INDEX idx_lesson_chat_lesson      ON lesson_chat_messages(scheduled_lesson_id, created_at);

ALTER TABLE lesson_chat_messages ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated who can see the lesson can read its chat.
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
            c.professor_id = auth.uid()
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

-- Only the message author can insert their own messages.
CREATE POLICY "lesson_chat_messages_insert" ON lesson_chat_messages
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Author or coordination can delete (moderation).
CREATE POLICY "lesson_chat_messages_delete" ON lesson_chat_messages
  FOR DELETE
  USING (user_id = auth.uid() OR get_my_role() = 'coordenacao');
