-- ============================================================================
-- 052 — Add attendance_reprocess_lesson RPC
-- ============================================================================
--
-- PROBLEM
-- -------
-- The frontend "Reprocessar" functionality previously attempted to use
-- `supabase.raw('duration_seconds')` within an update payload. This is not
-- supported by the Supabase Javascript client, throwing an error and
-- preventing the coordinator from forcing an automatic status recalculation
-- on a lesson's attendance.
--
-- FIX
-- ---
-- Provide a clean, server-side RPC that updates `duration_seconds` to its
-- existing value for all non-overridden and non-justified rows of a specific
-- lesson. This triggers `attendance_recompute_trg`, reliably refreshing
-- all calculated statuses according to the latest lesson bounds.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.attendance_reprocess_lesson(p_lesson_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Perform a no-op update on duration_seconds.
  -- This reliably fires the BEFORE UPDATE OF duration_seconds trigger
  -- which invokes `compute_attendance_status()`.
  UPDATE public.attendance
  SET duration_seconds = duration_seconds
  WHERE scheduled_lesson_id = p_lesson_id
    AND manually_overridden = false
    AND status != 'justified'::attendance_status;
END;
$$;

COMMENT ON FUNCTION public.attendance_reprocess_lesson(uuid) IS
  'Forces recalculation of automatic attendance statuses for a given lesson by performing a no-op update that triggers attendance_recompute_trg.';

-- Grant execution to authenticated users (RLS applies to the underlying UPDATE)
GRANT EXECUTE ON FUNCTION public.attendance_reprocess_lesson(uuid) TO authenticated;
