import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type {
  Attendance, AttendanceInsert, AttendanceUpdate,
  AttendanceStatus,
} from '../types';

// ── localStorage key ─────────────────────────────────────────────────────────

const LS_ATTENDANCE = 'iv_attendance';

function getStored(): Attendance[] {
  try {
    return JSON.parse(localStorage.getItem(LS_ATTENDANCE) || '[]');
  } catch {
    return [];
  }
}

function save(items: Attendance[]) {
  localStorage.setItem(LS_ATTENDANCE, JSON.stringify(items));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listByScheduledLesson(scheduledLessonId: string): Promise<Attendance[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('attendance') as any)
      .select('*')
      .eq('scheduled_lesson_id', scheduledLessonId);
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored().filter((a) => a.scheduled_lesson_id === scheduledLessonId);
}

export async function listByStudent(studentId: string): Promise<Attendance[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', studentId);
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored().filter((a) => a.student_id === studentId);
}

export async function getAttendance(scheduledLessonId: string, studentId: string): Promise<Attendance | null> {
  if (isSupabaseConfigured) {
    // Use maybeSingle() to avoid 406 when no row exists (which is a normal case
    // for students who haven't joined yet). single() throws 406 PGRST116.
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('scheduled_lesson_id', scheduledLessonId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStored().find(
    (a) => a.scheduled_lesson_id === scheduledLessonId && a.student_id === studentId,
  ) || null;
}

export async function createAttendance(input: AttendanceInsert): Promise<Attendance> {
  assertOnline();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('attendance') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  // Check duplicate
  const existing = getStored();
  if (existing.some(
    (a) => a.scheduled_lesson_id === input.scheduled_lesson_id && a.student_id === input.student_id,
  )) {
    throw new Error('Registro de presença já existe para este aluno nesta aula.');
  }
  const att: Attendance = {
    id: crypto.randomUUID(),
    scheduled_lesson_id: input.scheduled_lesson_id,
    student_id: input.student_id,
    status: input.status || 'absent',
    joined_at: input.joined_at || null,
    left_at: input.left_at || null,
    duration_seconds: input.duration_seconds || null,
    marked_by: input.marked_by || null,
    notes: input.notes || null,
    verified_checks: input.verified_checks ?? 0,
    total_checks: input.total_checks ?? 0,
  };
  existing.push(att);
  save(existing);
  return att;
}

export async function updateAttendance(id: string, updates: AttendanceUpdate): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('attendance') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const items = getStored();
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error('Registro de presença não encontrado.');
  items[idx] = { ...items[idx], ...updates };
  save(items);
}

export async function upsertAttendance(
  scheduledLessonId: string,
  studentId: string,
  updates: Partial<Omit<Attendance, 'id' | 'scheduled_lesson_id' | 'student_id'>>,
): Promise<Attendance> {
  assertOnline();
  if (isSupabaseConfigured) {
    // Atomic INSERT ... ON CONFLICT DO UPDATE — avoids 2 round-trips
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('attendance') as any)
      .upsert(
        {
          scheduled_lesson_id: scheduledLessonId,
          student_id: studentId,
          ...updates,
        },
        { onConflict: 'scheduled_lesson_id,student_id', ignoreDuplicates: false },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as Attendance;
  }

  // localStorage fallback — handle TOCTOU: re-read after update to avoid stale merged object
  const existing = await getAttendance(scheduledLessonId, studentId);
  if (existing) {
    await updateAttendance(existing.id, updates);
    // Re-read to return the actual persisted record (M8)
    const updated = await getAttendance(scheduledLessonId, studentId);
    return updated ?? { ...existing, ...updates };
  }
  return createAttendance({
    scheduled_lesson_id: scheduledLessonId,
    student_id: studentId,
    ...updates,
  });
}

// ── Incremental flush (race-safe) ────────────────────────────────────────────
// Calls the SQL function `attendance_increment_duration` which sums
// duration_seconds, verified_checks and total_checks server-side. Pass only
// DELTAS since the last successful flush (the client must track what was
// already sent). Status/notes are absolute; pass null to preserve the
// existing value (intermediate flushes do this so a transient `absent`
// doesn't clobber the final decision).
//
// Used by ClassroomView.recordAttendanceLeave to avoid lost-updates when
// multiple tabs / visibilitychange / beforeunload fire concurrent flushes.

export interface AttendanceFlushDelta {
  deltaSeconds: number;
  verifiedChecksDelta?: number;
  totalChecksDelta?: number;
  joinedAt?: string | null;
  leftAt?: string | null;
  status?: AttendanceStatus | null;
  notes?: string | null;
  markedBy?: string | null;
  /** UUID v4 gerado pelo cliente por flush (e reutilizado em retries do mesmo
   *  segmento). O RPC ignora chamadas com mesmo `request_id` já aplicado,
   *  garantindo idempotência ponta-a-ponta (BUG F da auditoria). */
  requestId?: string | null;
}

export async function flushAttendanceProgress(
  scheduledLessonId: string,
  studentId: string,
  delta: AttendanceFlushDelta,
): Promise<Attendance> {
  // Defensive guards — RPC also rejects but failing fast helps tests/dev.
  const deltaSeconds = Math.max(0, Math.round(delta.deltaSeconds));
  const verifiedDelta = Math.max(0, Math.round(delta.verifiedChecksDelta ?? 0));
  const totalDelta = Math.max(0, Math.round(delta.totalChecksDelta ?? 0));

  if (isSupabaseConfigured) {
    assertOnline();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)('attendance_increment_duration', {
      p_lesson_id: scheduledLessonId,
      p_student_id: studentId,
      p_delta_seconds: deltaSeconds,
      p_verified_checks_delta: verifiedDelta,
      p_total_checks_delta: totalDelta,
      p_left_at: delta.leftAt ?? null,
      p_joined_at: delta.joinedAt ?? null,
      p_status: delta.status ?? null,
      p_notes: delta.notes ?? null,
      p_marked_by: delta.markedBy ?? null,
      p_request_id: delta.requestId ?? null,
    });
    if (error) throw new Error(error.message);
    // Supabase wraps a single-row return as an object; normalise to that shape.
    return (Array.isArray(data) ? data[0] : data) as Attendance;
  }

  // localStorage fallback — emulate the additive semantics so dev mode behaves
  // the same as production. Note: not concurrency-safe (single tab assumed).
  const existing = await getAttendance(scheduledLessonId, studentId);
  const next: Attendance = existing
    ? {
        ...existing,
        duration_seconds: (existing.duration_seconds ?? 0) + deltaSeconds,
        verified_checks: existing.verified_checks + verifiedDelta,
        total_checks: existing.total_checks + totalDelta,
        left_at: delta.leftAt ?? existing.left_at,
        joined_at:
          // earliest known joined_at
          existing.joined_at && delta.joinedAt
            ? (new Date(existing.joined_at) < new Date(delta.joinedAt) ? existing.joined_at : delta.joinedAt)
            : (existing.joined_at ?? delta.joinedAt ?? null),
        status: delta.status ?? existing.status,
        notes: delta.status != null ? (delta.notes ?? null) : existing.notes,
        marked_by: delta.markedBy ?? existing.marked_by,
      }
    : {
        id: crypto.randomUUID(),
        scheduled_lesson_id: scheduledLessonId,
        student_id: studentId,
        status: delta.status ?? 'present',
        joined_at: delta.joinedAt ?? null,
        left_at: delta.leftAt ?? null,
        duration_seconds: deltaSeconds,
        marked_by: delta.markedBy ?? null,
        notes: delta.notes ?? null,
        verified_checks: verifiedDelta,
        total_checks: totalDelta,
      };
  const all = getStored().filter(
    (a) => !(a.scheduled_lesson_id === scheduledLessonId && a.student_id === studentId),
  );
  all.push(next);
  save(all);
  return next;
}

