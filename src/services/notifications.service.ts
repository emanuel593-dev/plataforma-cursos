import { listForNotifications, listMyAssignedLessons } from './schedule.service';
import { listVisibleAnnouncements } from './announcements.service';
import { listEnrollmentsByStudent, listClassesByProfessor, listClasses } from './classes.service';
import { listAllLessons } from './modules.service';
import { listAllSwapsForUser } from './swaps.service';
import { listAssignmentHistory } from './assignmentHistory.service';
import { listScheduledLessons } from './schedule.service';
import { listJustifiedWithDeadline, listByStudent as listAttendanceByStudent } from './attendance.service';
import { listAllSubmissions } from './makeup.service';
import { formatTime, formatDateTime } from '../lib/utils';
import { swr } from '../lib/swrCache';
import { supabase } from '../lib/supabase';
import type {
  Announcement, ScheduledLesson, Class, Lesson, LessonSwapRequest, LessonAssignmentHistory,
  Attendance, MakeupSubmission,
} from '../types';

export type NotificationKind =
  | 'announcement'
  | 'lesson'              // base "agendada" entry
  | 'lesson-reminder'     // 60 / 30 / 10 min lookahead
  | 'lesson-started'      // status flipped to in_progress
  | 'lesson-cancelled'    // status flipped to cancelled
  | 'lesson-reschedule'   // history kind=reschedule
  | 'lesson-reinstatement'// history kind=reinstatement
  | 'swap-incoming'       // someone requested a swap with me (target)
  | 'swap-accepted'       // my outgoing request got accepted
  | 'swap-rejected'       // my outgoing request got rejected
  | 'substitution'        // I was assigned as a substitute in a lesson
  | 'fj-assigned'         // student received an FJ — must watch + submit summary
  | 'makeup-d1-reminder'  // ~24h before makeup_deadline
  | 'makeup-submitted'    // coord/professor: a student submitted a summary for review
  | 'makeup-approved'     // student: their summary was approved
  | 'makeup-rejected';    // student: their summary was rejected (can resubmit)

export interface InAppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  /** When the notification became relevant (used for unread comparison & sort). */
  created_at: string;
  /** Secondary timestamp shown to the user — when the underlying event happens. */
  event_at?: string;
  link?: string;
}

export interface InAppNotificationResult {
  items: InAppNotification[];
  unreadCount: number;
}

// ── High-water mark storage ─────────────────────────────────────────────────

const LEGACY_ID_KEY_PREFIX = 'iv_notifications_seen_ids_';
const HWM_KEY_PREFIX = 'iv_notifications_last_seen_';
const PER_ITEM_KEY_PREFIX = 'iv_notifications_seen_extra_';
const SYS_DISPATCHED_KEY_PREFIX = 'iv_notifications_dispatched_';

function hwmKey(userId: string): string { return `${HWM_KEY_PREFIX}${userId}`; }
function perItemKey(userId: string): string { return `${PER_ITEM_KEY_PREFIX}${userId}`; }
function dispatchedKey(userId: string): string { return `${SYS_DISPATCHED_KEY_PREFIX}${userId}`; }

export function getLastSeenAt(userId: string): string {
  try {
    const v = localStorage.getItem(hwmKey(userId));
    if (v) return v;
    const legacy = localStorage.getItem(`${LEGACY_ID_KEY_PREFIX}${userId}`);
    if (legacy) {
      const baseline = new Date().toISOString();
      localStorage.setItem(hwmKey(userId), baseline);
      localStorage.removeItem(`${LEGACY_ID_KEY_PREFIX}${userId}`);
      return baseline;
    }
  } catch { /* noop */ }
  const baseline = new Date().toISOString();
  try { localStorage.setItem(hwmKey(userId), baseline); } catch { /* noop */ }
  return baseline;
}

export function setLastSeenAt(userId: string, iso: string): void {
  try { localStorage.setItem(hwmKey(userId), iso); } catch { /* noop */ }
}

