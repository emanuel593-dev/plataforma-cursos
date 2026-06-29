-- ============================================================================
-- 031 — Server-side attendance recompute + manual override flag
-- ============================================================================
--
-- Corrige bugs A/B/C/D documentados em docs/AUDITORIA_PRESENCA_E_WEBRTC.md:
--
--  A) Denominador volátil: a % impressa em `notes` ficava "congelada" com o
--     valor de `sl.duration_minutes` no momento do flush; se o agendamento
--     era editado depois, a nota ficava inconsistente com o header.
--
--  B) `duration_seconds` continuava subindo após o final-flush mas
--     `status`/`notes` ficavam congelados — total/% mostrados na UI ficavam
--     contraditórios entre si.
--
--  C) O critério usava a duração AGENDADA (duration_minutes), não a REAL
--     (`ended_at - started_at`). Aluno punido por aula encerrada cedo.
--
--  D) Override manual de status (coordenação clicando P/F/FJ no grid)
--     preservava a nota automática antiga ("permaneceu 73%, removida")
--     mesmo após mudança para Presente — UI ficava contraditória.
--
-- Estratégia:
--   1. Adiciona `attendance.manually_overridden boolean` (default false).
--   2. Função `compute_attendance_status(...)` pura: recebe contadores +
--      duração efetiva e devolve `status` + `notes` derivados.
--   3. Trigger BEFORE INSERT/UPDATE em `attendance` que reavalia status/notes
--      a cada mudança de contador, USANDO `started_at`/`ended_at` reais da
--      aula. Respeita `manually_overridden=true` (não toca) e `status='justified'`
--      (FJ é decisão humana, nunca auto-degradada).
--   4. Trigger AFTER UPDATE em `scheduled_lessons` que dispara recompute em
--      todas as attendance da aula quando `started_at`/`ended_at`/`duration_minutes`
--      mudam — assim editar a duração ou encerrar a aula reavalia tudo.
--   5. Critério composto: além do 75% de tempo, aceita 50%+todas-as-verificações.
--
-- Idempotente: ALTER TABLE ... ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
-- DROP TRIGGER IF EXISTS.

-- ── 1. Manual override flag ───────────────────────────────────────────────
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS manually_overridden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN attendance.manually_overridden IS
  'Quando true, o trigger de recompute preserva status/notes definidos manualmente '
  'pela coordenação. Setado pelo grid de chamada e por markPresent/markAbsent/markJustified.';


-- ── 2. Função pura de decisão ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_attendance_status(
  p_duration_seconds  int,
  p_verified_checks   int,
  p_total_checks      int,
  p_effective_seconds int
) RETURNS TABLE(out_status attendance_status, out_notes text)
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_ratio numeric;
  v_pct   int;
BEGIN
  -- Duração efetiva ainda desconhecida (aula sem started/ended e sem duration_minutes):
  -- não decidir automaticamente.
  IF p_effective_seconds IS NULL OR p_effective_seconds <= 0 THEN
    out_status := 'present'::attendance_status;
    out_notes  := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  v_ratio := COALESCE(p_duration_seconds, 0)::numeric / p_effective_seconds::numeric;
  v_pct   := LEAST(100, GREATEST(0, ROUND(v_ratio * 100)::int));

  -- Critério composto (BUG G da auditoria):
  --   * tempo >= 75%                                       → present
  --   * tempo >= 50% E todas as verificações respondidas   → present (justifica)
  --   * verificações > 0 mas nenhuma respondida            → absent (motivo específico)
  --   * caso contrário                                     → absent (% baixo)
  IF v_ratio >= 0.75 THEN
    out_status := 'present'::attendance_status;
    out_notes  := NULL;
  ELSIF v_ratio >= 0.5 AND p_total_checks > 0 AND p_verified_checks = p_total_checks THEN
    out_status := 'present'::attendance_status;
    out_notes  := format(
      'Presença confirmada: %s%% da aula + todas as verificações respondidas (%s/%s).',
      v_pct, p_verified_checks, p_total_checks
    );
  ELSIF p_total_checks > 0 AND p_verified_checks = 0 THEN
    out_status := 'absent'::attendance_status;
    out_notes  := format('Presença automática removida: não respondeu nenhuma verificação (0/%s).', p_total_checks);
  ELSE
    out_status := 'absent'::attendance_status;
    out_notes  := format('Presença automática removida: permaneceu %s%% da aula (mín. 75%%).', v_pct);
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.compute_attendance_status IS
  'Decide status + notes a partir de duration_seconds + verifications + duração efetiva da aula. '
  'Pura, sem efeitos colaterais. Usada pelo trigger attendance_recompute.';


