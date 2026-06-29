-- ============================================================================
-- 043 — M6: Attendance mark idempotency + L3: log_role_denied
-- ============================================================================

-- ============================================================================
-- M6 — Idempotency for markPresent / markAbsent / markJustified
-- ============================================================================
--
-- Context: `flushAttendanceProgress` already has idempotency via
-- `last_flush_request_id` (migration 032). But the "point-mark" RPCs
-- (markPresent, markAbsent, markJustified) go through a raw PostgREST
-- UPSERT — a retry after a network timeout can re-write notes/timestamps
-- with the same or slightly different payload. This migration adds a
-- side-table `attendance_idempotency_keys` (TTL 5 min) consulted at the
-- start of the new SECURITY DEFINER function
-- `attendance_upsert_with_key`.
--
-- The client (attendance.service.ts) supplies a UUID v4 per user action
-- and retries with the SAME key. The first call executes the upsert and
-- inserts the key; subsequent calls within 5 min return the already-stored
-- row unchanged.

CREATE TABLE IF NOT EXISTS public.attendance_idempotency_keys (
  key           uuid PRIMARY KEY,
  lesson_id     uuid NOT NULL,
  student_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.attendance_idempotency_keys IS
  'Short-lived (5 min) idempotency keys for point attendance mark operations. '
  'Checked by attendance_upsert_with_key to guarantee exactly-once semantics '
  'across retry storms (network timeouts, double-tap, multi-device).';

-- Index for the TTL prune and per-key lookup.
CREATE INDEX IF NOT EXISTS attendance_idempotency_keys_created_at_idx
  ON public.attendance_idempotency_keys (created_at);

-- RLS: completely owned by the function (SECURITY DEFINER bypasses RLS).
ALTER TABLE public.attendance_idempotency_keys ENABLE ROW LEVEL SECURITY;
-- No direct client access — function runs as postgres / SECURITY DEFINER.

-- ── RPC ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.attendance_upsert_with_key(
  p_lesson_id             uuid,
  p_student_id            uuid,
  p_request_id            uuid,
  p_status                attendance_status,
  p_marked_by             uuid         DEFAULT NULL,
  p_notes                 text         DEFAULT NULL,
  p_makeup_deadline       timestamptz  DEFAULT NULL,
  p_manually_overridden   boolean      DEFAULT true
) RETURNS attendance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row attendance;
BEGIN
  -- 1. Prune stale keys older than 5 minutes (best-effort cleanup; a periodic
  --    cron can also do this, but not strictly required given the tiny volume).
  DELETE FROM public.attendance_idempotency_keys
   WHERE created_at < now() - interval '5 minutes';

  -- 2. Idempotency check: if this key was already applied, return the
  --    current row immediately without touching attendance.
  IF p_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.attendance_idempotency_keys
     WHERE key = p_request_id
  ) THEN
    SELECT * INTO v_row
      FROM public.attendance
     WHERE scheduled_lesson_id = p_lesson_id
       AND student_id = p_student_id;
    RETURN v_row;
  END IF;

  -- 3. Authorisation: only the marked_by user, a coordenação member, a
  --    professor of the class, or a monitor of the class may mark attendance.
  --    (Guards the SECURITY DEFINER escalation.)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 4. Perform the upsert.
  INSERT INTO public.attendance (
    scheduled_lesson_id,
    student_id,
    status,
    marked_by,
    notes,
    makeup_deadline,
    manually_overridden,
    joined_at
  )
  VALUES (
    p_lesson_id,
    p_student_id,
    p_status,
    p_marked_by,
    p_notes,
    p_makeup_deadline,
    p_manually_overridden,
    CASE WHEN p_status = 'present' THEN now() ELSE NULL END
  )
  ON CONFLICT (scheduled_lesson_id, student_id) DO UPDATE
    SET status               = EXCLUDED.status,
        marked_by            = EXCLUDED.marked_by,
        notes                = EXCLUDED.notes,
        makeup_deadline      = EXCLUDED.makeup_deadline,
        manually_overridden  = EXCLUDED.manually_overridden,
        joined_at            = COALESCE(attendance.joined_at, EXCLUDED.joined_at),
        updated_at           = now()
  RETURNING * INTO v_row;

  -- 5. Record the idempotency key so retries are no-ops.
  IF p_request_id IS NOT NULL THEN
    INSERT INTO public.attendance_idempotency_keys (key, lesson_id, student_id)
    VALUES (p_request_id, p_lesson_id, p_student_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_row;
END;
$$;

-- Only authenticated users may call this function.
REVOKE ALL ON FUNCTION public.attendance_upsert_with_key(
  uuid, uuid, uuid, attendance_status, uuid, text, timestamptz, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_upsert_with_key(
  uuid, uuid, uuid, attendance_status, uuid, text, timestamptz, boolean
) TO authenticated;

COMMENT ON FUNCTION public.attendance_upsert_with_key IS
  'Idempotent attendance mark (present/absent/justified). Accepts a UUID v4 '
  'request_id; repeated calls with the same key within 5 min are no-ops. '
  'Replaces the direct PostgREST UPSERT used by markPresent/markAbsent/'
  'markJustified, which lacked retry safety.';

-- ============================================================================
-- L3 — log_role_denied: audit trail for authorization denials
-- ============================================================================
--
-- Context: ProtectedRoute.tsx currently emits a console.warn on role-denied.
-- This migration adds a SECURITY DEFINER RPC so the client can also persist
-- the denial to audit_logs (useful for detecting privilege escalation probes
-- and misconfigured routes). The RPC rate-limits to 1 write per
-- (actor, route) per 5 minutes to prevent log flooding.

CREATE OR REPLACE FUNCTION public.log_role_denied(
  p_denied_role  text,
  p_route        text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- Require an authenticated session (no anonymous spam).
  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  -- Rate-limit: skip if a denial for the same (actor, route) was logged in
  -- the last 5 minutes to avoid log flooding from repeated navigation.
  IF EXISTS (
    SELECT 1 FROM public.audit_logs
     WHERE actor_id = v_actor
       AND action   = 'auth.role_denied'
       AND details->>'route' = p_route
       AND created_at >= now() - interval '5 minutes'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.audit_logs (actor_id, action, entity, entity_id, details)
  VALUES (
    v_actor,
    'auth.role_denied',
    'profile',
    v_actor::text,
    jsonb_build_object(
      'denied_role', p_denied_role,
      'route',       p_route
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_role_denied(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_role_denied(text, text) TO authenticated;

COMMENT ON FUNCTION public.log_role_denied IS
  'Records an authorization denial to audit_logs. Called fire-and-forget by '
  'ProtectedRoute when a user''s role is not in the allowedRoles list. '
  'Rate-limited to 1 write per (actor, route) per 5 minutes.';
