-- ============================================================================
-- 049 — Backfill: recalcular duration_seconds de registros afetados pelo BUG #2
-- ============================================================================
--
-- CONTEXTO
-- --------
-- O BUG #2 (corrigido no frontend na Fase 1) causava duration_seconds = 0
-- em registros de alunos que sofreram reconexoes WebRTC durante a aula.
-- O joinedAtRef do hook era zerado a cada reconexao, e o cursor
-- lastFlushedSessionSecondsRef era avancado antes do await: em caso
-- de falha de rede, o tempo acumulado era perdido silenciosamente.
--
-- Este script IDENTIFICA e CORRIGE esses registros usando os campos
-- joined_at e left_at que foram corretamente persistidos pela RPC,
-- recalculando duration_seconds = EXTRACT(EPOCH FROM (left_at - joined_at)).
--
-- SEGURANCA
-- ---------
-- 1. Apenas registros com manually_overridden = false sao tocados.
-- 2. Apenas registros onde duration_seconds < 10% da duracao real calculada
--    por joined_at/left_at sao candidatos.
-- 3. O trigger attendance_recompute_trg dispara automaticamente apos o UPDATE
--    e reavalia status/notes com base no novo duration_seconds.
--
-- INSTRUCOES DE USO
-- -----------------
-- 1. Execute o PASSO 1 (SELECT de diagnostico) e revise os registros.
-- 2. Confirme com a coordenacao quais registros devem ser corrigidos.
-- 3. Execute o PASSO 2 dentro de uma transacao (BEGIN/COMMIT).
-- 4. Execute o PASSO 3 para verificar que nao ha registros suspeitos restantes.
-- ============================================================================


-- ============================================================
-- PASSO 1: DIAGNOSTICO — revisar candidatos antes de alterar
-- ============================================================
SELECT
  a.id,
  p.full_name                                              AS aluno,
  sl.started_at::date                                      AS data_aula,
  a.joined_at,
  a.left_at,
  a.duration_seconds                                       AS duration_atual_s,
  ROUND(a.duration_seconds / 60.0, 1)                      AS duration_atual_min,
  EXTRACT(EPOCH FROM (a.left_at - a.joined_at))::int       AS duration_calculada_s,
  ROUND(EXTRACT(EPOCH FROM (a.left_at - a.joined_at)) / 60.0, 1) AS duration_calculada_min,
  a.total_checks,
  a.verified_checks,
  a.status                                                 AS status_atual,
  a.manually_overridden,
  a.notes
FROM attendance a
JOIN profiles p           ON p.id  = a.student_id
JOIN scheduled_lessons sl ON sl.id = a.scheduled_lesson_id
WHERE
  a.joined_at    IS NOT NULL
  AND a.left_at  IS NOT NULL
  AND a.left_at  > a.joined_at
  AND a.manually_overridden = false
  AND EXTRACT(EPOCH FROM (a.left_at - a.joined_at)) > (COALESCE(a.duration_seconds, 0) * 10 + 60)
ORDER BY sl.started_at DESC, p.full_name;


-- ============================================================
-- PASSO 2: BACKFILL — recalcular duration_seconds
-- ATENCAO: so execute apos revisar o SELECT acima.
-- ============================================================
BEGIN;

  CREATE TEMP TABLE attendance_backfill_snapshot AS
  SELECT
    a.id,
    p.full_name                                            AS aluno,
    a.duration_seconds                                     AS duration_antes,
    a.status                                               AS status_antes,
    a.notes                                                AS notes_antes,
    EXTRACT(EPOCH FROM (a.left_at - a.joined_at))::int     AS duration_calculada
  FROM attendance a
  JOIN profiles p ON p.id = a.student_id
  WHERE
    a.joined_at   IS NOT NULL
    AND a.left_at IS NOT NULL
    AND a.left_at > a.joined_at
    AND a.manually_overridden = false
    AND EXTRACT(EPOCH FROM (a.left_at - a.joined_at)) > (COALESCE(a.duration_seconds, 0) * 10 + 60);

  UPDATE attendance a
  SET    duration_seconds = EXTRACT(EPOCH FROM (a.left_at - a.joined_at))::int
  WHERE
    a.joined_at   IS NOT NULL
    AND a.left_at IS NOT NULL
    AND a.left_at > a.joined_at
    AND a.manually_overridden = false
    AND EXTRACT(EPOCH FROM (a.left_at - a.joined_at)) > (COALESCE(a.duration_seconds, 0) * 10 + 60);

  SELECT
    s.id,
    s.aluno,
    s.duration_antes                                       AS dur_antes_s,
    s.status_antes,
    a.duration_seconds                                     AS dur_depois_s,
    a.status                                               AS status_depois,
    a.notes                                                AS notes_depois
  FROM attendance_backfill_snapshot s
  JOIN attendance a ON a.id = s.id
  ORDER BY s.aluno;

-- Se o resultado estiver correto, execute COMMIT. Caso contrario, ROLLBACK.
-- COMMIT;
-- ROLLBACK;


-- ============================================================
-- PASSO 3: VERIFICACAO DE INTEGRIDADE POS-BACKFILL
-- ============================================================
SELECT
  COUNT(*)                                                 AS total_suspeitos_restantes,
  COUNT(*) FILTER (WHERE a.status = 'absent')              AS ainda_ausentes,
  COUNT(*) FILTER (WHERE a.status = 'present')             AS presentes
FROM attendance a
WHERE
  a.joined_at   IS NOT NULL
  AND a.left_at IS NOT NULL
  AND a.left_at > a.joined_at
  AND a.manually_overridden = false
  AND EXTRACT(EPOCH FROM (a.left_at - a.joined_at)) > (COALESCE(a.duration_seconds, 0) * 10 + 60);


-- ============================================================
-- AUDITORIA: Registros com total_checks > 3 (BUG #1)
-- ============================================================
SELECT
  p.full_name           AS aluno,
  sl.started_at::date   AS data_aula,
  a.total_checks,
  a.verified_checks,
  a.duration_seconds,
  a.status,
  a.notes
FROM attendance a
JOIN profiles p           ON p.id  = a.student_id
JOIN scheduled_lessons sl ON sl.id = a.scheduled_lesson_id
WHERE a.total_checks > 3
ORDER BY a.total_checks DESC, sl.started_at DESC;
