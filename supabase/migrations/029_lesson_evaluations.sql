-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 029_lesson_evaluations                                                   ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Phase 3 of the monitor rollout: confidential post-lesson evaluations.    ║
-- ║                                                                          ║
-- ║ A monitor (or any class monitor of the lesson's class) fills a short    ║
-- ║ rubric after the class. The evaluation is CONFIDENTIAL — only the       ║
-- ║ coordenação and the monitor who wrote it can read the row. The          ║
-- ║ evaluated professor must NEVER see it: the role of this feature is to   ║
-- ║ feed coordenação's quality oversight, not give peer feedback.           ║
-- ║                                                                          ║
-- ║ Modeling notes                                                           ║
-- ║   • UNIQUE(scheduled_lesson_id, monitor_id) → one evaluation per monitor║
-- ║     per lesson, editable via UPSERT.                                     ║
-- ║   • class_id is denormalized so the RLS USING() clause does not need a   ║
-- ║     join with scheduled_lessons every time.                              ║
-- ║   • Score columns use SMALLINT 1..5 with CHECK; duration is an enum-ish ║
-- ║     text constrained to three buckets so the UI stays simple.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS lesson_evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id uuid NOT NULL REFERENCES scheduled_lessons(id) ON DELETE CASCADE,
  class_id            uuid NOT NULL REFERENCES classes(id)            ON DELETE CASCADE,
  monitor_id          uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  content_score       smallint NOT NULL CHECK (content_score      BETWEEN 1 AND 5),
  duration_assessment text     NOT NULL CHECK (duration_assessment IN ('curta','adequada','longa')),
  dynamics_score      smallint NOT NULL CHECK (dynamics_score     BETWEEN 1 AND 5),
  engagement_score    smallint NOT NULL CHECK (engagement_score   BETWEEN 1 AND 5),
  notes               text     CHECK (char_length(coalesce(notes,       '')) <= 4000),
  suggestions         text     CHECK (char_length(coalesce(suggestions, '')) <= 2000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scheduled_lesson_id, monitor_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_evaluations_class
  ON lesson_evaluations(class_id);
CREATE INDEX IF NOT EXISTS idx_lesson_evaluations_lesson
  ON lesson_evaluations(scheduled_lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_evaluations_monitor
  ON lesson_evaluations(monitor_id);

-- Refresh updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION lesson_evaluations_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lesson_evaluations_set_updated_at ON lesson_evaluations;
CREATE TRIGGER lesson_evaluations_set_updated_at
  BEFORE UPDATE ON lesson_evaluations
  FOR EACH ROW EXECUTE FUNCTION lesson_evaluations_touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE lesson_evaluations ENABLE ROW LEVEL SECURITY;

-- SELECT: coordenação reads everything; the monitor reads ONLY rows they
-- authored. Professors and students get NOTHING — no policy match.
DROP POLICY IF EXISTS "lesson_evaluations_select" ON lesson_evaluations;
CREATE POLICY "lesson_evaluations_select" ON lesson_evaluations
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR monitor_id = auth.uid()
  );

-- INSERT: only the monitor themselves, and only if they are still a class
-- monitor of the evaluated class. The denormalized class_id is checked via
-- is_class_monitor() so removing a monitor from a class also revokes their
-- ability to drop new evaluations on it.
DROP POLICY IF EXISTS "lesson_evaluations_insert" ON lesson_evaluations;
CREATE POLICY "lesson_evaluations_insert" ON lesson_evaluations
  FOR INSERT TO authenticated
  WITH CHECK (
    monitor_id = auth.uid()
    AND is_class_monitor(class_id)
  );

-- UPDATE: same gating as INSERT (and obviously can't reassign the row to
-- someone else — the WITH CHECK reapplies the auth.uid() match).
DROP POLICY IF EXISTS "lesson_evaluations_update" ON lesson_evaluations;
CREATE POLICY "lesson_evaluations_update" ON lesson_evaluations
  FOR UPDATE TO authenticated
  USING (monitor_id = auth.uid())
  WITH CHECK (
    monitor_id = auth.uid()
    AND is_class_monitor(class_id)
  );

-- DELETE: coordenação only. Monitors can't erase their own evaluation
-- after submission (they CAN edit it via UPSERT to revise the content).
DROP POLICY IF EXISTS "lesson_evaluations_delete" ON lesson_evaluations;
CREATE POLICY "lesson_evaluations_delete" ON lesson_evaluations
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');
