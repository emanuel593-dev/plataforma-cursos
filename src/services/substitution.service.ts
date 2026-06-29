/**
 * substitution.service — high-level orchestration for lesson professor reassignments.
 *
 * Two entry-points:
 *   • directSubstitute  — coordinator overrides a lesson's professor (edit modal)
 *   • swapSubstitute    — peer swap accepted (target accepts requester's request)
 *
 * Each atomically:
 *   1. Persists the change via schedule / swap service
 *   2. Fires push notification + audit log via events.service (best-effort)
 *
 * Callers receive the updated ScheduledLesson(s) for optimistic UI updates.
 */

import { updateScheduledLesson, getScheduledLesson } from './schedule.service';
import { acceptSwap } from './swaps.service';
import { emitLessonReassigned, emitSwapAccepted } from './events.service';
import type { LessonSwapRequest, ScheduledLesson } from '../types';

// ── Direct substitution (coordinator) ──────────────────────────────────────

export interface DirectSubstituteInput {
  lessonId: string;
  previousProfessorId: string | null;
  newProfessorId: string;
  actorId: string | null;
  /** Used for notification body and audit detail. */
  className?: string;
  /** Human-readable timestamp label, e.g. "28 abr, 14:30". */
  whenLabel?: string;
  classId: string;
  scheduledAt: string;
}

/**
 * Replace the professor of a single scheduled lesson.
 * Does nothing extra if previousProfessorId === newProfessorId.
 */
export async function directSubstitute(
  input: DirectSubstituteInput,
): Promise<void> {
  const {
    lessonId,
    previousProfessorId,
    newProfessorId,
    actorId,
    className,
    whenLabel,
    classId,
    scheduledAt,
  } = input;

  if (previousProfessorId === newProfessorId) return;

  // 1. Persist
  await updateScheduledLesson(lessonId, { professor_id: newProfessorId });

  // 2. Emit (best-effort — never throws)
  await emitLessonReassigned({
    lesson: { id: lessonId, class_id: classId, scheduled_at: scheduledAt },
    previousProfessorId,
    newProfessorId,
    actorId,
    className,
    whenLabel,
  });
}

// ── Swap-based substitution (peer acceptance) ────────────────────────────────

export interface SwapSubstituteInput {
  swap: LessonSwapRequest;
  /** Display name of the accepting professor (target). */
  responderName?: string;
  /** Human-readable timestamp label for the notification body. */
  whenLabel?: string;
}

export interface SwapSubstituteResult {
  /** The primary lesson, now assigned to the swap target. */
  primaryLesson: ScheduledLesson | null;
  /** The offered lesson (mutual swap), now assigned to the requester, or null. */
  offeredLesson: ScheduledLesson | null;
}

/**
 * Accept a swap request and re-assign the involved lesson(s).
 * Emits a push notification + audit entry to the original requester.
 */
export async function swapSubstitute(
  input: SwapSubstituteInput,
): Promise<SwapSubstituteResult> {
  const { swap, responderName, whenLabel } = input;

  // 1. Persist via swaps.service (handles lesson re-assignment + status update)
  await acceptSwap(swap.id);

  // 2. Emit (best-effort)
  await emitSwapAccepted({ swap, responderName, whenLabel });

  // 3. Fetch updated lesson(s) so caller can update local state
  const [primaryLesson, offeredLesson] = await Promise.all([
    getScheduledLesson(swap.scheduled_lesson_id),
    swap.offered_lesson_id ? getScheduledLesson(swap.offered_lesson_id) : Promise.resolve(null),
  ]);

  return { primaryLesson, offeredLesson };
}
