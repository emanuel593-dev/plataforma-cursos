-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 036_hardening_polls_evaluations                                          ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Security + integrity hardening for lesson_polls and lesson_evaluations. ║
-- ║                                                                          ║
-- ║ Fixes applied:                                                           ║
-- ║ 1. Composite UNIQUE(id, class_id) on scheduled_lessons so downstream   ║
-- ║    tables can use a compound FK to enforce class_id consistency —       ║
-- ║    blocks cross-class spoofing via direct API calls.                    ║
-- ║ 2. Composite FKs on lesson_evaluations and lesson_polls that reference  ║
-- ║    scheduled_lessons(id, class_id), guaranteeing the denormalized       ║
-- ║    class_id always matches the lesson's real class.                     ║
-- ║ 3. Composite UNIQUE(id, class_id) on lesson_polls + composite FK on     ║
-- ║    lesson_poll_responses(poll_id, class_id) for the same guarantee.    ║
-- ║ 4. Partial UNIQUE INDEX on lesson_polls(scheduled_lesson_id) WHERE      ║
-- ║    status='open' — enforces "one open poll at a time" server-side,      ║
-- ║    closing the race condition that was only guarded client-side.        ║
-- ║ 5. Fix lesson_polls SELECT policy: students can no longer read DRAFT     ║
-- ║    polls via direct API (only open/closed are visible to students).     ║
-- ║ 6. Register lesson_polls, lesson_poll_responses and lesson_evaluations  ║
-- ║    in the supabase_realtime publication so Realtime postgres_changes    ║
-- ║    subscriptions receive events reliably without manual dashboard step. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1) Anchor: composite unique on scheduled_lessons(id, class_id) ──────────
-- Required so lesson_evaluations and lesson_polls can reference BOTH columns
-- as a compound FK target (Postgres requires the referenced columns to form a
-- unique constraint or primary key).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduled_lessons_id_class_key'
      AND conrelid = 'scheduled_lessons'::regclass
  ) THEN
    ALTER TABLE scheduled_lessons
      ADD CONSTRAINT scheduled_lessons_id_class_key UNIQUE (id, class_id);
  END IF;
END $$;

-- ── 2) Composite FK: lesson_evaluations(scheduled_lesson_id, class_id) ──────
-- Guarantees that the denormalized class_id in every evaluation row matches
-- the class_id of the referenced scheduled_lesson. Prevents a monitor of
-- class A from inserting an evaluation row with class_id=A but pointing at a
-- lesson that belongs to class B.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lesson_evaluations_class_lesson_fk'
      AND conrelid = 'lesson_evaluations'::regclass
  ) THEN
    ALTER TABLE lesson_evaluations
      ADD CONSTRAINT lesson_evaluations_class_lesson_fk
      FOREIGN KEY (scheduled_lesson_id, class_id)
      REFERENCES scheduled_lessons(id, class_id);
  END IF;
END $$;

-- ── 3) Composite FK: lesson_polls(scheduled_lesson_id, class_id) ────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lesson_polls_class_lesson_fk'
      AND conrelid = 'lesson_polls'::regclass
  ) THEN
    ALTER TABLE lesson_polls
      ADD CONSTRAINT lesson_polls_class_lesson_fk
      FOREIGN KEY (scheduled_lesson_id, class_id)
      REFERENCES scheduled_lessons(id, class_id);
  END IF;
END $$;

-- ── 4) Anchor: composite unique on lesson_polls(id, class_id) ───────────────
-- Lets lesson_poll_responses reference BOTH columns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lesson_polls_id_class_key'
      AND conrelid = 'lesson_polls'::regclass
  ) THEN
    ALTER TABLE lesson_polls
      ADD CONSTRAINT lesson_polls_id_class_key UNIQUE (id, class_id);
  END IF;
END $$;

-- ── 5) Composite FK: lesson_poll_responses(poll_id, class_id) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lesson_poll_responses_class_poll_fk'
      AND conrelid = 'lesson_poll_responses'::regclass
  ) THEN
    ALTER TABLE lesson_poll_responses
      ADD CONSTRAINT lesson_poll_responses_class_poll_fk
      FOREIGN KEY (poll_id, class_id)
      REFERENCES lesson_polls(id, class_id);
  END IF;
END $$;

-- ── 6) Server-side "one open poll per lesson" enforcement ────────────────────
-- A partial unique index on scheduled_lesson_id WHERE status='open' means the
-- DB itself rejects a second openPoll() call even in a race between two
-- concurrent staff members / devices. The existing client-side guard via
-- hasOpenPoll() remains and still provides fast UX feedback.
DROP INDEX IF EXISTS lesson_polls_one_open_per_lesson;
CREATE UNIQUE INDEX lesson_polls_one_open_per_lesson
  ON lesson_polls(scheduled_lesson_id)
  WHERE (status = 'open');

-- ── 7) Fix SELECT policy: hide draft polls from students ─────────────────────
-- The previous policy allowed an enrolled student to read ALL polls (including
-- drafts) for their class via a direct Supabase API call. Only staff should
-- see drafts. Students may only see polls that are open or closed.
DROP POLICY IF EXISTS "lesson_polls_select" ON lesson_polls;
CREATE POLICY "lesson_polls_select" ON lesson_polls
  FOR SELECT TO authenticated
  USING (
    -- Staff: see everything including drafts
    get_my_role() = 'coordenacao'
    OR is_class_professor(class_id)
    OR is_class_monitor(class_id)
    -- Students: only non-draft polls for enrolled classes
    OR (
      status <> 'draft'
      AND EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.class_id = lesson_polls.class_id
          AND e.student_id = auth.uid()
          AND e.status = 'active'
      )
    )
  );

-- ── 8) Realtime publications ─────────────────────────────────────────────────
-- lesson_polls, lesson_poll_responses and lesson_evaluations were missing from
-- the supabase_realtime publication. Without this, postgres_changes
-- subscriptions in the client receive no events at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE lesson_polls;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE lesson_poll_responses;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE lesson_evaluations;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
