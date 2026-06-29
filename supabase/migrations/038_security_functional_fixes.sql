-- ============================================================================
-- 038 — Security & functional fixes (audit findings H-1, H-3, H-4, M-4)
-- ============================================================================
--
-- H-4 (HIGH, exploitable): attendance_increment_duration ON CONFLICT bug
--   `COALESCE(p_status, 'present')` in VALUES converts NULL → 'present',
--   making EXCLUDED.status non-NULL on every flush. The subsequent
--   `COALESCE(EXCLUDED.status, attendance.status)` then unconditionally
--   overwrites the stored status. A student with status='justified' can call
--   this RPC (which they have RLS permission for) with a zero-delta flush and
--   silently flip their own attendance to 'present'.
--
--   Fix:
--     1. Keep NULL in VALUES when p_status IS NULL (remove the COALESCE).
--        The column has no NOT NULL constraint so NULL is fine on INSERT.
--     2. Fix the ON CONFLICT SET expression to use the p_status parameter
--        directly instead of EXCLUDED.status (which may have been coalesced).
--     3. In attendance_recompute_one() BEFORE trigger, restore OLD.status when
--        manually_overridden=true to prevent the ON CONFLICT value from
--        leaking through before the guard fires.
--
-- H-1 (HIGH, exploitable): accept_lesson_swap() no auth.uid() check
--   Any authenticated user who knows a pending swap UUID can accept it on
--   behalf of the real target. The function also lacks SET search_path.
--
--   Fix: add `IF auth.uid() <> v_swap.target_id THEN RAISE EXCEPTION` and
--   add `SET search_path = public` to the function header.
--
-- H-3 (HIGH): profiles_validate_auth_link() SECURITY INVOKER queries auth.users
--   The trigger is SECURITY INVOKER, so it runs as the calling role
--   (typically `authenticated`). That role has no SELECT on auth.users.
--   Any client-side UPDATE touching email on a real profile would fail with
--   `permission denied for table users`.
--
--   Fix: make the function SECURITY DEFINER SET search_path = public.
--
-- M-4 (MEDIUM, broken): enforce_makeup_submission_writes() ignores monitor role
--   `monitor` was added in migration 026 but was never added to the staff
--   bypass list. A monitor who has the makeup_staff_update RLS policy (from
--   migration 027) can reach the trigger but then hits the student-path checks
--   and gets an exception when trying to write reviewer fields.
--
--   Fix: add 'monitor' to the `v_role IN (...)` bypass clause.
-- ============================================================================


-- ── H-4 fix part 1: attendance_increment_duration ────────────────────────

DROP FUNCTION IF EXISTS public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid
);

CREATE OR REPLACE FUNCTION public.attendance_increment_duration(
  p_lesson_id              uuid,
  p_student_id             uuid,
  p_delta_seconds          int,
  p_verified_checks_delta  int             DEFAULT 0,
  p_total_checks_delta     int             DEFAULT 0,
  p_left_at                timestamptz     DEFAULT NULL,
  p_joined_at              timestamptz     DEFAULT NULL,
  p_status                 attendance_status DEFAULT NULL,
  p_notes                  text            DEFAULT NULL,
  p_marked_by              uuid            DEFAULT NULL,
  p_request_id             uuid            DEFAULT NULL
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
    p_verified_checks_delta,
    p_total_checks_delta,
    p_request_id
  )
  ON CONFLICT (scheduled_lesson_id, student_id) DO UPDATE SET
    duration_seconds      = COALESCE(attendance.duration_seconds, 0) + p_delta_seconds,
    verified_checks       = attendance.verified_checks + p_verified_checks_delta,
    total_checks          = attendance.total_checks    + p_total_checks_delta,
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
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid
) IS
  'Server-side additive flush for attendance counters. Idempotent when p_request_id provided. '
  'status/notes only updated when p_status is explicitly supplied — never coerced to ''present''.';

GRANT EXECUTE ON FUNCTION public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid
) TO authenticated;


-- ── H-4 fix part 2: attendance_recompute_one — protect manual overrides ───
--
-- When manually_overridden=true, restore OLD.status and OLD.notes before the
-- trigger returns NEW, so that no upstream code (including ON CONFLICT) can
-- accidentally overwrite a manually-set decision.

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
  -- Manual override: restore the human decision — do NOT let any upstream
  -- statement (e.g. an ON CONFLICT DO UPDATE) change status or notes.
  IF NEW.manually_overridden THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.status := OLD.status;
      NEW.notes  := OLD.notes;
    END IF;
    RETURN NEW;
  END IF;

  -- FJ is a human decision; never auto-degrade it.
  IF NEW.status = 'justified' THEN
    RETURN NEW;
  END IF;

  -- Modalidade efetiva. Presencial → sempre manual.
  v_modality := public.effective_lesson_modality(NEW.scheduled_lesson_id);
  IF v_modality = 'presencial' THEN
    RETURN NEW;
  END IF;

  SELECT started_at, ended_at, duration_minutes
    INTO v_started, v_ended, v_duration_min
    FROM scheduled_lessons
   WHERE id = NEW.scheduled_lesson_id;

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


