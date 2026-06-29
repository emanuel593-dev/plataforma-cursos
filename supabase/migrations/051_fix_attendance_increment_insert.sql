-- ============================================================================
-- 049 — Fix attendance_increment_duration NOT NULL constraint
-- ============================================================================
--
-- PROBLEM
-- -------
-- Migration 048 changed the `INSERT` clause of `attendance_increment_duration`
-- to pass `p_status` (which is usually NULL) into the `status` column. 
-- However, the `status` column has a `NOT NULL` constraint (`is_nullable: 'NO'`).
-- In PostgreSQL, `INSERT ... ON CONFLICT DO UPDATE` checks constraints on the
-- proposed INSERT row BEFORE checking for conflicts. Because of the NULL value,
-- any call to this RPC where `p_status` is NULL throws:
-- "23502: null value in column status of relation attendance violates not-null constraint"
-- This entirely broke all automatic attendance tracking for students.
--
-- FIX
-- ---
-- Revert the INSERT `VALUES` for `status` to use a COALESCE fallback 
-- (`COALESCE(p_status, 'absent'::attendance_status)`). This satisfies the
-- NOT NULL constraint on INSERT without affecting the existing row on UPDATE.
-- The `BEFORE INSERT` trigger `attendance_recompute_trg` will immediately overwrite
-- this dummy 'absent' value with the properly computed status based on 
-- `duration_seconds` if the lesson has actually started.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.attendance_increment_duration(
  p_lesson_id              uuid,
  p_student_id             uuid,
  p_delta_seconds          int,
  p_verified_checks_delta  int               DEFAULT 0,
  p_total_checks_delta     int               DEFAULT 0,
  p_left_at                timestamptz       DEFAULT NULL,
  p_joined_at              timestamptz       DEFAULT NULL,
  p_status                 attendance_status DEFAULT NULL,
  p_notes                  text              DEFAULT NULL,
  p_marked_by              uuid              DEFAULT NULL,
  p_request_id             uuid              DEFAULT NULL,
  p_max_checks             int               DEFAULT 3
) RETURNS attendance
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row      attendance;
  v_existing attendance;
BEGIN
  IF p_delta_seconds < 0 OR p_verified_checks_delta < 0 OR p_total_checks_delta < 0 THEN
    RAISE EXCEPTION 'Deltas devem ser >= 0';
  END IF;

  -- Idempotency: if this request_id was already applied, return current row.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM attendance
     WHERE scheduled_lesson_id = p_lesson_id
       AND student_id           = p_student_id;

    IF FOUND AND v_existing.last_flush_request_id = p_request_id THEN
      RETURN v_existing;
    END IF;
  END IF;

  INSERT INTO attendance (
    scheduled_lesson_id,
    student_id,
    status,
    joined_at,
    left_at,
    duration_seconds,
    marked_by,
    notes,
    verified_checks,
    total_checks,
    last_flush_request_id
  ) VALUES (
    p_lesson_id,
    p_student_id,
    COALESCE(p_status, 'absent'::attendance_status), -- FIX: Provide a valid NOT NULL value to pass the constraint check
    p_joined_at,
    p_left_at,
    p_delta_seconds,
    p_marked_by,
    p_notes,
    LEAST(p_verified_checks_delta, p_max_checks),
    LEAST(p_total_checks_delta,    p_max_checks),
    p_request_id
  )
  ON CONFLICT (scheduled_lesson_id, student_id) DO UPDATE SET
    duration_seconds      = COALESCE(attendance.duration_seconds, 0) + p_delta_seconds,
    total_checks          = LEAST(
                              attendance.total_checks + p_total_checks_delta,
                              p_max_checks
                            ),
    verified_checks       = LEAST(
                              attendance.verified_checks + p_verified_checks_delta,
                              LEAST(
                                attendance.total_checks + p_total_checks_delta,
                                p_max_checks
                              )
                            ),
    left_at               = COALESCE(EXCLUDED.left_at,  attendance.left_at),
    joined_at             = LEAST(
                              COALESCE(attendance.joined_at, EXCLUDED.joined_at),
                              COALESCE(EXCLUDED.joined_at,   attendance.joined_at)
                            ),
    status    = CASE WHEN p_status IS NOT NULL THEN p_status    ELSE attendance.status END,
    notes     = CASE WHEN p_status IS NOT NULL THEN EXCLUDED.notes ELSE attendance.notes END,
    marked_by = COALESCE(EXCLUDED.marked_by, attendance.marked_by),
    last_flush_request_id = COALESCE(EXCLUDED.last_flush_request_id, attendance.last_flush_request_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid, int
) IS
  'Server-side additive flush for attendance counters. Idempotent when p_request_id provided. '
  'status/notes only updated when p_status is explicitly supplied — never coerced to ''present''. '
  'BUG fix (049): Restored COALESCE(p_status, ''absent'') on INSERT to prevent NOT NULL constraint violation.';

GRANT EXECUTE ON FUNCTION public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid, int
) TO authenticated;