function getPerItemSeen(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(perItemKey(userId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function savePerItemSeen(userId: string, set: Set<string>): void {
  const arr = Array.from(set).slice(-200);
  try { localStorage.setItem(perItemKey(userId), JSON.stringify(arr)); } catch { /* noop */ }
}

export function isItemUnread(userId: string, item: InAppNotification): boolean {
  const lastSeen = new Date(getLastSeenAt(userId)).getTime();
  if (new Date(item.created_at).getTime() <= lastSeen) return false;
  return !getPerItemSeen(userId).has(item.id);
}

export function markNotificationsSeen(userId: string, notificationIds: string[]): void {
  if (notificationIds.length === 0) return;
  const set = getPerItemSeen(userId);
  for (const id of notificationIds) set.add(id);
  savePerItemSeen(userId, set);
}

export function markAllSeen(userId: string, items: InAppNotification[]): void {
  const newest = items.reduce((acc, it) => {
    const t = new Date(it.created_at).getTime();
    return t > acc ? t : acc;
  }, new Date(getLastSeenAt(userId)).getTime());
  setLastSeenAt(userId, new Date(newest).toISOString());
  try { localStorage.removeItem(perItemKey(userId)); } catch { /* noop */ }
}

// ── Browser (system) notification dispatch ──────────────────────────────────

function getDispatched(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dispatchedKey(userId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveDispatched(userId: string, set: Set<string>): void {
  const arr = Array.from(set).slice(-300);
  try { localStorage.setItem(dispatchedKey(userId), JSON.stringify(arr)); } catch { /* noop */ }
}

export async function requestSystemNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/** Fire a native OS notification for unseen items not yet dispatched.
 * Prefers the active Service Worker (`registration.showNotification`) so the
 * notification is reliable on Android and survives the page going to bg/lock.
 * Falls back to `new Notification(...)` for non-PWA / no-SW environments.
 *
 * NOTE: When the user has an active Web Push subscription, all event-driven
 * notifications are delivered server-side via the Netlify cron `push-events.ts`.
 * To avoid double-firing (one local + one push for the same event), this
 * function early-returns when a push subscription exists. The in-app bell
 * still updates from polling/realtime; only the OS-level toast is skipped. */
export async function dispatchSystemNotifications(userId: string, items: InAppNotification[]): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  let registration: ServiceWorkerRegistration | null = null;
  try {
    if ('serviceWorker' in navigator) {
      registration = (await navigator.serviceWorker.getRegistration()) ?? null;
    }
  } catch { /* ignore */ }

  // Skip local dispatch when server-side push is active — the cron will
  // deliver the same event and we'd otherwise show two notifications.
  //
  // Safety net (telemetry-driven): if the push subscription exists but has
  // never delivered, OR last_delivery_at is older than 30 minutes AND we
  // recorded a recent failure, we *do* fall back to local. This rescues
  // users whose endpoint is silently dropping messages (FCM/APNS quirks,
  // browser quotas, etc.).
  try {
    if (registration && 'pushManager' in registration) {
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        let pushHealthy = true;
        try {
          const { data: row } = await supabase
            .from('push_subscriptions')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .select('last_delivery_at,last_failure_at' as any)
            .eq('endpoint', sub.endpoint)
            .maybeSingle();
          if (row) {
            const r = row as { last_delivery_at?: string | null; last_failure_at?: string | null };
            const lastOk   = r.last_delivery_at ? new Date(r.last_delivery_at).getTime() : 0;
            const lastFail = r.last_failure_at  ? new Date(r.last_failure_at).getTime()  : 0;
            const STALE_MS = 30 * 60 * 1000;
            // Unhealthy when: never delivered AND has failures, OR delivery
            // is stale and a more recent failure exists.
            if ((lastOk === 0 && lastFail > 0) || (Date.now() - lastOk > STALE_MS && lastFail > lastOk)) {
              pushHealthy = false;
            }
          }
        } catch { /* telemetry read is best-effort — assume healthy */ }
        if (pushHealthy) return;
      }
    }
  } catch { /* fall through to local dispatch */ }

  const dispatched = getDispatched(userId);
  const toFire = items.filter((it) => !dispatched.has(it.id) && isItemUnread(userId, it));
  if (toFire.length === 0) return;

  for (const item of toFire) {
    // Android-friendly vibration pattern. Critical reminders vibrate longer.
    const vibratePattern: number[] = item.kind === 'lesson-started'
      ? [200, 100, 200, 100, 400]
      : item.kind === 'lesson-reminder' || item.kind === 'substitution' || item.kind === 'swap-incoming'
        ? [200, 100, 200]
        : [120];
    const options: NotificationOptions = {
      body: item.message,
      tag: item.id,
      icon: '/logo-192.png',
      badge: '/logo-192.png',
      // Reminders are time-sensitive → renotify so the OS re-pings even if a
      // previous notification with the same tag was already shown.
      renotify: item.kind === 'lesson-reminder' || item.kind === 'lesson-started',
      requireInteraction: item.kind === 'lesson-started',
      // Don't silence anything on Android — silent:true makes notifications
      // arrive without any indication, which is the #1 complaint of PWA users.
      silent: false,
      vibrate: vibratePattern,
      data: {
        url: item.link || '/',
        actionUrl: item.link || '/',
        kind: item.kind,
        id: item.id,
      },
      actions: item.link
        ? [
            { action: 'open', title: item.kind === 'lesson-started' ? 'Entrar' : 'Abrir' },
            { action: 'dismiss', title: 'Dispensar' },
          ]
        : undefined,
    } as NotificationOptions;

    try {
      if (registration && registration.active) {
        await registration.showNotification(item.title, options);
      } else {
        // Direct API: actions are ignored here, but the basic toast still fires.
        const n = new Notification(item.title, options);
        if (item.link) {
          n.onclick = () => {
            window.focus();
            window.location.assign(item.link!);
            n.close();
          };
        }
      }
    } catch { /* permission race / quota */ }

    dispatched.add(item.id);
  }

  saveDispatched(userId, dispatched);
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapAnnouncementToNotification(item: Announcement): InAppNotification {
  return {
    id: `announcement:${item.id}`,
    kind: 'announcement',
    title: item.title,
    message: item.content,
    created_at: item.created_at,
    // Anchor to the Dashboard so the user lands on the announcements section.
    link: item.class_id ? `/turmas/${item.class_id}` : `/?aviso=${item.id}`,
  };
}

const REMINDER_OFFSETS_MIN = [60, 30, 10];

function expandLessonNotifications(
  lesson: ScheduledLesson,
  classMap: Record<string, Class>,
  lessonMap: Record<string, Lesson>,
  nowMs: number,
  /** When set, the 60/30/10-min reminders are emitted only if this user is the
   *  professor assigned to the lesson. Use for the professor role. */
  reminderForUserId: string | null = null,
): InAppNotification[] {
  const cls = classMap[lesson.class_id];
  const les = lesson.lesson_id ? lessonMap[lesson.lesson_id] : null;
  const className = cls?.name ?? 'Turma';
  const lessonTitle = les?.title ?? 'Aula livre';
  const link = `/turmas/${lesson.class_id}`;
  const out: InAppNotification[] = [];

  if (lesson.status === 'cancelled') {
    out.push({
      id: `lesson-cancelled:${lesson.id}`,
      kind: 'lesson-cancelled',
      title: 'Aula cancelada',
      message: `${lessonTitle} • ${className} (${formatDateTime(lesson.scheduled_at)}) foi cancelada.`,
      // Best signal we have for "when this status flip happened" is now()-ish.
      // Using scheduled_at keeps it stable across refreshes and lets HWM work.
      created_at: lesson.scheduled_at,
      event_at: lesson.scheduled_at,
      link,
    });
    return out;
  }

  if (lesson.status === 'in_progress' && lesson.started_at) {
    const effective = lesson.modality ?? cls?.modality ?? 'online';
    const isPresencial = effective === 'presencial';
    out.push({
      id: `lesson-started:${lesson.id}`,
      kind: 'lesson-started',
      title: isPresencial ? 'Aula presencial em andamento' : 'Aula ao vivo',
      message: isPresencial
        ? `${lessonTitle} • ${className} começou (presencial).`
        : `${lessonTitle} • ${className} começou. Toque para entrar.`,
      created_at: lesson.started_at,
      event_at: lesson.scheduled_at,
      link: !isPresencial && lesson.room_id ? `/sala/${lesson.room_id}?aula=${lesson.id}` : link,
    });
    return out;
  }

  // status === 'scheduled' — base entry + any reminders whose threshold passed.
  out.push({
    id: `lesson:${lesson.id}`,
    kind: 'lesson',
    title: 'Aula programada',
    message: `${lessonTitle} • ${className} • ${formatDateTime(lesson.scheduled_at)}`,
    created_at: lesson.created_at ?? lesson.scheduled_at,
    event_at: lesson.scheduled_at,
    link,
  });

  const scheduledMs = new Date(lesson.scheduled_at).getTime();
  const emitReminders = reminderForUserId === null
    || (lesson.professor_id != null && lesson.professor_id === reminderForUserId);

  if (emitReminders) {
    for (const minutes of REMINDER_OFFSETS_MIN) {
      const triggerMs = scheduledMs - minutes * 60_000;
      // Only include reminders whose trigger time has passed AND the lesson
      // hasn't started yet (so we don't keep showing "60 min" after the fact).
      if (triggerMs <= nowMs && scheduledMs > nowMs) {
        out.push({
          id: `lesson-reminder-${minutes}:${lesson.id}`,
          kind: 'lesson-reminder',
          title: `Lembrete: aula em ~${minutes} min`,
          message: `${lessonTitle} • ${className} começa às ${formatTime(lesson.scheduled_at)}.`,
          created_at: new Date(triggerMs).toISOString(),
          event_at: lesson.scheduled_at,
          link,
        });
      }
    }
  }

  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

function mapSwapToNotifications(
  swap: LessonSwapRequest,
  userId: string,
  scheduledById: Record<string, ScheduledLesson>,
  classMap: Record<string, Class>,
  lessonMap: Record<string, Lesson>,
): InAppNotification[] {
  const sl = scheduledById[swap.scheduled_lesson_id];
  if (!sl) return [];
  const cls = classMap[sl.class_id];
  const les = sl.lesson_id ? lessonMap[sl.lesson_id] : null;
  const className = cls?.name ?? 'Turma';
  const lessonTitle = les?.title ?? 'Aula livre';
  const link = `/calendario`;
  const out: InAppNotification[] = [];

  // Incoming pending request: I'm the target
  if (swap.status === 'pending' && swap.target_id === userId) {
    out.push({
      id: `swap-incoming:${swap.id}`,
      kind: 'swap-incoming',
      title: 'Solicitação de troca de aula',
      message: `Um colega pediu troca de "${lessonTitle}" • ${className} (${formatDateTime(sl.scheduled_at)}).`,
      created_at: swap.created_at,
      event_at: sl.scheduled_at,
      link,
    });
  }

  // Resolved request: I'm the requester and got a response
  if (swap.requester_id === userId && swap.responded_at) {
    if (swap.status === 'accepted') {
      out.push({
        id: `swap-accepted:${swap.id}`,
        kind: 'swap-accepted',
        title: 'Troca aceita',
        message: `Sua solicitação de troca para "${lessonTitle}" • ${className} (${formatDateTime(sl.scheduled_at)}) foi aceita.`,
        created_at: swap.responded_at,
        event_at: sl.scheduled_at,
        link,
      });
    } else if (swap.status === 'rejected') {
      out.push({
        id: `swap-rejected:${swap.id}`,
        kind: 'swap-rejected',
        title: 'Troca recusada',
        message: `Sua solicitação para "${lessonTitle}" • ${className} (${formatDateTime(sl.scheduled_at)}) foi recusada.`,
        created_at: swap.responded_at,
        event_at: sl.scheduled_at,
        link,
      });
    }
  }

  return out;
}

function mapSubstitutionToNotification(
  h: LessonAssignmentHistory,
  userId: string,
  scheduledById: Record<string, ScheduledLesson>,
  classMap: Record<string, Class>,
  lessonMap: Record<string, Lesson>,
): InAppNotification | null {
  // Only notify the new assignee, when it is a substitution and the user IS the new prof.
  if (h.new_professor_id !== userId) return null;
  if (h.kind !== 'substitution') return null;
  const sl = scheduledById[h.scheduled_lesson_id];
  if (!sl) return null;
  const cls = classMap[sl.class_id];
  const les = sl.lesson_id ? lessonMap[sl.lesson_id] : null;
  const className = cls?.name ?? 'Turma';
  const lessonTitle = les?.title ?? 'Aula livre';
  return {
    id: `substitution:${h.id}`,
    kind: 'substitution',
    title: 'Você foi designado(a) como substituto(a)',
    message: `Aula "${lessonTitle}" • ${className} em ${formatDateTime(sl.scheduled_at)}.${h.reason ? ` Motivo: ${h.reason}` : ''}`,
    created_at: h.created_at,
    event_at: sl.scheduled_at,
    link: `/calendario`,
  };
}

/** History kinds that should appear in the bell for everyone in the affected
 *  class (professors + students). Used for reschedule and reinstatement. */
function mapClassEventToNotification(
  h: LessonAssignmentHistory,
  scheduledById: Record<string, ScheduledLesson>,
  classMap: Record<string, Class>,
  lessonMap: Record<string, Lesson>,
  visibleClassIds: Set<string> | null,
): InAppNotification | null {
  if (h.kind !== 'reschedule' && h.kind !== 'reinstatement') return null;
  const sl = scheduledById[h.scheduled_lesson_id];
  if (!sl) return null;
  if (visibleClassIds && !visibleClassIds.has(sl.class_id)) return null;
  const cls = classMap[sl.class_id];
  const les = sl.lesson_id ? lessonMap[sl.lesson_id] : null;
  const className = cls?.name ?? 'Turma';
  const lessonTitle = les?.title ?? 'Aula livre';
  if (h.kind === 'reschedule') {
    return {
      id: `lesson-reschedule:${h.id}`,
      kind: 'lesson-reschedule',
      title: 'Aula reagendada',
      message: `"${lessonTitle}" • ${className} foi reagendada para ${formatDateTime(sl.scheduled_at)}.${h.reason ? ` Motivo: ${h.reason}` : ''}`,
      created_at: h.created_at,
      event_at: sl.scheduled_at,
      link: `/turmas/${sl.class_id}`,
    };
  }
  return {
    id: `lesson-reinstatement:${h.id}`,
    kind: 'lesson-reinstatement',
    title: 'Aula reativada',
    message: `"${lessonTitle}" • ${className} foi reativada para ${formatDateTime(sl.scheduled_at)}.`,
    created_at: h.created_at,
    event_at: sl.scheduled_at,
    link: `/turmas/${sl.class_id}`,
  };
}

/** Student-facing entries derived from their own attendance rows:
 *   - fj-assigned        whenever attendance.status='justified' (one entry per FJ)
 *   - makeup-d1-reminder when makeup_deadline is within ~24h
 *  Both rely on `marked_at` / `makeup_deadline` for ordering. */
function mapAttendanceToNotifications(
  rows: Attendance[],
  scheduledById: Record<string, ScheduledLesson>,
  classMap: Record<string, Class>,
  lessonMap: Record<string, Lesson>,
  nowMs: number,
): InAppNotification[] {
  const out: InAppNotification[] = [];
  for (const a of rows) {
    if (a.status !== 'justified') continue;
    const sl = scheduledById[a.scheduled_lesson_id];
    if (!sl) continue;
    const cls = classMap[sl.class_id];
    const les = sl.lesson_id ? lessonMap[sl.lesson_id] : null;
    const className = cls?.name ?? 'Turma';
    const lessonTitle = les?.title ?? 'Aula livre';
    const link = `/turmas/${sl.class_id}?tab=reposicao`;

    // Base FJ entry — stable id so the user can dismiss it.
    // attendance has no marked_at/created_at column; we use the makeup_deadline
    // (or the lesson's scheduled_at as fallback) as the timestamp anchor so
    // HWM dedupe works deterministically across reloads.
    const anchorIso = a.makeup_deadline ?? sl.scheduled_at;
    out.push({
      id: `fj-assigned:${a.id}`,
      kind: 'fj-assigned',
      title: 'Falta justificada registrada',
      message: a.makeup_deadline
        ? `${lessonTitle} • ${className}. Assista a gravação e envie o resumo até ${formatDateTime(a.makeup_deadline)}.`
        : `${lessonTitle} • ${className}. Assista a gravação e envie o resumo o quanto antes.`,
      created_at: anchorIso,
      event_at: a.makeup_deadline ?? sl.scheduled_at,
      link,
    });

    // D-1 reminder — only if deadline is within next 24h and not yet expired.
    if (a.makeup_deadline) {
      const dlMs = new Date(a.makeup_deadline).getTime();
      const diffMs = dlMs - nowMs;
      if (diffMs > 0 && diffMs <= 24 * 60 * 60 * 1000) {
        // Stable per-day key so a refresh doesn't move the unread state.
        const dayKey = a.makeup_deadline.slice(0, 10);
        out.push({
          id: `makeup-d1:${a.id}:${dayKey}`,
          kind: 'makeup-d1-reminder',
          title: 'Reposição vence em breve',
          message: `Último dia para enviar o resumo de "${lessonTitle}" • ${className} (${formatDateTime(a.makeup_deadline)}).`,
          // Anchor 24h before deadline so HWM logic treats it as a fresh event.
          created_at: new Date(dlMs - 24 * 60 * 60 * 1000).toISOString(),
          event_at: a.makeup_deadline,
          link,
        });
      }
    }
  }
  return out;
}

/** Student-facing entries from their own makeup submissions:
 *   - makeup-approved when status='approved'
 *   - makeup-rejected when status='rejected' (can resubmit)
 *  Coord-facing: makeup-submitted when status='submitted' and not yet reviewed. */
function mapMakeupToNotifications(
  rows: MakeupSubmission[],
  audience: 'student' | 'staff',
  scheduledById: Record<string, ScheduledLesson>,
  classMap: Record<string, Class>,
  lessonMap: Record<string, Lesson>,
): InAppNotification[] {
  const out: InAppNotification[] = [];
  for (const s of rows) {
    const sl = s.scheduled_lesson_id ? scheduledById[s.scheduled_lesson_id] : undefined;
    const cls = sl ? classMap[sl.class_id] : (s.class_id ? classMap[s.class_id] : undefined);
    const les = sl?.lesson_id ? lessonMap[sl.lesson_id] : null;
    const className = cls?.name ?? 'Turma';
    const lessonTitle = les?.title ?? 'aula';
    const classId = sl?.class_id ?? s.class_id ?? '';

    if (audience === 'student') {
      if (s.status === 'approved') {
        out.push({
          id: `makeup-approved:${s.id}`,
          kind: 'makeup-approved',
          title: 'Reposição aprovada',
          message: `Seu resumo de "${lessonTitle}" • ${className} foi aprovado.`,
          created_at: s.reviewed_at ?? s.updated_at,
          link: classId ? `/turmas/${classId}?tab=reposicao` : '/gravacoes',
        });
      } else if (s.status === 'rejected') {
        out.push({
          id: `makeup-rejected:${s.id}`,
          kind: 'makeup-rejected',
          title: 'Reposição reprovada',
          message: `Seu resumo de "${lessonTitle}" • ${className} foi reprovado.${s.reviewer_notes ? ` Comentário: ${s.reviewer_notes}` : ' Você pode revisar e reenviar.'}`,
          created_at: s.reviewed_at ?? s.updated_at,
          link: classId ? `/turmas/${classId}?tab=reposicao` : '/gravacoes',
        });
      }
    } else {
      // staff: notify each freshly submitted entry awaiting review.
      if (s.status === 'submitted') {
        out.push({
          id: `makeup-submitted:${s.id}`,
          kind: 'makeup-submitted',
          title: 'Nova reposição para revisar',
          message: `Resumo de "${lessonTitle}" • ${className} aguarda revisão.`,
          created_at: s.submitted_at ?? s.updated_at,
          link: '/reposicoes',
        });
      }
    }
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function listInAppNotifications(userId: string, role: string, limit = 12): Promise<InAppNotificationResult> {
  let classIds: string[] | undefined = undefined;
  let myAssignedLessons: ScheduledLesson[] = [];

  if (role === 'aluno') {
    const enrollments = await listEnrollmentsByStudent(userId);
    classIds = enrollments.filter((e) => e.status === 'active').map((e) => e.class_id);
  } else if (role === 'professor') {
    const myCls = await listClassesByProfessor(userId);
    classIds = myCls.map((c) => c.id);
    // Lessons explicitly assigned to this professor (± 12h window).
    const now = Date.now();
    myAssignedLessons = await listMyAssignedLessons(userId, {
      fromIso: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
      toIso:   new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    });
  }

  const isProfessorOrCoord = role === 'professor' || role === 'coordenacao';
  const isCoord            = role === 'coordenacao';
  const isStudent          = role === 'aluno';

  // SWR-cached: classes/lessons change rarely but are read on every Realtime
  // tick during peak (6 lessons starting simultaneously fan-out one
  // notifications fetch per active client). 60 s freshness with 30 s
  // background refresh keeps numbers tight without thundering-herd queries.
  const cachedListClasses = () =>
    swr('iv:notif:classes', listClasses, { maxAgeMs: 60_000, staleAfterMs: 30_000 });
  const cachedListAllLessons = () =>
    swr('iv:notif:allLessons', listAllLessons, { maxAgeMs: 60_000, staleAfterMs: 30_000 });

  const [
    announcements, lessons, allClasses, allLessons,
    mySwaps, myHistory, allScheduled,
    studentAttendance, studentMakeupSubs, staffSubmissionsToReview,
  ] = await Promise.all([
    listVisibleAnnouncements(limit),
    listForNotifications({ classIds }),
    cachedListClasses(),
    cachedListAllLessons(),
    isProfessorOrCoord
      ? listAllSwapsForUser(userId).catch(() => [] as LessonSwapRequest[])
      : Promise.resolve([] as LessonSwapRequest[]),
    // History feed: substitutions (assignee), reschedule/reinstatement (everyone in class)
    listAssignmentHistory({ limit: 100 }).catch(() => [] as LessonAssignmentHistory[]),
    // For class-event mapping we need scheduled_lessons → class_id resolution
    listScheduledLessons().catch(() => [] as ScheduledLesson[]),
    // Student-facing FJ + D-1 reminder source
    isStudent
      ? listAttendanceByStudent(userId).catch(() => [] as Attendance[])
      : Promise.resolve([] as Attendance[]),
    // Student-facing makeup approval/rejection
    isStudent
      ? listAllSubmissions({ studentId: userId, limit: 50 }).catch(() => [] as MakeupSubmission[])
      : Promise.resolve([] as MakeupSubmission[]),
    // Coord-facing: submissions awaiting review
    isCoord
      ? listAllSubmissions({ status: 'submitted', limit: 50 }).catch(() => [] as MakeupSubmission[])
      : Promise.resolve([] as MakeupSubmission[]),
  ]);

  const classMap = Object.fromEntries(allClasses.map((c) => [c.id, c])) as Record<string, Class>;
  const lessonMap = Object.fromEntries(allLessons.map((l) => [l.id, l])) as Record<string, Lesson>;
  const scheduledById = Object.fromEntries(allScheduled.map((s) => [s.id, s])) as Record<string, ScheduledLesson>;
  const nowMs = Date.now();

  // Merge: include all class-relevant lessons + any explicitly-assigned lesson.
  const lessonsById = new Map<string, ScheduledLesson>();
  for (const l of lessons) lessonsById.set(l.id, l);
  for (const l of myAssignedLessons) lessonsById.set(l.id, l);

  // For professors, restrict reminders to lessons they're assigned to. Other
  // class lessons remain visible ("agendada" entries) but don't generate the
  // 60/30/10-min reminders that escalate to OS notifications for them.
  const restrictRemindersToAssignee = role === 'professor';

  const swapItems: InAppNotification[] = mySwaps.flatMap((s) =>
    mapSwapToNotifications(s, userId, scheduledById, classMap, lessonMap),
  );
  const substitutionItems: InAppNotification[] = myHistory
    .map((h) => mapSubstitutionToNotification(h, userId, scheduledById, classMap, lessonMap))
    .filter((x): x is InAppNotification => x !== null);

  // Class events (reschedule, reinstatement) → visible to coord (all classes)
  // or to professor/student (only their classes).
  const visibleClassIds = isCoord
    ? null
    : new Set<string>(classIds ?? []);
  const classEventItems: InAppNotification[] = myHistory
    .map((h) => mapClassEventToNotification(h, scheduledById, classMap, lessonMap, visibleClassIds))
    .filter((x): x is InAppNotification => x !== null);

  const attendanceItems: InAppNotification[] = isStudent
    ? mapAttendanceToNotifications(studentAttendance, scheduledById, classMap, lessonMap, nowMs)
    : [];

  const studentMakeupItems: InAppNotification[] = isStudent
    ? mapMakeupToNotifications(studentMakeupSubs, 'student', scheduledById, classMap, lessonMap)
    : [];

  const staffMakeupItems: InAppNotification[] = isCoord
    ? mapMakeupToNotifications(staffSubmissionsToReview, 'staff', scheduledById, classMap, lessonMap)
    : [];

  const items: InAppNotification[] = [
    ...announcements.map(mapAnnouncementToNotification),
    ...[...lessonsById.values()].flatMap((l) => expandLessonNotifications(
      l, classMap, lessonMap, nowMs,
      restrictRemindersToAssignee ? userId : null,
    )),
    ...swapItems,
    ...substitutionItems,
    ...classEventItems,
    ...attendanceItems,
    ...studentMakeupItems,
    ...staffMakeupItems,
  ]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);

  const unreadCount = items.filter((item) => isItemUnread(userId, item)).length;

  return { items, unreadCount };
}