-- ── 3. Trigger por linha em attendance ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.attendance_recompute_one() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_started      timestamptz;
  v_ended        timestamptz;
  v_duration_min int;
  v_eff          int;
  v_status       attendance_status;
  v_notes        text;
BEGIN
  -- Override manual: respeitamos a decisão humana e não tocamos status/notes.
  IF NEW.manually_overridden THEN
    RETURN NEW;
  END IF;

  -- FJ é decisão humana (registro com prazo de reposição). Nunca degradar
  -- automaticamente por % de tempo.
  IF NEW.status = 'justified' THEN
    RETURN NEW;
  END IF;

  SELECT started_at, ended_at, duration_minutes
    INTO v_started, v_ended, v_duration_min
    FROM scheduled_lessons
   WHERE id = NEW.scheduled_lesson_id;

  -- Aula nunca formalmente iniciada — não decidir auto. O cliente
  -- (ClassroomView) ainda pode forçar 'absent' com nota explícita
  -- "Aula não iniciada formalmente" via INSERT direto.
  IF v_started IS NULL THEN
    RETURN NEW;
  END IF;

  -- Duração efetiva = real (started→ended) quando disponível, senão a agendada.
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
  'BEFORE INSERT/UPDATE em attendance: reavalia status/notes com base na duração '
  'EFETIVA da aula. Respeita manually_overridden=true e status=justified.';

DROP TRIGGER IF EXISTS attendance_recompute_trg ON attendance;
CREATE TRIGGER attendance_recompute_trg
  BEFORE INSERT OR UPDATE OF
    duration_seconds, verified_checks, total_checks, manually_overridden
  ON attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_recompute_one();


-- ── 4. Trigger em scheduled_lessons: encerrar/editar aula recalcula tudo ──
CREATE OR REPLACE FUNCTION public.lesson_recompute_attendance() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.started_at      IS DISTINCT FROM NEW.started_at)
  OR (OLD.ended_at        IS DISTINCT FROM NEW.ended_at)
  OR (OLD.duration_minutes IS DISTINCT FROM NEW.duration_minutes) THEN
    -- No-op UPDATE força o BEFORE UPDATE trigger a re-rodar para cada linha.
    UPDATE attendance
       SET duration_seconds = duration_seconds
     WHERE scheduled_lesson_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.lesson_recompute_attendance IS
  'AFTER UPDATE em scheduled_lessons: quando started_at/ended_at/duration_minutes '
  'mudam, dispara recompute em todas as attendance da aula (via no-op update que '
  'aciona attendance_recompute_trg).';

DROP TRIGGER IF EXISTS lesson_recompute_attendance_trg ON scheduled_lessons;
CREATE TRIGGER lesson_recompute_attendance_trg
  AFTER UPDATE ON scheduled_lessons
  FOR EACH ROW
  EXECUTE FUNCTION public.lesson_recompute_attendance();


-- ── 5. Backfill: recalcular tudo que já existe ────────────────────────────
-- One-shot durante o deploy. Linhas com manually_overridden=false e status<>justified
-- terão notes/status reescritos para refletir o novo critério.
DO $$
BEGIN
  UPDATE attendance
     SET duration_seconds = duration_seconds
   WHERE manually_overridden = false
     AND status <> 'justified';
END;
$$;
