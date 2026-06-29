import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUser, getCurrentUserRole } from './auth.service';
import type {
  ScheduledLesson, ScheduledLessonInsert, ScheduledLessonUpdate,
  LessonStatus, ScheduledLessonWithRelations,
} from '../types';

// ── Permission helpers (localStorage mode only; Supabase uses RLS) ───────────

function assertCoordinator() {
  const role = getCurrentUserRole();
  if (role !== null && role !== 'coordenacao') {
    throw new Error('Operação permitida apenas para coordenação.');
  }
}

function assertLessonController() {
  const role = getCurrentUserRole();
  if (role !== null && role !== 'coordenacao' && role !== 'professor') {
    throw new Error('Operação não permitida para este perfil.');
  }
}

/**
 * Stricter gate for actions that mutate the lifecycle of a SPECIFIC lesson
 * (start / end / cancel / mark started). Coordination can act on any lesson;
 * professors can act ONLY on lessons where they are the designated titular
 * (`professor_id`). This is the application-layer enforcement of the
 * “titular do dia” concept — RLS allows any class professor to UPDATE
 * scheduled_lessons, so this is the authoritative business rule.
 *
 * NOTE: must be called with a lesson that already has `professor_id` set.
 * Lessons without a titular cannot be controlled by anyone except
 * coordination (intentional: forces a designation before going live).
 */
async function assertLessonTitular(lessonId: string): Promise<void> {
  const role = getCurrentUserRole();
  // localStorage / unauthenticated mode: skip (kept permissive for legacy demo flows).
  if (role === null) return;
  if (role === 'coordenacao') return; // coord bypasses titular check
  const user = getCurrentUser();
  if (!user) throw new Error('Usuário não autenticado.');
  const lesson = await getScheduledLesson(lessonId);
  if (!lesson) throw new Error('Aula não encontrada.');
  if (!lesson.professor_id) {
    throw new Error(
      'Esta aula ainda não tem um professor titular designado. Peça à coordenação para atribuir um titular antes de iniciar.',
    );
  }
  if (lesson.professor_id !== user.id) {
    throw new Error('Apenas o professor titular desta aula pode executar esta ação. Solicite uma troca se necessário.');
  }
}

// ── localStorage key ─────────────────────────────────────────────────────────

const LS_SCHEDULED = 'iv_scheduled_lessons';

function getStored(): ScheduledLesson[] {
  try {
    return JSON.parse(localStorage.getItem(LS_SCHEDULED) || '[]');
  } catch {
    return [];
  }
}

