// POST /api/push/lesson-started
//
// Body: { scheduledLessonId: string }
//
// Auth: Bearer token of the lesson controller (the assigned professor, any
//       professor of the class, or coordenacao). The function checks
//       authorization against scheduled_lessons.professor_id and the
//       class_professors junction.
//
// Effect: sends a "Sua aula começou agora" web push to every student with
//         an active enrollment in the lesson's class who has a registered
//         push subscription.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import webpush from 'web-push';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:plataforma@talentsflow.com.br';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const SR_HEADERS = {
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: SUPABASE_SERVICE_ROLE_KEY,
};

async function sb<T>(path: string): Promise<T | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SR_HEADERS });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

async function deleteSubscription(id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
    method: 'DELETE',
    headers: SR_HEADERS,
  });
}

export const handler = async (event: {
  httpMethod: string;
  body: string | null;
  headers: Record<string, string | undefined>;
}) => {
  const respHeaders = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: respHeaders, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers: respHeaders, body: JSON.stringify({ error: 'Servidor de push não configurado.' }) };
  }

  // ── Auth: caller must be authenticated ─────────────────────────────────────
  const authHeader = event.headers.authorization ?? (event.headers.Authorization as string | undefined);
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers: respHeaders, body: JSON.stringify({ error: 'Token ausente.' }) };
  }
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!u.ok) {
    return { statusCode: 401, headers: respHeaders, body: JSON.stringify({ error: 'Token inválido.' }) };
  }
  const caller = (await u.json()) as { id: string };

  // ── Parse body ─────────────────────────────────────────────────────────────
  let parsed: { scheduledLessonId?: string };
  try { parsed = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const scheduledLessonId = parsed.scheduledLessonId;
  if (!scheduledLessonId || typeof scheduledLessonId !== 'string') {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: '`scheduledLessonId` é obrigatório.' }) };
  }

  // ── Load lesson + caller profile ───────────────────────────────────────────
  const lessons = await sb<Array<{
    id: string;
    class_id: string;
    professor_id: string | null;
    lesson_id: string | null;
    room_id: string | null;
    scheduled_at: string;
    status: string;
    modality: 'online' | 'presencial' | 'hibrida' | null;
  }>>(`scheduled_lessons?id=eq.${scheduledLessonId}&select=id,class_id,professor_id,lesson_id,room_id,scheduled_at,status,modality`);
  if (!lessons || lessons.length === 0) {
    return { statusCode: 404, headers: respHeaders, body: JSON.stringify({ error: 'Aula não encontrada.' }) };
  }
  const lesson = lessons[0];

  const profiles = await sb<Array<{ role: string }>>(`profiles?id=eq.${caller.id}&select=role`);
  const callerRole = profiles?.[0]?.role;

  // ── Authorization: assigned professor, any class professor, or coordenação ─
  let authorized = callerRole === 'coordenacao' || lesson.professor_id === caller.id;
  if (!authorized) {
    const classProfs = await sb<Array<{ professor_id: string }>>(
      `class_professors?class_id=eq.${lesson.class_id}&professor_id=eq.${caller.id}&select=professor_id`,
    );
    authorized = !!(classProfs && classProfs.length > 0);
  }
  if (!authorized) {
    return { statusCode: 403, headers: respHeaders, body: JSON.stringify({ error: 'Sem permissão para esta aula.' }) };
  }

  // ── Resolve title (lesson template name + class name) ──────────────────────
  let lessonTitle = 'Sua aula';
  if (lesson.lesson_id) {
    const ls = await sb<Array<{ title: string }>>(`lessons?id=eq.${lesson.lesson_id}&select=title`);
    if (ls?.[0]?.title) lessonTitle = ls[0].title;
  }
  const cls = await sb<Array<{ name: string; modality: 'online' | 'presencial' | 'hibrida' | null }>>(`classes?id=eq.${lesson.class_id}&select=name,modality`);
  const className = cls?.[0]?.name ?? '';
  const effectiveModality = lesson.modality ?? cls?.[0]?.modality ?? 'online';
  const isPresencial = effectiveModality === 'presencial';

  // ── Find enrolled students ─────────────────────────────────────────────────
  const enrolls = await sb<Array<{ student_id: string }>>(
    `enrollments?class_id=eq.${lesson.class_id}&status=eq.active&select=student_id`,
  );
  const studentIds = (enrolls ?? []).map((e) => e.student_id);

  // Phase 2 monitor rollout: notify class monitors as well so they can join
  // the room without waiting for the cron-based push-events fallback. Soft-
  // fail on RLS / missing table — students must still be notified.
  let monitorIds: string[] = [];
  try {
    const monitors = await sb<Array<{ monitor_id: string }>>(
      `class_monitors?class_id=eq.${lesson.class_id}&select=monitor_id`,
    );
    monitorIds = (monitors ?? []).map((m) => m.monitor_id);
  } catch (err) {
    console.warn('[push-lesson-started] monitors fetch failed:', err);
  }

  const recipientIds = Array.from(new Set([...studentIds, ...monitorIds]));
  if (recipientIds.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, recipients: 0 }) };
  }

  // ── Fetch their push subscriptions ─────────────────────────────────────────
  const subs = await sb<SubscriptionRow[]>(
    `push_subscriptions?user_id=in.(${recipientIds.map(encodeURIComponent).join(',')})&select=id,user_id,endpoint,p256dh,auth`,
  );
  if (!subs || subs.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, recipients: recipientIds.length }) };
  }

  // ── Send notifications ─────────────────────────────────────────────────────
  const titleText = `${lessonTitle} começou agora`;
  // Presencial lessons have no virtual room; we still notify monitors so
  // they can take attendance, but the deep-link points at the class detail
  // and the body wording matches the user's expectation (no "sala").
  const bodyText = isPresencial
    ? (className ? `Turma: ${className}. Aula presencial em andamento.` : 'Aula presencial em andamento.')
    : (className ? `Turma: ${className}. Toque para entrar na sala.` : 'Toque para entrar na sala.');
  // Deep-link path: route is `/sala/:roomId?aula=:scheduledLessonId`. Fall
  // back to the scheduled-lesson id when no room_id was assigned (defensive
  // — startLesson() should always set one before this is called). For
  // presencial we route to the class detail page so neither students nor
  // monitors land on the WebRTC guard screen.
  const roomPath = lesson.room_id || lesson.id;
  const payload = JSON.stringify({
    title: titleText,
    body: bodyText,
    url: isPresencial ? `/turmas/${lesson.class_id}` : `/sala/${roomPath}?aula=${lesson.id}`,
    tag: `lesson-started-${lesson.id}`,
    kind: 'lesson-started',
    requireInteraction: false,
    vibrate: [80, 40, 80],
  });

  let sent = 0, failed = 0, removed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 30 },
      );
      sent++;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await deleteSubscription(s.id);
        removed++;
      } else {
        failed++;
        console.error('[IV push lesson-started] send error', status, err);
      }
    }
  }));

  return {
    statusCode: 200,
    headers: respHeaders,
    body: JSON.stringify({ sent, failed, removed, recipients: recipientIds.length, subscribers: subs.length }),
  };
};
