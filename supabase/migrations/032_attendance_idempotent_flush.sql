-- ============================================================================
-- 032 — Idempotent attendance flush (BUG F)
-- ============================================================================
--
-- Problema (auditoria §2 BUG F): o RPC `attendance_increment_duration` é
-- aditivo e sem chave de idempotência. Em cenários reais (visibilitychange +
-- beforeunload + reconnect, ou multi-device, ou retry após timeout de rede)
-- o mesmo delta pode chegar duas vezes e somar duplicado.
--
-- Solução:
--   * Coluna `attendance.last_flush_request_id uuid` registra o último UUID
--     aplicado.
--   * `attendance_increment_duration` ganha parâmetro `p_request_id uuid`
--     opcional. Quando NÃO-NULL e igual ao último aplicado, o RPC retorna
--     a row atual SEM somar — operação idempotente.
--   * O cliente gera UUID v4 por flush e o reusa em retries (mesmo segmento).
--   * Backwards-compatible: chamadas legadas sem `p_request_id` continuam
--     funcionando (modo aditivo simples — usado nos fallbacks/dev).
--
-- O trigger `attendance_recompute_trg` (031) continua disparando porque
-- mesmo no caminho idempotente NÃO há UPDATE — então não vai re-rodar
-- desnecessariamente, ótimo.

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS last_flush_request_id uuid;

COMMENT ON COLUMN attendance.last_flush_request_id IS
  'UUID do último flush aplicado via attendance_increment_duration. Usado para '
  'idempotência: chamadas com mesmo request_id são no-op.';

-- Dropa a versão anterior (sem p_request_id) — caso contrário ficamos com
-- overload ambíguo. CREATE OR REPLACE não substitui assinatura diferente.
DROP FUNCTION IF EXISTS public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid
);

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
  p_marked_by              uuid DEFAULT NULL,
  p_request_id             uuid DEFAULT NULL
) RETURNS attendance
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_row     attendance;
  v_existing attendance;
BEGIN
  IF p_delta_seconds < 0 OR p_verified_checks_delta < 0 OR p_total_checks_delta < 0 THEN
    RAISE EXCEPTION 'Deltas devem ser >= 0';
  END IF;

  -- Idempotência: se request_id já foi aplicado, devolve a row atual
  -- sem somar. Evita duplo-flush em retries / multi-handler.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM attendance
     WHERE scheduled_lesson_id = p_lesson_id
       AND student_id = p_student_id;

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
    COALESCE(p_status, 'present'::attendance_status),
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
    duration_seconds = COALESCE(attendance.duration_seconds, 0) + p_delta_seconds,
    verified_checks  = attendance.verified_checks + p_verified_checks_delta,
    total_checks     = attendance.total_checks    + p_total_checks_delta,
    left_at          = COALESCE(EXCLUDED.left_at, attendance.left_at),
    joined_at        = LEAST(
                         COALESCE(attendance.joined_at, EXCLUDED.joined_at),
                         COALESCE(EXCLUDED.joined_at, attendance.joined_at)
                       ),
    status     = COALESCE(EXCLUDED.status, attendance.status),
    notes      = CASE WHEN p_status IS NOT NULL THEN EXCLUDED.notes ELSE attendance.notes END,
    marked_by  = COALESCE(EXCLUDED.marked_by, attendance.marked_by),
    last_flush_request_id = COALESCE(EXCLUDED.last_flush_request_id, attendance.last_flush_request_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid
) IS
  'Soma server-side de contadores com idempotência via p_request_id. Cliente '
  'envia UUID por flush; retries com mesmo UUID são no-op.';

GRANT EXECUTE ON FUNCTION public.attendance_increment_duration(
  uuid, uuid, int, int, int, timestamptz, timestamptz, attendance_status, text, uuid, uuid
) TO authenticated;
