// Scheduled function: every minute, scan recent domain events and dispatch
// Web Push notifications to the right audience. Server-side dispatch is the
// only reliable path because it runs even when no client/PWA is open.
//
// Idempotency: a tiny `push_dispatch_log` table with a UNIQUE event_key
// guarantees that overlapping cron runs (or replays after a redeploy) never
// double-fire the same notification.
//
// Events covered:
//   - swap-incoming      (lesson_swap_requests where status=pending)
//   - swap-accepted      (status=accepted, responded_at recent)
//   - swap-rejected      (status=rejected, responded_at recent)
//   - substitution       (lesson_assignment_history kind=substitution)
//   - lesson-started     (scheduled_lessons status=in_progress, started_at recent)
//   - lesson-cancelled   (scheduled_lessons status=cancelled, scheduled_at recent)
//   - announcement       (announcements created_at recent)
//   - reschedule         (lesson_assignment_history kind=reschedule, recent)
//   - reinstatement      (lesson_assignment_history kind=reinstatement, recent)
//   - makeup-d1-reminder (attendance status=justified, makeup_deadline within next 24h)

import type { Config } from '@netlify/functions';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SITE_URL = process.env.URL ?? process.env.DEPLOY_URL ?? 'http://localhost:8888';

// Look-back window for events that have a created_at/responded_at/started_at
// timestamp. Generous enough to absorb missed cron runs (Netlify cron is
// "at least every X" with some skew).
const LOOKBACK_MS = 15 * 60 * 1000;
// Wider window for cancellations (no `cancelled_at` column — we have to
// trust the dispatch_log for dedupe). Limit to a few days so first deploy
// doesn't try to backfill ancient rows.
const CANCELLED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// ── Supabase REST helpers ──────────────────────────────────────────────────

const sbHeaders = {
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: SUPABASE_SERVICE_ROLE_KEY,
};

async function sbGet<T>(path: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`supabase GET ${path}: ${r.status} ${await r.text()}`);
  return await r.json() as T;
}

/** INSERT ... ON CONFLICT DO NOTHING RETURNING via PostgREST.
 *  Returns only the rows that were actually inserted (i.e. brand-new keys). */
async function claimEventKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const body = JSON.stringify(keys.map((event_key) => ({ event_key })));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/push_dispatch_log`, {
    method: 'POST',
    headers: {
      ...sbHeaders,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body,
  });
  if (!r.ok) {
    console.error('[IV push-events] claim failed', r.status, await r.text());
    return new Set();
  }
  const inserted = await r.json() as Array<{ event_key: string }>;
  return new Set(inserted.map((row) => row.event_key));
}

// ── Types ──────────────────────────────────────────────────────────────────

interface SwapRow {
  id: string;
  scheduled_lesson_id: string;
  requester_id: string;
  target_id: string;
  status: string;
  responded_at: string | null;
  created_at: string;
}
interface HistoryRow {
  id: string;
  scheduled_lesson_id: string;
  new_professor_id: string | null;
  reason: string | null;
  kind: string;
  created_at: string;
}
interface ScheduledLessonRow {
  id: string;
  class_id: string;
  lesson_id: string | null;
  professor_id: string | null;
  scheduled_at: string;
  started_at: string | null;
  status: string;
}
interface AnnouncementRow {
  id: string;
  class_id: string | null;
  title: string;
  content: string;
  created_at: string;
}
interface ClassRow { id: string; name: string; modality: 'online' | 'presencial' | 'hibrida' | null }
interface LessonRow { id: string; title: string }
interface ClassProfRow { class_id: string; professor_id: string }
interface ClassMonitorRow { class_id: string; monitor_id: string }
interface EnrollmentRow { class_id: string; student_id: string }
interface ProfileRow { id: string }
interface AttendanceFJRow {
  id: string;
  student_id: string;
  scheduled_lesson_id: string;
  makeup_deadline: string;
}
interface AuditLogAutoAbsentRow {
  id: string;
  entity_id: string; // attendance.id
  details: {
    student_id?: string;
    scheduled_lesson_id?: string;
    notes?: string | null;
  };
  created_at: string;
}

// ── Push dispatch ──────────────────────────────────────────────────────────

interface PushPayload {
  userIds: string[];
  title: string;
  body: string;
  url?: string;
  tag?: string;
  kind: string;
  requireInteraction?: boolean;
}

async function dispatch(payload: PushPayload): Promise<boolean> {
  if (payload.userIds.length === 0) return false;
  try {
    const r = await fetch(`${SITE_URL}/.netlify/functions/push-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch (e) {
    console.error('[IV push-events] dispatch failed', e);
    return false;
  }
}