function save(items: ScheduledLesson[]) {
  localStorage.setItem(LS_SCHEDULED, JSON.stringify(items));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listScheduledLessons(): Promise<ScheduledLesson[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('scheduled_lessons')
      .select('*')
      .order('scheduled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored().sort(
    (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
  );
}

export async function listByClass(classId: string): Promise<ScheduledLesson[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('scheduled_lessons')
      .select('*')
      .eq('class_id', classId)
      .order('scheduled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter((s) => s.class_id === classId)
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
}

export async function listByDateRange(from: string, to: string): Promise<ScheduledLesson[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('scheduled_lessons')
      .select('*')
      .gte('scheduled_at', from)
      .lte('scheduled_at', to)
      .order('scheduled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  const fromTime = new Date(from).getTime();
  const toTime = new Date(to).getTime();
  return getStored()
    .filter((s) => {
      const t = new Date(s.scheduled_at).getTime();
      return t >= fromTime && t <= toTime;
    })
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
}

/** All scheduled lessons that touch a given professor.
 *
 * Includes both:
 *   (a) lessons explicitly assigned to this professor (`professor_id = X`), and
 *   (b) lessons of classes where this professor is in the junction
 *       (so unassigned lessons of "their" classes are still visible).
 */
export async function listByProfessor(professorId: string): Promise<ScheduledLesson[]> {
  if (isSupabaseConfigured) {
    // Fetch in two queries to avoid OR-with-join complexity in PostgREST.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const direct = (supabase as any)
      .from('scheduled_lessons')
      .select('*')
      .eq('professor_id', professorId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viaClass = (supabase as any)
      .from('scheduled_lessons')
      .select('*, class_professors!inner(professor_id)')
      .eq('class_professors.professor_id', professorId);
    const [d, v] = await Promise.all([direct, viaClass]);
    if (d.error) throw new Error(d.error.message);
    if (v.error) throw new Error(v.error.message);
    const merged = new Map<string, ScheduledLesson>();
    for (const row of ((d.data || []) as ScheduledLesson[])) merged.set(row.id, row);
    for (const row of ((v.data || []) as Array<ScheduledLesson & { class_professors?: unknown }>)) {
      const { class_professors: _cp, ...sl } = row;
      merged.set(sl.id, sl as ScheduledLesson);
    }
    return [...merged.values()].sort(
      (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    );
  }
  const { listClassesByProfessor } = await import('./classes.service');
  const profClasses = await listClassesByProfessor(professorId);
  const classIds = new Set(profClasses.map((c) => c.id));
  return getStored()
    .filter((s) => s.professor_id === professorId || classIds.has(s.class_id))
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
}

/** Lessons explicitly assigned to this professor (no class fallback). */
export async function listMyAssignedLessons(
  professorId: string,
  opts: { fromIso?: string; toIso?: string; statuses?: LessonStatus[] } = {},
): Promise<ScheduledLesson[]> {
  if (isSupabaseConfigured) {
    let query = supabase.from('scheduled_lessons').select('*').eq('professor_id', professorId);
    if (opts.fromIso) query = query.gte('scheduled_at', opts.fromIso);
    if (opts.toIso)   query = query.lte('scheduled_at', opts.toIso);
    if (opts.statuses && opts.statuses.length) query = query.in('status', opts.statuses);
    const { data, error } = await query.order('scheduled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter((s) => s.professor_id === professorId)
    .filter((s) => !opts.fromIso || s.scheduled_at >= opts.fromIso)
    .filter((s) => !opts.toIso   || s.scheduled_at <= opts.toIso)
    .filter((s) => !opts.statuses || opts.statuses.includes(s.status))
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
}

export async function listUpcoming(limit = 10, classIds?: string[]): Promise<ScheduledLesson[]> {
  if (classIds && classIds.length === 0) return [];
  
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    let query = supabase
      .from('scheduled_lessons')
      .select('*')
      .gte('scheduled_at', now)
      .in('status', ['scheduled', 'in_progress'])
      .order('scheduled_at')
      .limit(limit);
      
    if (classIds) {
      query = query.in('class_id', classIds);
    }
      
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  }
  const nowTime = new Date(now).getTime();
  return getStored()
    .filter(
      (s) =>
        new Date(s.scheduled_at).getTime() >= nowTime &&
        (s.status === 'scheduled' || s.status === 'in_progress') &&
        (!classIds || classIds.includes(s.class_id))
    )
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    .slice(0, limit);
}

/** Lessons relevant to the notification system: upcoming reminders, recently
 * started, and recently cancelled. Pulled in a single helper so the bell can
 * stay reactive without N round-trips. */
export async function listForNotifications(opts: {
  classIds?: string[];
  /** How far ahead to look for scheduled lessons (ms). Default: 2h. */
  windowAheadMs?: number;
  /** How far back to look for in_progress (ms). Default: 6h. */
  startedLookbackMs?: number;
  /** How far back to look for cancelled (ms). Default: 24h. */
  cancelledLookbackMs?: number;
} = {}): Promise<ScheduledLesson[]> {
  const { classIds, windowAheadMs = 2 * 60 * 60 * 1000,
          startedLookbackMs = 6 * 60 * 60 * 1000,
          cancelledLookbackMs = 24 * 60 * 60 * 1000 } = opts;
  if (classIds && classIds.length === 0) return [];

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const aheadIso = new Date(nowMs + windowAheadMs).toISOString();
  const startedFloorIso = new Date(nowMs - startedLookbackMs).toISOString();
  const cancelledFloorIso = new Date(nowMs - cancelledLookbackMs).toISOString();

  if (isSupabaseConfigured) {
    let upcoming = supabase.from('scheduled_lessons').select('*')
      .eq('status', 'scheduled')
      .gte('scheduled_at', nowIso)
      .lte('scheduled_at', aheadIso);
    let started = supabase.from('scheduled_lessons').select('*')
      .eq('status', 'in_progress')
      .gte('started_at', startedFloorIso);
    let cancelled = supabase.from('scheduled_lessons').select('*')
      .eq('status', 'cancelled')
      .gte('scheduled_at', cancelledFloorIso);
    if (classIds) {
      upcoming = upcoming.in('class_id', classIds);
      started = started.in('class_id', classIds);
      cancelled = cancelled.in('class_id', classIds);
    }
    const [u, s, c] = await Promise.all([upcoming, started, cancelled]);
    if (u.error) throw new Error(u.error.message);
    if (s.error) throw new Error(s.error.message);
    if (c.error) throw new Error(c.error.message);
    return [...(u.data || []), ...(s.data || []), ...(c.data || [])];
  }

  return getStored().filter((s) => {
    if (classIds && !classIds.includes(s.class_id)) return false;
    const schedMs = new Date(s.scheduled_at).getTime();
    if (s.status === 'scheduled') return schedMs >= nowMs && schedMs <= nowMs + windowAheadMs;
    if (s.status === 'in_progress') return !!s.started_at && new Date(s.started_at).getTime() >= nowMs - startedLookbackMs;
    if (s.status === 'cancelled') return schedMs >= nowMs - cancelledLookbackMs;
    return false;
  });
}

export async function getScheduledLesson(id: string): Promise<ScheduledLesson | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('scheduled_lessons')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStored().find((s) => s.id === id) || null;
}

export async function createScheduledLesson(input: ScheduledLessonInsert): Promise<ScheduledLesson> {
  assertCoordinator();
  assertOnline();
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('scheduled_lessons') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const sl: ScheduledLesson = {
    id: crypto.randomUUID(),
    class_id: input.class_id,
    lesson_id: input.lesson_id ?? null,
    professor_id: input.professor_id ?? null,
    scheduled_at: input.scheduled_at,
    duration_minutes: input.duration_minutes,
    room_id: null,
    status: 'scheduled',
    modality: input.modality ?? null,
    started_at: null,
    ended_at: null,
    notes: null,
    created_at: now,
  };
  const items = getStored();
  items.push(sl);
  save(items);
  return sl;
}

export async function updateScheduledLesson(id: string, updates: ScheduledLessonUpdate): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('scheduled_lessons') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const items = getStored();
  const idx = items.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error('Aula agendada não encontrada.');
  items[idx] = { ...items[idx], ...updates };
  save(items);
}

export async function deleteScheduledLesson(id: string): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('scheduled_lessons').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  save(getStored().filter((s) => s.id !== id));
}

// ── Status transitions ───────────────────────────────────────────────────────

/**
 * Open the WebRTC room. The lesson is marked `in_progress` and a room id is
 * minted, but `started_at` stays NULL until the host explicitly clicks
 * "Iniciar aula" in the room (see `markLessonStarted`). This separates
 * "sala aberta" (host warming up, students filtering in) from "aula
 * efetivamente começou" (clock + auto-attendance baseline).
 *
 * Idempotent: if the lesson is already `in_progress` and has a `room_id`,
 * the existing room id is returned and no DB write occurs. This protects
 * against accidental "Iniciar" re-clicks (e.g. host re-entering the room
 * after a reload) from rotating the room and orphaning students who were
 * already navigating to the previous URL.
 */
export async function startLesson(id: string): Promise<string> {
  assertLessonController();
  await assertLessonTitular(id);
  // Reuse existing room id if the lesson is already in progress.
  const existing = await getScheduledLesson(id);
  if (existing?.status === 'in_progress' && existing.room_id) {
    return existing.room_id;
  }
  const roomId = crypto.randomUUID();
  await updateScheduledLesson(id, {
    status: 'in_progress',
    room_id: roomId,
  });
  return roomId;
}

/**
 * Persist the authoritative "aula começou" timestamp. Idempotent on the
 * client side (the room hook only calls this once per session); even if
 * called twice, the value stays the first one written by the trigger
 * convention is preserved by client-side guard in useWebRTC.
 */
export async function markLessonStarted(id: string, startedAtMs: number): Promise<void> {
  assertLessonController();
  await assertLessonTitular(id);
  await updateScheduledLesson(id, {
    started_at: new Date(startedAtMs).toISOString(),
  });
}

/**
 * Best-effort fan-out push notification to enrolled students that a
 * lesson has just started. Resolves regardless of HTTP outcome — failures
 * are logged but do not surface to the host (push is a "nice to have"
 * notification channel, not the source of truth).
 */
export async function notifyLessonStarted(scheduledLessonId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const session = (await supabase.auth.getSession()).data.session;
    const token = session?.access_token;
    if (!token) return;
    const res = await fetch('/api/push/lesson-started', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ scheduledLessonId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[IV] notifyLessonStarted failed:', res.status, body);
    }
  } catch (err) {
    console.warn('[IV] notifyLessonStarted error:', err);
  }
}

export async function endLesson(id: string): Promise<void> {
  assertLessonController();
  await assertLessonTitular(id);
  await updateScheduledLesson(id, {
    status: 'completed',
    ended_at: new Date().toISOString(),
  });
}

export async function cancelLesson(id: string): Promise<void> {
  assertLessonController();
  await assertLessonTitular(id);
  await updateScheduledLesson(id, { status: 'cancelled' });
}

export async function countByStatus(): Promise<Record<LessonStatus, number>> {
  const all = await listScheduledLessons();
  return {
    scheduled: all.filter((s) => s.status === 'scheduled').length,
    in_progress: all.filter((s) => s.status === 'in_progress').length,
    completed: all.filter((s) => s.status === 'completed').length,
    cancelled: all.filter((s) => s.status === 'cancelled').length,
  };
}
