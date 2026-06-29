-- ============================================================================
-- 044 — Coordination Exceptions: unified queue with SLA
-- ============================================================================
--
-- Objetivo (BASE_PROGRESSO_COORDENACAO_2026-05-25.md, Frentes B + C):
--   Consolidar em UMA fonte as pendências operacionais da coordenação,
--   com prazo de SLA calculado por tipo, severidade e link de referência.
--   A view é consumida por src/services/exceptions.service.ts e pelo
--   painel `CoordinationExceptionsPanel` no Dashboard.
--
-- Tipos inicialmente cobertos:
--   1) makeup_pending     — FJ aguardando reposição (deadline em attendance)
--   2) makeup_review      — Reposição enviada aguardando revisão (SLA 48h)
--   3) lesson_no_report   — Aula encerrada sem lesson_report (SLA 12h)
--
-- Estrutura comum (uma linha por exceção):
--   exception_type      text   — chave do tipo
--   exception_id        text   — UUID composto estável (type:source_id)
--   source_table        text   — tabela de origem
--   source_id           uuid   — PK do registro de origem
--   severity            text   — critical | high | medium | low
--   subject_user_id     uuid   — pessoa relacionada (aluno, professor)
--   class_id            uuid
--   scheduled_lesson_id uuid
--   summary             text   — descrição curta para o card
--   reference_route     text   — rota da SPA para abrir o item
--   opened_at           timestamptz — quando a obrigação "nasceu"
--   due_at              timestamptz — prazo do SLA
--   sla_status          text   — on_track | due_soon | overdue
--
-- Decisões de design:
--   - View NÃO-materializada para refletir dados em tempo real (R/W barato:
--     consultas filtradas pela coordenação são raras + tabelas pequenas).
--   - RLS herda das tabelas-fonte (security_invoker). Coordenação enxerga
--     tudo pelas policies já existentes em attendance/makeup/scheduled_lessons.
--   - "due_soon" = faltam <= 6h para o due_at; "overdue" = passou do due_at.
--   - Sem efeitos colaterais. Idempotente.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- Constantes de SLA (literais inline; alterar aqui se ajustar a política).
--   makeup_review:    48h  (revisão de resumo de reposição)
--   lesson_no_report: 12h  (relatório final pós-encerramento)
--   makeup_pending:   usa o próprio attendance.makeup_deadline
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_coordination_exceptions
WITH (security_invoker = true)
AS
WITH
-- 1) FJ aguardando reposição
makeup_pending AS (
  SELECT
    'makeup_pending'::text                              AS exception_type,
    ('makeup_pending:' || a.id::text)                   AS exception_id,
    'attendance'::text                                  AS source_table,
    a.id                                                AS source_id,
    CASE
      WHEN a.makeup_deadline < now()                        THEN 'critical'
      WHEN a.makeup_deadline < now() + interval '48 hours'  THEN 'high'
      ELSE 'medium'
    END                                                 AS severity,
    a.student_id                                        AS subject_user_id,
    sl.class_id                                         AS class_id,
    a.scheduled_lesson_id                               AS scheduled_lesson_id,
    'FJ aguardando reposição'::text                     AS summary,
    '/reposicoes'::text                                 AS reference_route,
    -- attendance não possui created_at/updated_at no schema; usamos o
    -- horário da aula como referência de quando a obrigação "nasceu".
    COALESCE(sl.ended_at, sl.scheduled_at)              AS opened_at,
    a.makeup_deadline                                   AS due_at,
    CASE
      WHEN a.makeup_deadline < now()                       THEN 'overdue'
      WHEN a.makeup_deadline < now() + interval '6 hours'  THEN 'due_soon'
      ELSE 'on_track'
    END                                                 AS sla_status
  FROM attendance a
  JOIN scheduled_lessons sl ON sl.id = a.scheduled_lesson_id
  WHERE a.status = 'justified'
    AND a.makeup_deadline IS NOT NULL
    AND a.makeup_satisfied = false
    AND NOT EXISTS (
      SELECT 1 FROM makeup_submissions ms
      WHERE ms.scheduled_lesson_id = a.scheduled_lesson_id
        AND ms.student_id          = a.student_id
        AND ms.status IN ('submitted', 'approved')
    )
),