// ── Marks ────────────────────────────────────────────────────────────────────

/**
 * Call the idempotent `attendance_upsert_with_key` RPC. Falls back to the
 * legacy PostgREST upsert if the RPC is unavailable (older deploy / offline).
 */
async function markWithKey(
  scheduledLessonId: string,
  studentId: string,
  status: AttendanceStatus,
  markedBy: string,
  requestId?: string | null,
  opts?: { notes?: string | null; makeupDeadline?: string | null },
): Promise<Attendance> {
  if (isSupabaseConfigured && requestId) {
    assertOnline();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)('attendance_upsert_with_key', {
      p_lesson_id:           scheduledLessonId,
      p_student_id:          studentId,
      p_request_id:          requestId,
      p_status:              status,
      p_marked_by:           markedBy,
      p_notes:               opts?.notes ?? null,
      p_makeup_deadline:     opts?.makeupDeadline ?? null,
      p_manually_overridden: true,
    });
    if (!error) return data as Attendance;
    // RPC unavailable (pre-043 deploy) — fall through to legacy upsert.
    console.warn('[attendance] attendance_upsert_with_key unavailable, falling back:', error.message);
  }
  return upsertAttendance(scheduledLessonId, studentId, {
    status,
    ...(status === 'present' ? { joined_at: new Date().toISOString() } : {}),
    marked_by: markedBy,
    manually_overridden: true,
    notes: opts?.notes ?? null,
    ...(opts?.makeupDeadline != null ? { makeup_deadline: opts.makeupDeadline } : {}),
  });
}

export async function markPresent(
  scheduledLessonId: string,
  studentId: string,
  markedBy: string,
  requestId?: string,
): Promise<Attendance> {
  return markWithKey(scheduledLessonId, studentId, 'present', markedBy, requestId ?? crypto.randomUUID());
}

export async function markAbsent(
  scheduledLessonId: string,
  studentId: string,
  markedBy: string,
  requestId?: string,
): Promise<Attendance> {
  return markWithKey(scheduledLessonId, studentId, 'absent', markedBy, requestId ?? crypto.randomUUID());
}

