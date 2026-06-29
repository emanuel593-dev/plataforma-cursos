import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type {
  LessonEvaluation,
  LessonEvaluationInsert,
} from '../types';

// ── lesson_evaluations service ───────────────────────────────────────────────
//
// Phase 3 of the monitor rollout. The evaluation form is filled by class
// monitors after a lesson and is CONFIDENTIAL — RLS in migration 029 limits
// visibility to coordenação and the monitor who authored the row. The
// evaluated professor never sees it, by design.
//
// All write paths funnel through `upsertEvaluation`: UNIQUE
// (scheduled_lesson_id, monitor_id) lets the same monitor revise their
// answer without creating duplicates.

/** Fetch the current monitor's evaluation for a given lesson, if any.
 *  Used to pre-populate the form on re-open. Returns null when no row
 *  exists yet (PostgREST 404) or Supabase is unconfigured. */
export async function getMyEvaluation(
  scheduledLessonId: string,
  monitorId: string,
): Promise<LessonEvaluation | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase
    .from('lesson_evaluations')
    .select('*')
    .eq('scheduled_lesson_id', scheduledLessonId)
    .eq('monitor_id', monitorId)
    .maybeSingle();
  if (error) {
    console.warn('[IV] getMyEvaluation error:', error.message);
    return null;
  }
  return (data as LessonEvaluation | null) ?? null;
}

/** Insert-or-update the monitor's evaluation. The composite UNIQUE key on
 *  (scheduled_lesson_id, monitor_id) is the conflict target. */
export async function upsertEvaluation(input: LessonEvaluationInsert): Promise<LessonEvaluation> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase não configurado.');
  }
  const { data, error } = await (supabase.from('lesson_evaluations') as any)
    .upsert(input, { onConflict: 'scheduled_lesson_id,monitor_id' })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as LessonEvaluation;
}

/** Coordenação-only listing of every evaluation for a given lesson. RLS
 *  enforces the role check; on the client we still rely on it to fail
 *  closed for non-coord callers. */
export async function listEvaluationsByLesson(
  scheduledLessonId: string,
): Promise<LessonEvaluation[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('lesson_evaluations')
    .select('*')
    .eq('scheduled_lesson_id', scheduledLessonId)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[IV] listEvaluationsByLesson error:', error.message);
    return [];
  }
  return (data ?? []) as LessonEvaluation[];
}

/** Coordenação-only listing of all evaluations for a class within an
 *  optional date range (filters on scheduled_lessons.scheduled_at via the
 *  joined relation). When no range is provided returns the most recent
 *  500 rows to keep the payload bounded. */