-- ── H-1 fix: accept_lesson_swap — require auth.uid() = target_id ──────────

CREATE OR REPLACE FUNCTION public.accept_lesson_swap(p_swap_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_swap    lesson_swap_requests%ROWTYPE;
  v_primary scheduled_lessons%ROWTYPE;
  v_offered scheduled_lessons%ROWTYPE;
BEGIN
  SELECT * INTO v_swap
  FROM lesson_swap_requests
  WHERE id = p_swap_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido de troca não encontrado.';
  END IF;

  IF v_swap.status <> 'pending' THEN
    RAISE EXCEPTION 'Esta solicitação já foi respondida.';
  END IF;

  -- Only the designated target may accept.
  IF auth.uid() <> v_swap.target_id THEN
    RAISE EXCEPTION 'Apenas o destinatário da troca pode aceitá-la.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('iv.skip_auto_history', 'true', true);

  SELECT * INTO v_primary FROM scheduled_lessons WHERE id = v_swap.scheduled_lesson_id;

  UPDATE scheduled_lessons
  SET professor_id = v_swap.target_id
  WHERE id = v_swap.scheduled_lesson_id;

  INSERT INTO lesson_assignment_history
    (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
  VALUES
    (v_swap.scheduled_lesson_id,
     v_primary.professor_id,
     v_swap.target_id,
     auth.uid(),
     'swap');

  IF v_swap.offered_lesson_id IS NOT NULL THEN
    SELECT * INTO v_offered FROM scheduled_lessons WHERE id = v_swap.offered_lesson_id;

    UPDATE scheduled_lessons
    SET professor_id = v_swap.requester_id
    WHERE id = v_swap.offered_lesson_id;

    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES
      (v_swap.offered_lesson_id,
       v_offered.professor_id,
       v_swap.requester_id,
       auth.uid(),
       'swap');
  END IF;

  UPDATE lesson_swap_requests
  SET status = 'accepted', responded_at = now()
  WHERE id = p_swap_id;

  PERFORM set_config('iv.skip_auto_history', 'false', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_lesson_swap(uuid) TO authenticated;


-- ── H-3 fix: profiles_validate_auth_link — make SECURITY DEFINER ──────────

CREATE OR REPLACE FUNCTION public.profiles_validate_auth_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Managed profiles: no auth.users entry required.
  IF NEW.is_managed_only = true THEN
    RETURN NEW;
  END IF;

  -- Real profiles: must have a matching auth.users row.
  IF NEW.email IS NULL THEN
    RAISE EXCEPTION 'Perfil real (is_managed_only=false) requer email';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'Perfil real (is_managed_only=false) requer auth.users com mesmo id (%)', NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Restrict direct execution — only called via trigger.
REVOKE ALL ON FUNCTION public.profiles_validate_auth_link() FROM PUBLIC;


-- ── M-4 fix: enforce_makeup_submission_writes — add 'monitor' to bypass ───

CREATE OR REPLACE FUNCTION public.enforce_makeup_submission_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();

  -- Service role / internal trigger context.
  IF v_role IS NULL THEN
    RETURN NEW;
  END IF;

  -- Staff (coord, professor, monitor) bypass column-level checks;
  -- row-level RLS already gates which rows they can reach.
  IF v_role IN ('coordenacao', 'professor', 'monitor') THEN
    RETURN NEW;
  END IF;

  -- Student path: enforce column-level restrictions.
  IF OLD.student_id          IS DISTINCT FROM NEW.student_id
     OR OLD.recording_id        IS DISTINCT FROM NEW.recording_id
     OR OLD.class_id            IS DISTINCT FROM NEW.class_id
     OR OLD.scheduled_lesson_id IS DISTINCT FROM NEW.scheduled_lesson_id
  THEN
    RAISE EXCEPTION 'Students cannot reassign a makeup submission.'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT (OLD.status IN ('pending', 'rejected') AND NEW.status = 'submitted') THEN
      RAISE EXCEPTION 'Students may only submit (or re-submit) a makeup; current status: %, new: %',
        OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.reviewer_notes IS NOT NULL
     OR NEW.reviewed_at  IS NOT NULL
     OR NEW.reviewed_by  IS NOT NULL
  THEN
    RAISE EXCEPTION 'Students cannot set reviewer fields.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