export async function markJustified(
  scheduledLessonId: string,
  studentId: string,
  markedBy: string,
  notes?: string,
  requestId?: string,
): Promise<Attendance> {
  // Compute the makeup deadline: next scheduled lesson of the same class - 24h.
  // Frozen at this moment — if the next lesson is rescheduled later, the
  // original obligation stands. Best-effort: if lookup fails or there is no
  // next lesson, deadline is null (no enforcement, but FJ is still recorded).
  //
  // Implementation: prefer the SQL function `compute_makeup_deadline` (single
  // source of truth, also reusable from cron jobs). Falls back to the JS
  // computation if the RPC is unavailable (older deploy / offline).
  let makeupDeadline: string | null = null;
  if (isSupabaseConfigured) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rpcDeadline, error: rpcError } = await (supabase as any)
        .rpc('compute_makeup_deadline', { p_scheduled_lesson_id: scheduledLessonId });
      if (!rpcError && rpcDeadline) {
        makeupDeadline = typeof rpcDeadline === 'string'
          ? rpcDeadline
          : new Date(rpcDeadline as unknown as string | number | Date).toISOString();
      } else if (rpcError) {
        // Fallback path (legacy clients without the migration applied).
        const { data: thisLesson } = await (supabase
          .from('scheduled_lessons') as any)
          .select('class_id, scheduled_at')
          .eq('id', scheduledLessonId)
          .maybeSingle();

        if (thisLesson?.class_id && thisLesson?.scheduled_at) {
          const { data: nextLesson } = await (supabase
            .from('scheduled_lessons') as any)
            .select('scheduled_at')
            .eq('class_id', thisLesson.class_id as string)
            .gt('scheduled_at', thisLesson.scheduled_at as string)
            .neq('status', 'cancelled')
            .order('scheduled_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (nextLesson?.scheduled_at) {
            const next = new Date(nextLesson.scheduled_at as string).getTime();
            makeupDeadline = new Date(next - 24 * 60 * 60 * 1000).toISOString();
          }
        }
      }
    } catch (e) {
      // Best-effort — proceed without deadline if lookup fails. Logged so
      // ops can investigate; the FJ itself is still recorded.
      console.warn('[markJustified] could not compute makeup_deadline:', e);
    }
  }

  return markWithKey(scheduledLessonId, studentId, 'justified', markedBy, requestId ?? crypto.randomUUID(), {
    notes: notes || null,
    makeupDeadline: makeupDeadline,
  });
}

// ── Reports / Aggregations ───────────────────────────────────────────────────

/**
 * List all FJ rows that still have an upcoming or recently-passed deadline.
 * Used by the coordination "em risco" panel to surface students who must
 * submit a makeup summary soon. Includes BOTH students who haven't watched
 * yet AND those who watched but didn't submit.
 *
 * Returns rows ordered by deadline ascending (most urgent first).
 */
export async function listJustifiedWithDeadline(opts?: {
  /** Only include rows where deadline is within the next N hours from now.
   *  Pass undefined to get all (including already expired). */
  withinHours?: number;
  /** Restrict to a single class. */
  classId?: string;
}): Promise<Attendance[]> {
  if (!isSupabaseConfigured) return [];
  let query = supabase
    .from('attendance')
    .select('*, scheduled_lessons!inner(class_id)')
    .eq('status', 'justified')
    .not('makeup_deadline', 'is', null)
    .order('makeup_deadline', { ascending: true });

  if (opts?.withinHours != null) {
    const limit = new Date(Date.now() + opts.withinHours * 3_600_000).toISOString();
    query = query.lte('makeup_deadline', limit);
  }
  if (opts?.classId) {
    query = query.eq('scheduled_lessons.class_id', opts.classId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Attendance[];
}

export interface AttendanceStats {
  total: number;
  present: number;
  absent: number;
  justified: number;
  percentage: number;
}

export async function getStudentStats(studentId: string): Promise<AttendanceStats> {
  const records = await listByStudent(studentId);
  const total = records.length;
  const present = records.filter((r) => r.status === 'present').length;
  const absent = records.filter((r) => r.status === 'absent').length;
  const justified = records.filter((r) => r.status === 'justified').length;
  return {
    total,
    present,
    absent,
    justified,
    percentage: total > 0 ? Math.round((present / total) * 100) : 0,
  };
}

export async function getLessonStats(scheduledLessonId: string): Promise<AttendanceStats> {
  const records = await listByScheduledLesson(scheduledLessonId);
  const total = records.length;
  const present = records.filter((r) => r.status === 'present').length;
  const absent = records.filter((r) => r.status === 'absent').length;
  const justified = records.filter((r) => r.status === 'justified').length;
  return {
    total,
    present,
    absent,
    justified,
    percentage: total > 0 ? Math.round((present / total) * 100) : 0,
  };
}

/** Get attendance records for multiple scheduled lessons (batch) */
export async function listByScheduledLessonIds(ids: string[]): Promise<Attendance[]> {
  if (ids.length === 0) return [];
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .in('scheduled_lesson_id', ids);
    if (error) throw new Error(error.message);
    return data || [];
  }
  const idSet = new Set(ids);
  return getStored().filter((a) => idSet.has(a.scheduled_lesson_id));
}
