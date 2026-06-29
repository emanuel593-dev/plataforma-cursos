// Pure core of the auto-attendance "join" upsert. Extracted from
// ClassroomView so unit tests can pin the Sprint 2 regression contract:
//
//   On REJOIN, status MUST NOT be overwritten. The previous final flush
//   may have set status='absent' (student left early); writing 'present'
//   here would silently revert that decision.
//
// Only `getAttendance` and `upsertAttendance` are injected so the caller
// (ClassroomView) supplies the real Supabase-backed implementations and
// tests supply spies. This keeps the helper free of React/Supabase
// imports.

import type { Attendance } from '../types';

export interface AttendanceJoinDeps {
  getAttendance: (scheduledLessonId: string, studentId: string) => Promise<Attendance | null>;
  upsertAttendance: (
    scheduledLessonId: string,
    studentId: string,
    updates: Partial<Omit<Attendance, 'id' | 'scheduled_lesson_id' | 'student_id'>>,
  ) => Promise<Attendance>;
}

export interface AttendanceJoinResult {
  /** Counters seeded from the persisted row (for UI thresholds). */
  priorDurationSeconds: number;
  priorVerifiedChecks: number;
  priorTotalChecks: number;
  /** True if this is the very first join (no row existed). */
  firstJoin: boolean;
}

export async function recordAttendanceJoinCore(
  deps: AttendanceJoinDeps,
  scheduledLessonId: string,
  studentId: string,
  nowIso: string = new Date().toISOString(),
): Promise<AttendanceJoinResult> {
  const existing = await deps.getAttendance(scheduledLessonId, studentId);

  const updates: Partial<Attendance> = {
    joined_at: existing?.joined_at ?? nowIso,
    marked_by: studentId,
  };
  // Only set status on the very first join. On any rejoin we leave it
  // alone so a prior flushAttendanceProgress decision (e.g. 'absent')
  // is not silently reverted to 'present'.
  if (!existing) updates.status = 'present';

  await deps.upsertAttendance(scheduledLessonId, studentId, updates);

  return {
    priorDurationSeconds: existing?.duration_seconds ?? 0,
    priorVerifiedChecks: existing?.verified_checks ?? 0,
    priorTotalChecks: existing?.total_checks ?? 0,
    firstJoin: !existing,
  };
}
