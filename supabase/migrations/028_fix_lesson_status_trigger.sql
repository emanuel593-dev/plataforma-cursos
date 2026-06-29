-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 028_fix_lesson_status_trigger                                            ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Hot-fix for migration 020.                                               ║
-- ║                                                                          ║
-- ║ The original record_lesson_status_change() body used                     ║
-- ║   COALESCE(OLD.status, '') <> COALESCE(NEW.status, '')                   ║
-- ║ to compare two `lesson_status` enum values. Postgres tries to coerce     ║
-- ║ the empty-string literal to the enum, which fails with                   ║
-- ║   "invalid input value for enum lesson_status: """                       ║
-- ║ EVERY time `status` is updated — making it impossible to start, end,    ║
-- ║ cancel or reinstate a lesson via the UI.                                 ║
-- ║                                                                          ║
-- ║ The idiomatic null-safe comparison is `IS DISTINCT FROM`, which does    ║
-- ║ not require coercing NULL through any sentinel value. Logically          ║
-- ║ equivalent for the cases the trigger cares about (NULL → x, x → NULL,    ║
-- ║ x → y) and side-steps the enum coercion entirely.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION record_lesson_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status THEN

    IF NEW.status = 'cancelled' THEN
      INSERT INTO lesson_assignment_history
        (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
      VALUES
        (NEW.id, NULL, NULL, auth.uid(), 'cancellation',
         'status: ' || COALESCE(OLD.status::text, '?') || ' → cancelled');

    ELSIF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      INSERT INTO lesson_assignment_history
        (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
      VALUES
        (NEW.id, NULL, NULL, auth.uid(), 'reinstatement',
         'status: cancelled → ' || NEW.status::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
