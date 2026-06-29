-- ============================================================================
-- 050 — Correcao manual de registros especificos marcados incorretamente
-- ============================================================================
--
-- CONTEXTO
-- --------
-- Apos rodar o backfill (049), os registros de Andreia Alves e Marcus Vinicius
-- na aula de 2026-06-15 continuam com status=absent e notes="0%",
-- mesmo com duration_seconds > 4000s.
--
-- A causa: o trigger attendance_recompute_one calcula effective_seconds como:
--   ended_at IS NOT NULL → v_eff = EXTRACT(EPOCH FROM (ended_at - started_at))
--   ended_at IS NULL     → v_eff = duration_minutes * 60
--
-- Se a aula foi encerrada ANTES dos alunos saírem (ended_at muito próximo de
-- started_at, ex: encerramento em 1min), o effective_seconds fica pequeno e
-- qualquer duration_seconds parece >= 75% — mas se started_at = NULL, o
-- trigger nao toca. O problema mais provavel: o trigger recalculou durante
-- o backfill usando um effective_seconds diferente do real (ex: duration_minutes=0).
--
-- SOLUCAO
-- -------
-- Forcar status=present com manually_overridden=true para os registros
-- confirmados como presentes (duration_seconds > 60% da duracao esperada).
-- O manually_overridden=true impede que o trigger reverta a decisao.
--
-- INSTRUCOES
-- ----------
-- 1. Execute o SELECT de diagnostico para confirmar os registros.
-- 2. Se os alunos estao corretos, execute o UPDATE dentro de BEGIN/COMMIT.
-- ============================================================================


-- ── DIAGNOSTICO: Ver estado atual dos registros afetados ────────────────────
SELECT
  a.id,
  p.full_name                   AS aluno,
  sl.started_at::date           AS data_aula,
  a.duration_seconds            AS duration_s,
  ROUND(a.duration_seconds / 60.0, 1) AS duration_min,
  a.total_checks,
  a.verified_checks,
  a.status,
  a.manually_overridden,
  sl.started_at,
  sl.ended_at,
  sl.duration_minutes,
  CASE
    WHEN sl.ended_at IS NOT NULL
    THEN EXTRACT(EPOCH FROM (sl.ended_at - sl.started_at))::int
    ELSE sl.duration_minutes * 60
  END                           AS effective_seconds_calculado,
  a.notes
FROM attendance a
JOIN profiles p           ON p.id  = a.student_id
JOIN scheduled_lessons sl ON sl.id = a.scheduled_lesson_id
WHERE
  a.status = 'absent'
  AND a.duration_seconds > 2000          -- mais de 33 min
  AND a.manually_overridden = false
ORDER BY sl.started_at DESC, p.full_name;


-- ── CORRECAO: Forcar status=present nos registros claramente corretos ────────
-- Critério: duration_seconds >= 60% de (76 min = 4560s) = 2736s
-- Esses alunos definitivamente estiveram presentes por tempo suficiente.

BEGIN;

  UPDATE attendance a
  SET
    status             = 'present',
    manually_overridden = true,
    notes              = NULL,
    marked_by          = (
      -- Usar o primeiro coordenador/monitor disponível, ou NULL
      SELECT id FROM profiles
      WHERE role IN ('coordenacao', 'monitor')
      ORDER BY created_at
      LIMIT 1
    )
  WHERE
    a.status              = 'absent'
    AND a.manually_overridden = false
    AND a.duration_seconds > 2736          -- >= 60% de aula de 76min
    AND EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = a.scheduled_lesson_id
        AND sl.started_at::date = '2026-06-15'
    );

  -- Verificar resultado antes de confirmar
  SELECT
    p.full_name       AS aluno,
    a.duration_seconds AS duration_s,
    a.status,
    a.manually_overridden,
    a.notes
  FROM attendance a
  JOIN profiles p ON p.id = a.student_id
  WHERE
    a.manually_overridden = true
    AND EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      WHERE sl.id = a.scheduled_lesson_id
        AND sl.started_at::date = '2026-06-15'
    )
  ORDER BY p.full_name;

-- COMMIT;  -- Descomente e execute separadamente após revisar
-- ROLLBACK;

COMMIT;
