-- ============================================================================
-- 042 — Phase 2: Data integrity (makeup reconciliation, cron audit,
--                lesson_evaluations consistency, schema_migrations backfill)
-- ============================================================================
--
-- Refs:
--   docs/AUDITORIA_COMPLETA_2026_05.md §M1, §A4, §L1, §L2
--
-- Sections:
--   1) L1  — Backfill schema_migrations for 040 and 041 (idempotent).
--   2) M1  — Reconcile attendance when a makeup_submission is approved.
--            Adds attendance.makeup_satisfied + trigger on makeup_submissions.
--   3) A4  — RPC auto_expire_makeup_deadline used by the daily cron so the
--            audit trail records actor_system='cron' instead of NULL.
--   4) L2  — Trigger on lesson_evaluations enforcing
--            class_id = scheduled_lessons.class_id.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1) L1 — Register migrations 040/041 if they were applied out-of-band.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.tables
    WHERE  table_schema = 'supabase_migrations'
    AND    table_name   = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version)
    VALUES ('040'), ('041')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) M1 — Makeup approval reconciles attendance
-- ──────────────────────────────────────────────────────────────────────────
--
-- Decision (Option A from the audit): keep `attendance.status = 'justified'`
-- so the original absence remains visible in history, but mark the obligation
-- as satisfied and clear the deadline so it no longer counts as "FJ pending".
--
-- A separate boolean column (rather than mutating the enum) preserves all
-- existing dashboards and lets reports distinguish "FJ open" vs "FJ closed
-- via approved makeup".
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS makeup_satisfied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN attendance.makeup_satisfied IS
  'True when a related makeup_submission was approved by staff. Closes the '
  'FJ obligation without changing the original status. Set by the '
  'makeup_submission_reconcile_attendance trigger.';

CREATE INDEX IF NOT EXISTS attendance_makeup_satisfied_idx
  ON attendance (makeup_satisfied)
  WHERE makeup_satisfied = true;

-- Backfill: any already-approved submission closes its matching FJ row.
UPDATE attendance a
SET    makeup_satisfied = true,
       makeup_deadline  = NULL
FROM   makeup_submissions ms
WHERE  ms.status              = 'approved'
AND    ms.scheduled_lesson_id = a.scheduled_lesson_id
AND    ms.student_id          = a.student_id
AND    a.status               = 'justified'
AND    a.makeup_satisfied     = false;

CREATE OR REPLACE FUNCTION public.makeup_submission_reconcile_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when the row transitions INTO 'approved'.
  IF NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.scheduled_lesson_id IS NOT NULL THEN

    UPDATE attendance
    SET    makeup_satisfied = true,
           -- Drop the deadline so the FJ no longer shows as pending.
           -- Keep status='justified' to preserve the historical record.
           makeup_deadline  = NULL
    WHERE  scheduled_lesson_id = NEW.scheduled_lesson_id
    AND    student_id          = NEW.student_id
    AND    status              = 'justified';

    INSERT INTO audit_logs (actor_id, action, entity, entity_id, details)
    VALUES (
      NEW.reviewed_by,
      'makeup.approved_reconciled',
      'makeup_submissions',
      NEW.id::text,
      jsonb_build_object(
        'scheduled_lesson_id', NEW.scheduled_lesson_id,
        'student_id',          NEW.student_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS makeup_submission_reconcile_trg ON makeup_submissions;
CREATE TRIGGER makeup_submission_reconcile_trg
  AFTER INSERT OR UPDATE OF status ON makeup_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.makeup_submission_reconcile_attendance();

-- ──────────────────────────────────────────────────────────────────────────
-- 3) A4 — RPC for the cron job to expire makeup deadlines with named actor.
-- ──────────────────────────────────────────────────────────────────────────
--
-- The previous implementation issued a PATCH via service_role REST, which
-- fired the attendance_log_auto_absent trigger with actor_id = NULL (no
-- Supabase session). This RPC writes the audit row explicitly with a
-- recognizable actor identifier, then performs the flip. The existing
-- auto-absent trigger still fires but is now redundant for cron flips —
-- we tag the cron row with `details->>'source' = 'cron'` so consumers can
-- distinguish or de-duplicate.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auto_expire_makeup_deadline(p_attendance_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row attendance%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM attendance WHERE id = p_attendance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance % not found', p_attendance_id;
  END IF;

  -- Idempotency: only flip rows still in the 'justified' state with a
  -- past deadline and no satisfied makeup.
  IF v_row.status <> 'justified'
     OR v_row.makeup_satisfied = true
     OR v_row.makeup_deadline IS NULL
     OR v_row.makeup_deadline >= now() THEN
    RETURN;
  END IF;

  -- Audit FIRST so the cron-tagged row exists even if the UPDATE fails.
  INSERT INTO audit_logs (actor_id, action, entity, entity_id, details)
  VALUES (
    NULL, -- system action; no Supabase user
    'attendance.auto_absent_cron',
    'attendance',
    v_row.id::text,
    jsonb_build_object(
      'source',              'cron',
      'function',            'expire-makeup-deadlines',
      'student_id',          v_row.student_id,
      'scheduled_lesson_id', v_row.scheduled_lesson_id,
      'previous_status',     v_row.status,
      'makeup_deadline',     v_row.makeup_deadline
    )
  );

  UPDATE attendance
  SET    status = 'absent'
       -- Keep makeup_deadline so the audit trail shows what was missed.
  WHERE  id = p_attendance_id;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_expire_makeup_deadline(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_expire_makeup_deadline(uuid) TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) L2 — lesson_evaluations.class_id consistency trigger
-- ──────────────────────────────────────────────────────────────────────────
--
-- A CHECK constraint with a subquery is not supported in Postgres, so we
-- enforce the invariant via BEFORE INSERT/UPDATE trigger.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lesson_evaluations_check_class_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class uuid;
BEGIN
  SELECT class_id INTO v_class
  FROM   scheduled_lessons
  WHERE  id = NEW.scheduled_lesson_id;

  IF v_class IS NULL THEN
    RAISE EXCEPTION 'scheduled_lesson % not found', NEW.scheduled_lesson_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_class IS DISTINCT FROM NEW.class_id THEN
    RAISE EXCEPTION
      'lesson_evaluations.class_id (%) does not match scheduled_lesson.class_id (%)',
      NEW.class_id, v_class
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lesson_evaluations_class_match_trg ON lesson_evaluations;
CREATE TRIGGER lesson_evaluations_class_match_trg
  BEFORE INSERT OR UPDATE OF class_id, scheduled_lesson_id ON lesson_evaluations
  FOR EACH ROW
  EXECUTE FUNCTION public.lesson_evaluations_check_class_match();
