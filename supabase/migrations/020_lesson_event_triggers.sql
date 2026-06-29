-- Migration 020: Track meaningful lesson lifecycle events in lesson_assignment_history
--
-- Previously, the trigger only fired on professor_id changes (substitutions +
-- initial assignments). This migration adds:
--   1. 'cancellation'  — when a lesson's status changes TO 'cancelled'
--   2. 'reinstatement' — when a lesson is UNcancelled (status FROM 'cancelled')
--   3. 'reschedule'    — when a lesson's scheduled_at datetime is changed
--
-- All use the same lesson_assignment_history table with new `kind` values so
-- no schema change is needed. The reason column stores the old → new value for
-- full auditability.
--
-- Note: the initial 'assignment' events (kind='assignment') already exist in
-- the table and are now hidden from the UI (filtered in the service layer).

-- ── 1) Cancel / reinstatement tracker ─────────────────────────────────────

CREATE OR REPLACE FUNCTION record_lesson_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.status, '') <> COALESCE(NEW.status, '') THEN

    IF NEW.status = 'cancelled' THEN
      INSERT INTO lesson_assignment_history
        (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
      VALUES
        (NEW.id, NULL, NULL, auth.uid(), 'cancellation',
         'status: ' || COALESCE(OLD.status, '?') || ' → cancelled');

    ELSIF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      INSERT INTO lesson_assignment_history
        (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
      VALUES
        (NEW.id, NULL, NULL, auth.uid(), 'reinstatement',
         'status: cancelled → ' || NEW.status);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS scheduled_lessons_status_history ON scheduled_lessons;
CREATE TRIGGER scheduled_lessons_status_history
  AFTER UPDATE OF status ON scheduled_lessons
  FOR EACH ROW EXECUTE FUNCTION record_lesson_status_change();

-- ── 2) Reschedule tracker ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION record_lesson_reschedule()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.scheduled_at IS DISTINCT FROM NEW.scheduled_at THEN
    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
    VALUES
      (NEW.id, NULL, NULL, auth.uid(), 'reschedule',
       to_char(OLD.scheduled_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YY HH24:MI')
       || ' → '
       || to_char(NEW.scheduled_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YY HH24:MI'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS scheduled_lessons_reschedule_history ON scheduled_lessons;
CREATE TRIGGER scheduled_lessons_reschedule_history
  AFTER UPDATE OF scheduled_at ON scheduled_lessons
  FOR EACH ROW EXECUTE FUNCTION record_lesson_reschedule();
