-- ============================================================================
-- 033 — Audit log when attendance is auto-flipped from present → absent
-- ============================================================================
--
-- Auditoria §4 Fase C #9: notificar o aluno quando o sistema marca
-- automaticamente como ausente (não atingiu 75%, não respondeu verificações,
-- ou aula nunca formalmente iniciada).
--
-- Estratégia:
--   * Trigger AFTER UPDATE em `attendance` quando `status` muda para 'absent'
--     E `manually_overridden = false` (auto) E o status anterior era 'present'.
--   * Insere um row em `audit_logs` com action='attendance.auto_absent'
--     contendo student_id + scheduled_lesson_id + nota.
--   * `push-events.ts` (cron) descobre essas linhas e despacha push.
--
-- Não usa NOTIFY/LISTEN porque Supabase Edge não os retransmite cross-region.

CREATE OR REPLACE FUNCTION public.attendance_log_auto_absent() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'absent'
     AND NEW.manually_overridden = false
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND OLD.status = 'present' THEN
    INSERT INTO audit_logs (actor_id, action, entity, entity_id, details)
    VALUES (
      NEW.marked_by,
      'attendance.auto_absent',
      'attendance',
      NEW.id::text,
      jsonb_build_object(
        'student_id', NEW.student_id,
        'scheduled_lesson_id', NEW.scheduled_lesson_id,
        'duration_seconds', NEW.duration_seconds,
        'verified_checks', NEW.verified_checks,
        'total_checks', NEW.total_checks,
        'notes', NEW.notes
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_log_auto_absent_trg ON attendance;
CREATE TRIGGER attendance_log_auto_absent_trg
  AFTER UPDATE OF status ON attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_log_auto_absent();
