-- ============================================================================
-- 015 — Incremental attendance flush RPC
-- ============================================================================
--
-- Problema:
--   recordAttendanceLeave (cliente) calcula `duration_seconds = prior + delta`
--   localmente, depois faz upsert do valor absoluto. Em multi-tab ou flushes
--   sobrepostos (visibilitychange + beforeunload + reconnect), 2 escritas
--   concorrentes podem ler `prior=X` ao mesmo tempo e ambas escreverem
--   `X+delta` — perdendo um dos deltas (lost update).
--
-- Solução:
--   RPC que faz INSERT … ON CONFLICT … DO UPDATE com soma server-side dos
--   contadores. O cliente envia apenas DELTAS desde o último flush.
--   `status` e `notes` continuam sendo enviados como valor absoluto
--   (decisões de domínio do cliente), mas opcionalmente — quando NULL,
--   o valor existente é preservado.
--
-- Idempotência:
--   Não é idempotente — chamar duas vezes com `p_delta_seconds=30` soma 60.
--   A camada cliente garante via `lastFlushedSessionSecondsRef` + lock de
--   localStorage para deduplicar tabs concorrentes (janela 5s).
--
-- Segurança:
--   SECURITY INVOKER — usa as policies RLS existentes em `attendance`.
--   Aluno só pode incrementar a própria; professor da turma também pode.

CREATE OR REPLACE FUNCTION public.attendance_increment_duration(
  p_lesson_id              uuid,
  p_student_id             uuid,
  p_delta_seconds          int,
  p_verified_checks_delta  int  DEFAULT 0,
  p_total_checks_delta     int  DEFAULT 0,
  p_left_at                timestamptz DEFAULT NULL,
  p_joined_at              timestamptz DEFAULT NULL,
  p_status                 attendance_status DEFAULT NULL,
  p_notes                  text DEFAULT NULL,
  p_marked_by              uuid DEFAULT NULL
) RETURNS attendance
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_row attendance;
BEGIN
  -- Reject negative deltas explicitly — protects against bug or tampering.
  IF p_delta_seconds < 0 OR p_verified_checks_delta < 0 OR p_total_checks_delta < 0 THEN
    RAISE EXCEPTION 'Deltas devem ser >= 0';
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
    total_checks
  ) VALUES (
    p_lesson_id,
    p_student_id,
    COALESCE(p_status, 'present'::attendance_status),
    p_joined_at,
    p_left_at,
    p_delta_seconds,
    p_marked_by,
    p_notes,
    p_verified_checks_delta,
    p_total_checks_delta
  )
  ON CONFLICT (scheduled_lesson_id, student_id) DO UPDATE SET
    duration_seconds = COALESCE(attendance.duration_seconds, 0) + p_delta_seconds,
    verified_checks  = attendance.verified_checks + p_verified_checks_delta,
    total_checks     = attendance.total_checks    + p_total_checks_delta,
    left_at          = COALESCE(EXCLUDED.left_at, attendance.left_at),
    -- joined_at: preserve the earliest known timestamp.
    joined_at        = LEAST(
                         COALESCE(attendance.joined_at, EXCLUDED.joined_at),
                         COALESCE(EXCLUDED.joined_at, attendance.joined_at)
                       ),
    -- status / notes / marked_by: only overwrite when explicitly provided,
    -- so intermediate flushes (which pass NULL) don't downgrade status.
    status     = COALESCE(EXCLUDED.status, attendance.status),
    notes      = CASE WHEN p_status IS NOT NULL THEN EXCLUDED.notes ELSE attendance.notes END,
    marked_by  = COALESCE(EXCLUDED.marked_by, attendance.marked_by)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.attendance_increment_duration IS
  'Soma server-side de duration_seconds/verified_checks/total_checks para evitar lost-updates entre tabs concorrentes. Cliente envia apenas deltas desde o último flush.';

GRANT EXECUTE ON FUNCTION public.attendance_increment_duration TO authenticated;
