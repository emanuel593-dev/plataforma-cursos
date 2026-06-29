-- ============================================================================
-- 046 — Fix lesson_no_report: também limpa quando existe lesson_evaluation
-- ============================================================================
--
-- Problema: a CTE lesson_no_report em 044/045 verificava apenas lesson_reports
-- (relatório técnico do professor). Quando um monitor preenchia a avaliação
-- de aula (lesson_evaluations), a exceção continuava aparecendo como falso-positivo.
--
-- Solução: adicionar segundo NOT EXISTS para lesson_evaluations, de modo que
-- a exceção desaparece se O PROFESSOR registrou um relatório OU se O MONITOR
-- registrou uma avaliação — qualquer evidência de encerramento documentado.
-- ============================================================================

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
    COALESCE(sl.ended_at, sl.scheduled_at)              AS opened_at,
    a.makeup_deadline                                   AS due_at,
    CASE
      WHEN a.makeup_deadline < now()                       THEN 'overdue'
      WHEN a.makeup_deadline < now() + interval '6 hours'  THEN 'due_soon'
      ELSE 'on_track'
    END                                                 AS sla_status,
    c.name                                              AS class_name,
    COALESCE(l.title, 'Aula')                           AS lesson_title,
    sl.scheduled_at                                     AS lesson_scheduled_at
  FROM attendance a
  JOIN  scheduled_lessons sl ON sl.id  = a.scheduled_lesson_id
  LEFT JOIN classes        c  ON c.id  = sl.class_id
  LEFT JOIN lessons        l  ON l.id  = sl.lesson_id
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
      WHEN (ms.submitted_at + interval '48 hours') < now()      THEN 'overdue'
      WHEN (ms.submitted_at + interval '42 hours') < now()      THEN 'due_soon'
      ELSE 'on_track'
    END                                                 AS sla_status,
    c.name                                              AS class_name,
    COALESCE(l.title, 'Aula')                           AS lesson_title,
    sl.scheduled_at                                     AS lesson_scheduled_at
  FROM makeup_submissions ms
  LEFT JOIN scheduled_lessons sl ON sl.id = ms.scheduled_lesson_id
  LEFT JOIN classes           c  ON c.id  = ms.class_id
  LEFT JOIN lessons           l  ON l.id  = sl.lesson_id
  WHERE ms.status = 'submitted'
    AND ms.submitted_at IS NOT NULL
),

-- 3) Aulas encerradas sem relatório de professor NEM avaliação de monitor.
--    Qualquer evidência de encerramento documentado (lesson_reports OU
--    lesson_evaluations) fecha a exceção.
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
      WHEN (sl.ended_at + interval '12 hours') < now()          THEN 'overdue'
      WHEN (sl.ended_at + interval '6 hours')  < now()          THEN 'due_soon'
      ELSE 'on_track'
    END                                                 AS sla_status,
    c.name                                              AS class_name,
    COALESCE(l.title, 'Aula')                           AS lesson_title,
    sl.scheduled_at                                     AS lesson_scheduled_at
  FROM scheduled_lessons sl
  LEFT JOIN classes c ON c.id = sl.class_id
  LEFT JOIN lessons l ON l.id = sl.lesson_id
  WHERE sl.status = 'completed'
    AND sl.ended_at IS NOT NULL
    AND public.effective_lesson_modality(sl.id) <> 'presencial'
    AND NOT EXISTS (
      SELECT 1 FROM lesson_reports lr
      WHERE lr.scheduled_lesson_id = sl.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM lesson_evaluations le
      WHERE le.scheduled_lesson_id = sl.id
    )
)

SELECT * FROM makeup_pending
UNION ALL
SELECT * FROM makeup_review
UNION ALL
SELECT * FROM lesson_no_report;

COMMENT ON VIEW public.v_coordination_exceptions IS
  'Fila unificada de pendências da coordenação com SLA calculado server-side. '
  'Cada linha = 1 exceção operacional. Inclui class_name, lesson_title e '
  'lesson_scheduled_at para exibição contextualizada no painel. '
  'security_invoker=true: aproveita RLS das tabelas-fonte. '
  'v3: migration 046 — lesson_no_report limpa quando existe lesson_evaluations.';

GRANT SELECT ON public.v_coordination_exceptions TO authenticated;
