-- ============================================================================
-- 039 — Security hardening: SET search_path in SECURITY DEFINER functions,
--       audit_logs INSERT policy restriction (findings H-2, M-1, M-3)
-- ============================================================================
--
-- H-2 (HIGH): is_class_professor / is_class_monitor — SECURITY DEFINER
--   without SET search_path. These functions are used in virtually every RLS
--   policy across the platform. Without a fixed search_path, a schema
--   injection (malicious schema ahead of 'public' in the caller's path)
--   could substitute a spoofed view returning true for all callers, granting
--   unauthorised read/write access across attendance, recordings, polls, etc.
--
-- M-1 (MEDIUM): Several SECURITY DEFINER trigger/helper functions that
--   reference tables without schema qualification and have no SET search_path:
--     • get_my_role()
--     • record_lesson_assignment_change()
--     • record_lesson_status_change()
--     • record_lesson_reschedule()
--     • auth_user_cascade_delete_profile()  (already qualified; adding for defence-in-depth)
--
-- M-3 (MEDIUM): audit_insert_auth — any authenticated user can INSERT
--   arbitrary rows into audit_logs (any action, entity, details payload).
--   All legitimate audit writes come from SECURITY DEFINER functions that
--   run as postgres (BYPASSRLS) — they are NOT affected by this policy.
--   Dropping the policy prevents direct client-side tampering.
-- ============================================================================


-- ── H-2: is_class_professor ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_class_professor(p_class_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.class_professors
    WHERE class_id = p_class_id AND professor_id = auth.uid()
  );
$$;


-- ── H-2: is_class_monitor ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_class_monitor(p_class_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.class_monitors
    WHERE class_id = p_class_id AND monitor_id = auth.uid()
  );
$$;


-- ── M-1: get_my_role ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.user_role
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;


-- ── M-1: record_lesson_assignment_change ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_lesson_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('iv.skip_auto_history', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.professor_id IS NOT NULL) THEN
    INSERT INTO public.lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES (NEW.id, NULL, NEW.professor_id, auth.uid(), 'assignment');

  ELSIF (TG_OP = 'UPDATE'
         AND COALESCE(OLD.professor_id::text,'') <> COALESCE(NEW.professor_id::text,'')) THEN
    INSERT INTO public.lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES (NEW.id, OLD.professor_id, NEW.professor_id, auth.uid(), 'substitution');
  END IF;

  RETURN NEW;
END;
$$;


-- ── M-1: record_lesson_status_change ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_lesson_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status THEN

    IF NEW.status = 'cancelled' THEN
      INSERT INTO public.lesson_assignment_history
        (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
      VALUES
        (NEW.id, NULL, NULL, auth.uid(), 'cancellation',
         'status: ' || COALESCE(OLD.status::text, '?') || ' → cancelled');

    ELSIF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      INSERT INTO public.lesson_assignment_history
        (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
      VALUES
        (NEW.id, NULL, NULL, auth.uid(), 'reinstatement',
         'status: cancelled → ' || NEW.status::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- ── M-1: record_lesson_reschedule ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_lesson_reschedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.scheduled_at IS DISTINCT FROM NEW.scheduled_at THEN
    INSERT INTO public.lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind, reason)
    VALUES
      (NEW.id, NULL, NULL, auth.uid(), 'reschedule',
       to_char(OLD.scheduled_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YY HH24:MI')
       || ' → '
       || to_char(NEW.scheduled_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YY HH24:MI'));
  END IF;
  RETURN NEW;
END;
$$;


-- ── M-1: auth_user_cascade_delete_profile ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_user_cascade_delete_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.profiles
   WHERE id = OLD.id
     AND is_managed_only = false;
  RETURN OLD;
END;
$$;


-- ── M-3: restrict audit_logs direct INSERT ───────────────────────────────────
--
-- All legitimate writes to audit_logs come from SECURITY DEFINER functions
-- (running as postgres, BYPASSRLS=true) — they are unaffected by this change.
-- Dropping the permissive policy prevents authenticated users from injecting
-- arbitrary audit entries via PostgREST.

DROP POLICY IF EXISTS "audit_insert_auth" ON audit_logs;
