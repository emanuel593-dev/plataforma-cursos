-- ============================================================================
-- 041 — Fix attendance_recompute_one: manual status changes are persisted
-- ============================================================================
--
-- Bug: migration 038 (H-4 fix part 2) introduced a guard that, on UPDATE,
-- restores OLD.status / OLD.notes whenever NEW.manually_overridden = true.
--
-- The intent was to prevent automated ClassroomView flushes
-- (attendance_increment_duration RPC) from overwriting a human decision.
-- However, the condition fires for ALL UPDATEs where manually_overridden
-- is in the SET clause — including the manual click itself that changes
-- P → F (or any other cycle transition).
--
-- Result: a monitor/coordinator clicks a cell to change the status, the
-- optimistic UI update is correct, but the DB trigger silently reverts
-- the status to OLD.status. After page reload the old value comes back.
--
-- The protection against automated overwrites is already handled inside
-- attendance_increment_duration (migration 038/032/015):
--   status = CASE WHEN p_status IS NOT NULL THEN p_status ELSE attendance.status END
-- Intermediate ClassroomView flushes always pass p_status = NULL, so they
-- never overwrite the status regardless of manually_overridden. The trigger
-- guard is therefore redundant AND harmful.
--
-- Fix: restore the simpler logic from migrations 031/034 — when
-- manually_overridden = true, trust NEW as-is and return immediately.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.attendance_recompute_one()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_started      timestamptz;
  v_ended        timestamptz;
  v_duration_min int;
  v_eff          int;
  v_status       attendance_status;
  v_notes        text;
  v_modality     class_modality;
BEGIN
  -- Manual override: a human explicitly set this status — preserve it as-is.
  -- Do NOT restore OLD values; that breaks manual P→F / F→P / etc. edits.
  IF NEW.manually_overridden THEN
    RETURN NEW;
  END IF;

  -- FJ is always a human decision; never auto-degrade it.
  IF NEW.status = 'justified' THEN
    RETURN NEW;
  END IF;

  -- Presencial classes are always managed manually by the monitor.
  v_modality := public.effective_lesson_modality(NEW.scheduled_lesson_id);
  IF v_modality = 'presencial' THEN
    RETURN NEW;
  END IF;

  SELECT started_at, ended_at, duration_minutes
    INTO v_started, v_ended, v_duration_min
    FROM scheduled_lessons
   WHERE id = NEW.scheduled_lesson_id;

  -- Lesson never formally started — don't auto-decide.
  IF v_started IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_ended IS NOT NULL THEN
    v_eff := EXTRACT(EPOCH FROM (v_ended - v_started))::int;
  ELSE
    v_eff := COALESCE(v_duration_min, 0) * 60;
  END IF;

  SELECT cas.out_status, cas.out_notes
    INTO v_status, v_notes
    FROM public.compute_attendance_status(
      COALESCE(NEW.duration_seconds, 0),
      COALESCE(NEW.verified_checks, 0),
      COALESCE(NEW.total_checks, 0),
      v_eff
    ) AS cas;

  NEW.status := v_status;
  NEW.notes  := v_notes;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.attendance_recompute_one IS
  'BEFORE INSERT/UPDATE em attendance: reavalia status/notes com base na duracao '
  'efetiva da aula. Respeita manually_overridden=true (retorna NEW sem alteracao), '
  'status=justified e modalidade presencial. '
  'Fix 041: removida a restauracao de OLD.status que bloqueava edicoes manuais.';
