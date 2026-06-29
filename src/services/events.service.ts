/**
 * events.service — centralized cross-cutting emitter for swap and substitution flows.
 *
 * Writes audit log entries for swap/substitution lifecycle events. Web Push
 * delivery is **NOT** done here — that runs server-side via the Netlify cron
 * `push-events.ts` (see netlify/functions/push-events.ts). The cron is the only
 * reliable path because it works even when the actor's PWA is closed and it
 * cannot be blocked by the `/api/push/send` coordenacao-only authorization.
 *
 * All side-effects are best-effort: failures are swallowed and never break the
 * primary mutation.
 */

import type { LessonSwapRequest, ScheduledLesson } from '../types';
import { writeAuditLog } from './audit.service';

async function safeAudit(input: Parameters<typeof writeAuditLog>[0]): Promise<void> {
  try {
    await writeAuditLog(input);
  } catch {
    /* audit best-effort */
  }
}

// ── Swap lifecycle ──────────────────────────────────────────────────────────

export interface SwapRequestedContext {
  swap: LessonSwapRequest;
  requesterName: string;
}

/** Audit a newly-created swap request. Push is dispatched by the server cron. */
export async function emitSwapRequested(ctx: SwapRequestedContext): Promise<void> {
  // requesterName kept for API compatibility; not used in audit details.
  void ctx.requesterName;
  const { swap } = ctx;
  await safeAudit({
    actor_id: swap.requester_id,
    action: 'swap.requested',
    entity: 'lesson_swap_requests',
    entity_id: swap.id,
    details: {
      target_id: swap.target_id,
      scheduled_lesson_id: swap.scheduled_lesson_id,
    },
  });
}

export interface SwapResponseContext {
  swap: LessonSwapRequest;
  /** Display name of the professor who responded (target). */
  responderName?: string;
  /** Optional human-readable lesson timestamp (e.g. "23 abr, 14:30"). */
  whenLabel?: string;
}

/** Audit a swap acceptance. Push is dispatched by the server cron. */
export async function emitSwapAccepted(ctx: SwapResponseContext): Promise<void> {
  const { swap } = ctx;
  void ctx.responderName; void ctx.whenLabel;
  await safeAudit({
    actor_id: swap.target_id,
    action: 'swap.accepted',
    entity: 'lesson_swap_requests',
    entity_id: swap.id,
    details: {
      requester_id: swap.requester_id,
      scheduled_lesson_id: swap.scheduled_lesson_id,
    },
  });
}

/** Audit a swap rejection. Push is dispatched by the server cron. */
export async function emitSwapRejected(ctx: SwapResponseContext): Promise<void> {
  const { swap } = ctx;
  void ctx.responderName;
  await safeAudit({
    actor_id: swap.target_id,
    action: 'swap.rejected',
    entity: 'lesson_swap_requests',
    entity_id: swap.id,
    details: {
      requester_id: swap.requester_id,
      scheduled_lesson_id: swap.scheduled_lesson_id,
    },
  });
}

// ── Lesson reassignment / substitution ──────────────────────────────────────

export interface LessonReassignedContext {
  lesson: Pick<ScheduledLesson, 'id' | 'class_id' | 'scheduled_at'>;
  previousProfessorId: string | null;
  newProfessorId: string;
  /** Who triggered the reassignment (coordinator id) — null if system. */
  actorId: string | null;
  /** Free-text reason (e.g. "Substituição emergencial"). */
  reason?: string | null;
  className?: string;
  whenLabel?: string;
}

/**
 * Emit when a scheduled lesson's professor is changed (substitution or coord override).
 * Notifies the new professor and writes an audit entry.
 */
export async function emitLessonReassigned(ctx: LessonReassignedContext): Promise<void> {
  const { lesson, previousProfessorId, newProfessorId, actorId, reason } = ctx;
  void ctx.className; void ctx.whenLabel;
  // The DB trigger `record_lesson_assignment_change` writes a row to
  // `lesson_assignment_history` with kind='substitution', which the cron
  // `push-events.ts` picks up to deliver the push. Here we only audit.
  await safeAudit({
    actor_id: actorId,
    action: 'lesson.reassigned',
    entity: 'scheduled_lessons',
    entity_id: lesson.id,
    details: {
      previous_professor_id: previousProfessorId,
      new_professor_id: newProfessorId,
      scheduled_at: lesson.scheduled_at,
      reason: reason ?? null,
    },
  });
}