// ── Audience expansion ─────────────────────────────────────────────────────

async function classAudience(classId: string, kind: 'professors' | 'all'): Promise<string[]> {
  const ids = new Set<string>();
  // class_professors → all professors of the class (modern multi-prof model)
  const profs = await sbGet<ClassProfRow[]>(
    `class_professors?class_id=eq.${classId}&select=professor_id`,
  );
  for (const p of profs) ids.add(p.professor_id);
  if (kind === 'all') {
    const enrolls = await sbGet<EnrollmentRow[]>(
      `enrollments?class_id=eq.${classId}&status=eq.active&select=student_id`,
    );
    for (const e of enrolls) ids.add(e.student_id);
    // Phase 1 monitor role: class monitors should also be notified about
    // class-wide events (lesson started/cancelled, announcements, etc.).
    try {
      const monitors = await sbGet<ClassMonitorRow[]>(
        `class_monitors?class_id=eq.${classId}&select=monitor_id`,
      );
      for (const m of monitors) ids.add(m.monitor_id);
    } catch (e) {
      // Soft-fail if the table is missing on older deployments — the rest
      // of the audience expansion still succeeds.
      console.warn('[IV push-events] class_monitors fetch failed', e);
    }
  }
  return [...ids];
}

async function allCoordinators(): Promise<string[]> {
  const rows = await sbGet<ProfileRow[]>(`profiles?role=eq.coordenacao&select=id`);
  return rows.map((r) => r.id);
}

async function allActiveProfiles(): Promise<string[]> {
  const rows = await sbGet<ProfileRow[]>(`profiles?select=id`);
  return rows.map((r) => r.id);
}