-- 2) Reposições aguardando revisão da coordenação
makeup_review AS (
  SELECT
    'makeup_review'::text                               AS exception_type,
    ('makeup_review:' || ms.id::text)                   AS exception_id,
    'makeup_submissions'::text                          AS source_table,
    ms.id                                               AS source_id,
    CASE
      WHEN ms.submitted_at + interval '48 hours' < now()       THEN 'high'
      WHEN ms.submitted_at + interval '42 hours' < now()       THEN 'medium'
      ELSE 'low'
    END                                                 AS severity,
    ms.student_id                                       AS subject_user_id,
    ms.class_id                                         AS class_id,
    ms.scheduled_lesson_id                              AS scheduled_lesson_id,
    'Resumo de reposição aguardando revisão'::text      AS summary,
    '/reposicoes'::text                                 AS reference_route,
    ms.submitted_at                                     AS opened_at,
    (ms.submitted_at + interval '48 hours')             AS due_at,
    CASE
      WHEN (ms.submitted_at + interval '48 hours') < now()                      THEN 'overdue'
      WHEN (ms.submitted_at + interval '42 hours') < now()                      THEN 'due_soon'
      ELSE 'on_track'
    END                                                 AS sla_status
  FROM makeup_submissions ms
  WHERE ms.status = 'submitted'
    AND ms.submitted_at IS NOT NULL
),

-- 3) Aulas encerradas sem relatório final
lesson_no_report AS (
  SELECT
    'lesson_no_report'::text                            AS exception_type,
    ('lesson_no_report:' || sl.id::text)                AS exception_id,
    'scheduled_lessons'::text                           AS source_table,
    sl.id                                               AS source_id,
    CASE
      WHEN sl.ended_at + interval '12 hours' < now()           THEN 'high'
      WHEN sl.ended_at + interval '8 hours'  < now()           THEN 'medium'
      ELSE 'low'
    END                                                 AS severity,
    NULL::uuid                                          AS subject_user_id,
    sl.class_id                                         AS class_id,
    sl.id                                               AS scheduled_lesson_id,
    'Aula encerrada sem relatório final'::text          AS summary,
    '/relatorios'::text                                 AS reference_route,
    sl.ended_at                                         AS opened_at,
    (sl.ended_at + interval '12 hours')                 AS due_at,
    CASE
      WHEN (sl.ended_at + interval '12 hours') < now()                         THEN 'overdue'
      WHEN (sl.ended_at + interval '6 hours')  < now()                         THEN 'due_soon'
      ELSE 'on_track'
    END                                                 AS sla_status
  FROM scheduled_lessons sl
  WHERE sl.status = 'completed'
    AND sl.ended_at IS NOT NULL
    AND public.effective_lesson_modality(sl.id) <> 'presencial'
    AND NOT EXISTS (
      SELECT 1 FROM lesson_reports lr
      WHERE lr.scheduled_lesson_id = sl.id
    )
)

SELECT * FROM makeup_pending
UNION ALL
SELECT * FROM makeup_review
UNION ALL
SELECT * FROM lesson_no_report;

COMMENT ON VIEW public.v_coordination_exceptions IS
  'Fila unificada de pendências da coordenação com cálculo de SLA. '
  'Cada linha = 1 exceção operacional. Consumida pelo painel '
  'CoordinationExceptionsPanel no Dashboard. security_invoker=true: '
  'aproveita as policies RLS das tabelas-fonte.';

GRANT SELECT ON public.v_coordination_exceptions TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Sumário agregado (contadores por tipo + sla_status). Útil para badges
-- compactos no header do painel sem trazer todas as linhas.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_coordination_exceptions_summary
WITH (security_invoker = true)
AS
SELECT
  exception_type,
  COUNT(*)                                          AS total,
  COUNT(*) FILTER (WHERE sla_status = 'overdue')    AS overdue,
  COUNT(*) FILTER (WHERE sla_status = 'due_soon')   AS due_soon,
  COUNT(*) FILTER (WHERE sla_status = 'on_track')   AS on_track,
  COUNT(*) FILTER (WHERE severity   = 'critical')   AS critical,
  COUNT(*) FILTER (WHERE severity   = 'high')       AS high
FROM public.v_coordination_exceptions
GROUP BY exception_type;

COMMENT ON VIEW public.v_coordination_exceptions_summary IS
  'Contadores agregados por exception_type sobre v_coordination_exceptions. '
  'Usado pelo painel CoordinationExceptionsPanel para badges de cabeçalho.';

GRANT SELECT ON public.v_coordination_exceptions_summary TO authenticated;
