-- ============================================================================
-- 048 — Fix attendance checks accumulation without cap (BUG #1)
-- ============================================================================
--
-- PROBLEM
-- -------
-- The `attendance_increment_duration` function accumulates `total_checks` and
-- `verified_checks` additively and without any upper bound. When a student
-- disconnects and reconnects multiple times during a lesson, each reconnection
-- triggers a new flush that keeps adding to both counters. This results in
-- absurd values such as 14/14 verified/total checks when the real maximum
-- should be 3 (the frontend constant MAX_CHECKS).
--
-- ROOT CAUSE (migration 038, ON CONFLICT DO UPDATE):
--   verified_checks = attendance.verified_checks + p_verified_checks_delta,
--   total_checks    = attendance.total_checks    + p_total_checks_delta,
--   ← No cap applied. Unlimited accumulation on reconnections.
--
-- FIX
-- ---
-- 1. Add a new parameter `p_max_checks int DEFAULT 3` to the function.
--    Default=3 matches the frontend MAX_CHECKS constant so that all existing
--    call sites automatically benefit from the cap without code changes.
--
-- 2. In the ON CONFLICT DO UPDATE, apply LEAST() to both counters:
--      total_checks    = LEAST(attendance.total_checks    + p_total_checks_delta,    p_max_checks)
--      verified_checks = LEAST(attendance.verified_checks + p_verified_checks_delta,
--                              LEAST(attendance.total_checks + p_total_checks_delta, p_max_checks))
--    The inner LEAST for verified_checks ensures it never exceeds the (already
--    capped) total_checks value — a verified check cannot exist without a
--    corresponding total check.
--
-- BACKWARD COMPATIBILITY
-- ----------------------
-- Because `p_max_checks` has a DEFAULT value, every existing call site that
-- omits the parameter continues to work exactly as before, now also capped at 3.
--
-- NOTE: The function signature changes (new parameter added), so we must DROP
-- the old overload before recreating it.
-- ============================================================================


-- Drop the old signature (11 parameters) to allow the new 12-parameter version.
DROP FUNCTION IF EXISTS public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid
);

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
  p_max_checks             int               DEFAULT 3        -- BUG #1 fix: cap for checks counters
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
    status,             -- NULL when p_status not provided (column allows NULL on insert)
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
    p_status,           -- keep NULL; recompute trigger will set 'present' if needed
    p_joined_at,
    p_left_at,
    p_delta_seconds,
    p_marked_by,
    p_notes,
    -- On INSERT (first flush), also respect the cap for the initial values.
    LEAST(p_verified_checks_delta, p_max_checks),
    LEAST(p_total_checks_delta,    p_max_checks),
    p_request_id
  )
  ON CONFLICT (scheduled_lesson_id, student_id) DO UPDATE SET
    duration_seconds      = COALESCE(attendance.duration_seconds, 0) + p_delta_seconds,

    -- BUG #1 FIX: cap total_checks at p_max_checks to prevent unlimited accumulation
    -- on repeated reconnections (e.g. 14/14 instead of correct 3/3).
    total_checks          = LEAST(
                              attendance.total_checks + p_total_checks_delta,
                              p_max_checks
                            ),

    -- verified_checks must never exceed the (already-capped) total_checks.
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
    -- Only overwrite status/notes when the caller explicitly provides them.
    -- Use p_status directly (not EXCLUDED.status) because EXCLUDED.status is
    -- already the raw INSERT value — in this path it's the existing row's
    -- CONFLICT side, not the parameter.
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
  'BUG #1 fix (048): total_checks and verified_checks are capped at p_max_checks (default 3) '
  'to prevent unlimited accumulation from multiple reconnections.';

GRANT EXECUTE ON FUNCTION public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid, int
) TO authenticated;