// ── Main ───────────────────────────────────────────────────────────────────

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ skipped: 'missing env' }), { status: 200 });
  }

  const now = Date.now();
  const sinceIso = new Date(now - LOOKBACK_MS).toISOString();
  const cancelSinceIso = new Date(now - CANCELLED_LOOKBACK_MS).toISOString();
  // D-1 window: attendance makeup_deadline between now+23h and now+25h
  // so we catch rows right around the 24-hour mark regardless of cron timing.
  const d1Start = new Date(now + 23 * 60 * 60 * 1000).toISOString();
  const d1End   = new Date(now + 25 * 60 * 60 * 1000).toISOString();

  // ── 1) Fetch recent rows for every event source ──────────────────────────
  const [
    pendingSwaps,
    respondedSwaps,
    substitutions,
    startedLessons,
    cancelledLessons,
    recentAnnouncements,
    rescheduleEvents,
    reinstateEvents,
    fjD1Reminders,
    autoAbsentEvents,
  ] = await Promise.all([
    sbGet<SwapRow[]>(
      `lesson_swap_requests?status=eq.pending&created_at=gte.${sinceIso}`
      + `&select=id,scheduled_lesson_id,requester_id,target_id,status,responded_at,created_at`,
    ).catch(() => []),
    sbGet<SwapRow[]>(
      `lesson_swap_requests?status=in.(accepted,rejected)&responded_at=gte.${sinceIso}`
      + `&select=id,scheduled_lesson_id,requester_id,target_id,status,responded_at,created_at`,
    ).catch(() => []),
    sbGet<HistoryRow[]>(
      `lesson_assignment_history?kind=eq.substitution&created_at=gte.${sinceIso}`
      + `&select=id,scheduled_lesson_id,new_professor_id,reason,kind,created_at`,
    ).catch(() => []),
    sbGet<ScheduledLessonRow[]>(
      `scheduled_lessons?status=eq.in_progress&started_at=gte.${sinceIso}`
      + `&select=id,class_id,lesson_id,professor_id,scheduled_at,started_at,status,modality`,
    ).catch(() => []),
    sbGet<ScheduledLessonRow[]>(
      `scheduled_lessons?status=eq.cancelled&scheduled_at=gte.${cancelSinceIso}`
      + `&select=id,class_id,lesson_id,professor_id,scheduled_at,started_at,status`,
    ).catch(() => []),
    sbGet<AnnouncementRow[]>(
      `announcements?created_at=gte.${sinceIso}`
      + `&select=id,class_id,title,content,created_at`,
    ).catch(() => []),
    // lesson_assignment_history rows written by migration 020 triggers
    sbGet<HistoryRow[]>(
      `lesson_assignment_history?kind=eq.reschedule&created_at=gte.${sinceIso}`
      + `&select=id,scheduled_lesson_id,new_professor_id,reason,kind,created_at`,
    ).catch(() => []),
    sbGet<HistoryRow[]>(
      `lesson_assignment_history?kind=eq.reinstatement&created_at=gte.${sinceIso}`
      + `&select=id,scheduled_lesson_id,new_professor_id,reason,kind,created_at`,
    ).catch(() => []),
    // D-1 makeup deadline reminders: FJ attendance whose deadline falls within 24h
    sbGet<AttendanceFJRow[]>(
      `attendance?status=eq.justified&makeup_deadline=gte.${d1Start}&makeup_deadline=lte.${d1End}`
      + `&select=id,student_id,scheduled_lesson_id,makeup_deadline`,
    ).catch(() => []),
    // attendance.auto_absent: linhas em audit_logs criadas pelo trigger 033
    // quando o sistema rebaixa automaticamente present→absent.
    sbGet<AuditLogAutoAbsentRow[]>(
      `audit_logs?action=eq.attendance.auto_absent&created_at=gte.${sinceIso}`
      + `&select=id,entity_id,details,created_at`,
    ).catch(() => []),
  ]);

  // ── 2) Compute candidate event keys + claim them atomically ──────────────
  const candidateKeys: string[] = [
    ...pendingSwaps.map((s) => `swap-incoming:${s.id}`),
    ...respondedSwaps.map((s) => s.status === 'accepted' ? `swap-accepted:${s.id}` : `swap-rejected:${s.id}`),
    ...substitutions.map((h) => `substitution:${h.id}`),
    ...startedLessons.map((l) => `lesson-started:${l.id}`),
    ...cancelledLessons.map((l) => `lesson-cancelled:${l.id}`),
    ...recentAnnouncements.map((a) => `announcement:${a.id}`),
    ...rescheduleEvents.map((h) => `reschedule:${h.id}`),
    ...reinstateEvents.map((h) => `reinstatement:${h.id}`),
    // D-1 reminder key includes the date so it only fires once per day
    ...fjD1Reminders.map((a) => `makeup-d1:${a.id}:${a.makeup_deadline.slice(0, 10)}`),
    ...autoAbsentEvents.map((e) => `auto-absent:${e.entity_id}`),
  ];

  const claimed = await claimEventKeys(candidateKeys);
  if (claimed.size === 0) {
    return new Response(JSON.stringify({ scanned: candidateKeys.length, dispatched: 0 }), { status: 200 });
  }

  // ── 3) Resolve metadata once (classes + lessons + scheduled_lesson refs) ─
  const allLessonIds = new Set<string>();
  const allClassIds = new Set<string>();
  const allScheduledIds = new Set<string>();

  for (const l of startedLessons) { allClassIds.add(l.class_id); if (l.lesson_id) allLessonIds.add(l.lesson_id); }
  for (const l of cancelledLessons) { allClassIds.add(l.class_id); if (l.lesson_id) allLessonIds.add(l.lesson_id); }
  for (const a of recentAnnouncements) if (a.class_id) allClassIds.add(a.class_id);
  for (const s of pendingSwaps) allScheduledIds.add(s.scheduled_lesson_id);
  for (const s of respondedSwaps) allScheduledIds.add(s.scheduled_lesson_id);
  for (const h of substitutions) allScheduledIds.add(h.scheduled_lesson_id);
  for (const h of rescheduleEvents) allScheduledIds.add(h.scheduled_lesson_id);
  for (const h of reinstateEvents) allScheduledIds.add(h.scheduled_lesson_id);
  for (const a of fjD1Reminders) allScheduledIds.add(a.scheduled_lesson_id);
  for (const e of autoAbsentEvents) {
    if (e.details?.scheduled_lesson_id) allScheduledIds.add(e.details.scheduled_lesson_id);
  }

  const swapScheduledRows = allScheduledIds.size > 0
    ? await sbGet<ScheduledLessonRow[]>(
        `scheduled_lessons?id=in.(${[...allScheduledIds].join(',')})`
        + `&select=id,class_id,lesson_id,professor_id,scheduled_at,started_at,status`,
      ).catch(() => [])
    : [];
  for (const r of swapScheduledRows) {
    allClassIds.add(r.class_id);
    if (r.lesson_id) allLessonIds.add(r.lesson_id);
  }
  const swapScheduledById = Object.fromEntries(swapScheduledRows.map((r) => [r.id, r]));

  const [classes, lessons] = await Promise.all([
    allClassIds.size
      ? sbGet<ClassRow[]>(`classes?id=in.(${[...allClassIds].join(',')})&select=id,name,modality`).catch(() => [])
      : Promise.resolve([] as ClassRow[]),
    allLessonIds.size
      ? sbGet<LessonRow[]>(`lessons?id=in.(${[...allLessonIds].join(',')})&select=id,title`).catch(() => [])
      : Promise.resolve([] as LessonRow[]),
  ]);
  const classMap = Object.fromEntries(classes.map((c) => [c.id, c]));
  const lessonMap = Object.fromEntries(lessons.map((l) => [l.id, l]));

  function whenLabel(iso: string): string {
    try {
      return new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }
  function lessonHeadline(sl: ScheduledLessonRow | undefined): string {
    if (!sl) return 'Aula';
    const cls = classMap[sl.class_id]?.name ?? 'Turma';
    const les = sl.lesson_id ? lessonMap[sl.lesson_id]?.title : null;
    return `${les ?? 'Aula livre'} • ${cls}`;
  }

  // ── 4) Dispatch ──────────────────────────────────────────────────────────
  let dispatched = 0;

  // swap-incoming
  for (const s of pendingSwaps) {
    if (!claimed.has(`swap-incoming:${s.id}`)) continue;
    const sl = swapScheduledById[s.scheduled_lesson_id];
    const ok = await dispatch({
      userIds: [s.target_id],
      title: 'Solicitação de troca de aula',
      body: `Um colega quer trocar a aula de ${lessonHeadline(sl)}${sl ? ` (${whenLabel(sl.scheduled_at)})` : ''}.`,
      url: '/calendario',
      tag: `swap:${s.id}`,
      kind: 'swap-incoming',
    });
    if (ok) dispatched++;
  }

  // swap-accepted / swap-rejected
  for (const s of respondedSwaps) {
    const key = s.status === 'accepted' ? `swap-accepted:${s.id}` : `swap-rejected:${s.id}`;
    if (!claimed.has(key)) continue;
    const sl = swapScheduledById[s.scheduled_lesson_id];
    const ok = await dispatch({
      userIds: [s.requester_id],
      title: s.status === 'accepted' ? 'Troca aceita' : 'Troca recusada',
      body: s.status === 'accepted'
        ? `Sua solicitação para ${lessonHeadline(sl)} foi aceita.`
        : `Sua solicitação para ${lessonHeadline(sl)} foi recusada.`,
      url: '/calendario',
      tag: `swap:${s.id}`,
      kind: s.status === 'accepted' ? 'swap-accepted' : 'swap-rejected',
    });
    if (ok) dispatched++;
  }

  // substitution
  for (const h of substitutions) {
    if (!claimed.has(`substitution:${h.id}`)) continue;
    if (!h.new_professor_id) continue;
    const sl = swapScheduledById[h.scheduled_lesson_id];
    const ok = await dispatch({
      userIds: [h.new_professor_id],
      title: 'Você foi designado(a) como substituto(a)',
      body: `${lessonHeadline(sl)}${sl ? ` em ${whenLabel(sl.scheduled_at)}` : ''}.${h.reason ? ` Motivo: ${h.reason}` : ''}`,
      url: '/calendario',
      tag: `sub:${h.id}`,
      kind: 'substitution',
      requireInteraction: true,
    });
    if (ok) dispatched++;
  }

  // lesson-started → assigned professor + ALL class professors + active students
  // Presencial lessons are skipped — there is no virtual room to enter, and
  // ringing every enrolled student's phone with an unactionable notification
  // is noisy. Coordenação/monitor coordinate physically.
  for (const l of startedLessons) {
    if (!claimed.has(`lesson-started:${l.id}`)) continue;
    const effective = l.modality ?? classMap[l.class_id]?.modality ?? 'online';
    if (effective === 'presencial') continue;
    const audience = new Set<string>(await classAudience(l.class_id, 'all'));
    if (l.professor_id) audience.add(l.professor_id);
    const ok = await dispatch({
      userIds: [...audience],
      title: 'Aula ao vivo',
      body: `${lessonHeadline(l)} começou agora.`,
      url: `/turmas/${l.class_id}`,
      tag: `lesson-started:${l.id}`,
      kind: 'lesson-started',
      requireInteraction: true,
    });
    if (ok) dispatched++;
  }

  // lesson-cancelled → professors + students of class
  for (const l of cancelledLessons) {
    if (!claimed.has(`lesson-cancelled:${l.id}`)) continue;
    const audience = new Set<string>(await classAudience(l.class_id, 'all'));
    if (l.professor_id) audience.add(l.professor_id);
    const ok = await dispatch({
      userIds: [...audience],
      title: 'Aula cancelada',
      body: `${lessonHeadline(l)} (${whenLabel(l.scheduled_at)}) foi cancelada.`,
      url: `/turmas/${l.class_id}`,
      tag: `lesson-cancelled:${l.id}`,
      kind: 'lesson-cancelled',
    });
    if (ok) dispatched++;
  }

  // reschedule → all professors and students of the class
  for (const h of rescheduleEvents) {
    if (!claimed.has(`reschedule:${h.id}`)) continue;
    const sl = swapScheduledById[h.scheduled_lesson_id];
    if (!sl) continue;
    const audience = new Set<string>(await classAudience(sl.class_id, 'all'));
    const ok = await dispatch({
      userIds: [...audience],
      title: 'Aula reagendada',
      body: `${lessonHeadline(sl)} foi reagendada para ${whenLabel(sl.scheduled_at)}.${h.reason ? ` Motivo: ${h.reason}` : ''}`,
      url: `/turmas/${sl.class_id}`,
      tag: `reschedule:${h.id}`,
      kind: 'reschedule',
    });
    if (ok) dispatched++;
  }

  // reinstatement → all professors and students of the class
  for (const h of reinstateEvents) {
    if (!claimed.has(`reinstatement:${h.id}`)) continue;
    const sl = swapScheduledById[h.scheduled_lesson_id];
    if (!sl) continue;
    const audience = new Set<string>(await classAudience(sl.class_id, 'all'));
    const ok = await dispatch({
      userIds: [...audience],
      title: 'Aula reativada',
      body: `${lessonHeadline(sl)} foi reativada e está confirmada para ${whenLabel(sl.scheduled_at)}.`,
      url: `/turmas/${sl.class_id}`,
      tag: `reinstatement:${h.id}`,
      kind: 'reinstatement',
    });
    if (ok) dispatched++;
  }

  // makeup-d1-reminder → individual student whose deadline is ~24h away
  for (const a of fjD1Reminders) {
    const key = `makeup-d1:${a.id}:${a.makeup_deadline.slice(0, 10)}`;
    if (!claimed.has(key)) continue;
    const sl = swapScheduledById[a.scheduled_lesson_id];
    const ok = await dispatch({
      userIds: [a.student_id],
      title: 'Lembrete de reposição',
      body: `Amanhã é o último dia para enviar seu resumo de ${lessonHeadline(sl)}.`,
      url: sl ? `/turmas/${sl.class_id}?tab=reposicao` : '/gravacoes',
      tag: key,
      kind: 'makeup-d1-reminder',
    });
    if (ok) dispatched++;
  }

  // attendance.auto_absent → notifica o aluno que teve presença removida
  // automaticamente (auditoria Fase C #9). Push individual com link direto
  // para a aula, para que ele saiba e possa pedir FJ se cabível.
  for (const e of autoAbsentEvents) {
    const key = `auto-absent:${e.entity_id}`;
    if (!claimed.has(key)) continue;
    const studentId = e.details?.student_id;
    if (!studentId) continue;
    const sl = e.details?.scheduled_lesson_id ? swapScheduledById[e.details.scheduled_lesson_id] : undefined;
    const ok = await dispatch({
      userIds: [studentId],
      title: 'Presença removida',
      body: e.details?.notes
        ? `${lessonHeadline(sl)}: ${e.details.notes}`
        : `${lessonHeadline(sl)}: sua presença automática foi removida.`,
      url: sl ? `/turmas/${sl.class_id}` : '/calendario',
      tag: key,
      kind: 'attendance-auto-absent',
      requireInteraction: true,
    });
    if (ok) dispatched++;
  }

  // announcement → audience depends on scope
  for (const a of recentAnnouncements) {
    if (!claimed.has(`announcement:${a.id}`)) continue;
    let audience: string[];
    if (a.class_id) {
      const set = new Set<string>(await classAudience(a.class_id, 'all'));
      // Include coordenação so they see class-scoped announcements too.
      for (const id of await allCoordinators()) set.add(id);
      audience = [...set];
    } else {
      // Global announcement → everyone with an account.
      audience = await allActiveProfiles();
    }
    const ok = await dispatch({
      userIds: audience,
      title: a.title,
      body: a.content.length > 140 ? a.content.slice(0, 137) + '…' : a.content,
      url: a.class_id ? `/turmas/${a.class_id}` : `/?aviso=${a.id}`,
      tag: `announcement:${a.id}`,
      kind: 'announcement',
    });
    if (ok) dispatched++;
  }

  return new Response(
    JSON.stringify({ scanned: candidateKeys.length, claimed: claimed.size, dispatched }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

export const config: Config = {
  schedule: '* * * * *', // every minute
};