export async function listEvaluationsByClass(
  classId: string,
  opts?: { fromIso?: string; toIso?: string },
): Promise<LessonEvaluation[]> {
  if (!isSupabaseConfigured) return [];
  let query = supabase
    .from('lesson_evaluations')
    .select('*')
    .eq('class_id', classId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (opts?.fromIso) query = query.gte('created_at', opts.fromIso);
  if (opts?.toIso)   query = query.lte('created_at', opts.toIso);
  const { data, error } = await query;
  if (error) {
    console.warn('[IV] listEvaluationsByClass error:', error.message);
    return [];
  }
  return (data ?? []) as LessonEvaluation[];
}

/** Coordenação-only: list every evaluation in the system. Used by the
 *  Reports view to compute aggregates (e.g. averages per professor).
 *  Bounded to 1000 rows because the Reports page already paginates. */
export async function listAllEvaluations(): Promise<LessonEvaluation[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('lesson_evaluations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    console.warn('[IV] listAllEvaluations error:', error.message);
    return [];
  }
  return (data ?? []) as LessonEvaluation[];
}

// ── Composed types for the /avaliacoes view ───────────────────────────────────

/** A completed lesson that belongs to one of the monitor's classes, enriched
 *  with eval status for the "Avaliações" history page. */
export interface LessonForEval {
  lessonId: string;
  classId: string;
  classTitle: string;
  scheduledAt: string;
  /** null when the monitor has not yet submitted an evaluation. */
  evalId: string | null;
}

/** An evaluation row enriched with class title, lesson date, and monitor full
 *  name for the coordinator's read-only list in the "Avaliações" page. */
export interface EvaluationWithContext extends LessonEvaluation {
  classTitle: string;
  scheduledAt: string;
  monitorName: string | null;
}

/** Monitor-only: list completed lessons across all classes this monitor
 *  belongs to, together with whether they have already submitted an
 *  evaluation. Used to populate the "Avaliações" history/pending view. */
export async function listCompletedLessonsForMonitor(
  monitorId: string,
): Promise<LessonForEval[]> {
  if (!isSupabaseConfigured) return [];

  // Step 1 — class IDs for this monitor.
  const { data: mc, error: mcErr } = await supabase
    .from('class_monitors')
    .select('class_id')
    .eq('monitor_id', monitorId);
  if (mcErr || !mc || mc.length === 0) return [];
  const classIds = (mc as { class_id: string }[]).map(r => r.class_id);

  // Step 2 — completed lessons for those classes (with class name).
  const { data: lessons, error: lErr } = await supabase
    .from('scheduled_lessons')
    .select('id, class_id, scheduled_at, classes(name)')
    .in('class_id', classIds)
    .eq('status', 'completed')
    .order('scheduled_at', { ascending: false })
    .limit(100);
  if (lErr || !lessons || lessons.length === 0) return [];

  // Step 3 — which lessons already have an evaluation from this monitor?
  const lessonIds = (lessons as any[]).map((l: any) => l.id as string);
  const { data: evals } = await supabase
    .from('lesson_evaluations')
    .select('id, scheduled_lesson_id')
    .eq('monitor_id', monitorId)
    .in('scheduled_lesson_id', lessonIds);

  const evalMap = new Map<string, string>(); // scheduledLessonId → evalId
  for (const e of (evals ?? []) as any[]) {
    evalMap.set(e.scheduled_lesson_id as string, e.id as string);
  }

  return (lessons as any[]).map((l: any) => ({
    lessonId:    l.id as string,
    classId:     l.class_id as string,
    classTitle:  (l.classes as any)?.name ?? 'Turma',
    scheduledAt: l.scheduled_at as string,
    evalId:      evalMap.get(l.id as string) ?? null,
  }));
}

/** Coord-only: all evaluations enriched with class title, lesson date, and
 *  monitor name. Used for the read-only oversight list in "Avaliações". The
 *  primary analytics (aggregates, charts) remain in "Relatórios". */
export async function listAllEvaluationsWithContext(): Promise<EvaluationWithContext[]> {
  if (!isSupabaseConfigured) return [];

  // Avoid PostgREST embedded joins entirely: lesson_evaluations has two paths
  // to `classes` (direct class_id FK + via scheduled_lessons.class_id), which
  // causes the query planner to create a `classes_1` alias that breaks the
  // generated SQL. Use explicit column selection and resolve all context via
  // parallel secondary queries instead.
  const { data, error } = await supabase
    .from('lesson_evaluations')
    .select(
      'id, scheduled_lesson_id, class_id, monitor_id, ' +
      'content_score, duration_assessment, dynamics_score, engagement_score, ' +
      'notes, suggestions, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) {
    console.warn('[IV] listAllEvaluationsWithContext error:', error.message);
    return [];
  }
  if (!data || data.length === 0) return [];

  const rows = data as any[];

  // Resolve class titles, lesson dates, and monitor names in parallel.
  const classIds   = [...new Set(rows.map((r: any) => r.class_id            as string))];
  const lessonIds  = [...new Set(rows.map((r: any) => r.scheduled_lesson_id as string))];
  const monitorIds = [...new Set(rows.map((r: any) => r.monitor_id          as string))];

  const [{ data: classes }, { data: lessons }, { data: profiles }] = await Promise.all([
    supabase.from('classes').select('id, name').in('id', classIds),
    supabase.from('scheduled_lessons').select('id, scheduled_at').in('id', lessonIds),
    supabase.from('profiles').select('id, full_name').in('id', monitorIds),
  ]);

  const classMap  = new Map<string, string>();
  for (const c of (classes  ?? []) as any[]) classMap.set(c.id  as string, c.name       as string);
  const lessonMap = new Map<string, string>();
  for (const l of (lessons  ?? []) as any[]) lessonMap.set(l.id as string, l.scheduled_at as string);
  const nameMap   = new Map<string, string>();
  for (const p of (profiles ?? []) as any[]) nameMap.set(p.id   as string, p.full_name  as string);

  return rows.map((row: any) => ({
    id:                  row.id,
    scheduled_lesson_id: row.scheduled_lesson_id,
    class_id:            row.class_id,
    monitor_id:          row.monitor_id,
    content_score:       row.content_score,
    duration_assessment: row.duration_assessment,
    dynamics_score:      row.dynamics_score,
    engagement_score:    row.engagement_score,
    notes:               row.notes,
    suggestions:         row.suggestions,
    created_at:          row.created_at,
    updated_at:          row.updated_at,
    classTitle:  classMap.get(row.class_id            as string) ?? '',
    scheduledAt: lessonMap.get(row.scheduled_lesson_id as string) ?? row.created_at,
    monitorName: nameMap.get(row.monitor_id            as string) ?? null,
  } as EvaluationWithContext));
}
