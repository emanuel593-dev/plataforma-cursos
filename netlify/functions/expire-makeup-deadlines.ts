// Scheduled function: every day at 06:00 UTC, expire FJ deadlines.
//
// For each attendance row where:
//   - status = 'justified'
//   - makeup_deadline IS NOT NULL
//   - makeup_deadline < now
// AND there is NO accepted makeup_submission (submitted | approved):
//   → flip attendance.status to 'absent' (FJ becomes F)
//   → log + push notification to the student (best-effort)
//
// Idempotent: rows already flipped won't match (status != 'justified') on the
// next run. Safe to re-run on retry.
//
// ──────────────────────────────────────────────────────────────────────────
// Relationship to `push-events.ts`:
//
//   `push-events.ts` runs every minute and includes a D-1 reminder
//   (~24h before makeup_deadline). It only NOTIFIES — never mutates state.
//   This function runs DAILY and only MUTATES — it never reminds.
//
//   Kept separate on purpose:
//     • Different cadences (every minute vs daily) — merging would either
//       waste compute (running the expiry sweep every minute) or delay the
//       reminder by up to 24h.
//     • Different blast radius — the reminder is informational; the expiry
//       writes to attendance and creates audit history. Separation makes
//       failure modes independent.
//
//   Both queries are cheap (indexed on makeup_deadline) and the overlap is
//   intentional. Do NOT consolidate without revisiting the cron schedule.
// ──────────────────────────────────────────────────────────────────────────

import type { Config } from '@netlify/functions';
import webpush from 'web-push';

const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const VAPID_PUBLIC              = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE             = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT             = process.env.VAPID_SUBJECT ?? 'mailto:plataforma@talentsflow.com.br';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

interface AttendanceRow {
  id:                  string;
  scheduled_lesson_id: string;
  student_id:          string;
  status:              string;
  makeup_deadline:     string | null;
}

interface MakeupSubmissionRow {
  scheduled_lesson_id: string | null;
  student_id:          string;
  status:              string;
}

interface PushSubRow {
  id:       string;
  user_id:  string;
  endpoint: string;
  p256dh:   string;
  auth:     string;
}

async function notifyStudent(row: AttendanceRow): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    // Fetch class context for a friendlier message (best-effort).
    let className = '';
    let classId: string | null = null;
    try {
      const lesson = await sb<Array<{ class_id: string | null; classes?: { name?: string } }>>(
        `scheduled_lessons?id=eq.${row.scheduled_lesson_id}&select=class_id,classes(name)`,
      );
      if (lesson?.[0]) {
        classId = lesson[0].class_id ?? null;
        className = lesson[0].classes?.name ?? '';
      }
    } catch { /* ignore */ }

    const subs = await sb<PushSubRow[]>(
      `push_subscriptions?user_id=eq.${row.student_id}&select=id,user_id,endpoint,p256dh,auth`,
    );
    if (!subs || subs.length === 0) return;

    const payload = JSON.stringify({
      title: 'Reposição expirada',
      body:  (className ? `Turma: ${className}. ` : '')
        + 'O prazo para envio do resumo da reposição encerrou e a falta foi confirmada. '
        + 'Procure a coordenação se precisar de orientação.',
      url:   classId ? `/turmas/${classId}?tab=reposicao` : '/gravacoes',
      tag:   `fj-expired-${row.id}`,
      kind:  'fj-expired',
      requireInteraction: false,
      vibrate: [80, 40, 80],
    });

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 60 * 60 * 24 },
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${s.id}`, {
            method:  'DELETE',
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              apikey:        SUPABASE_SERVICE_ROLE_KEY,
            },
          });
        } else {
          console.error('[expire-makeup] push send error', status, err);
        }
      }
    }));
  } catch (e) {
    console.error('[expire-makeup] notifyStudent failed', e);
  }
}

async function sb<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey:        SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer:         'return=representation',
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  return await r.json() as T;
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ skipped: 'missing env' }), { status: 200 });
  }

  const nowIso = new Date().toISOString();

  // 1) Find all FJ rows whose deadline has passed
  const expired = await sb<AttendanceRow[]>(
    `attendance?status=eq.justified&makeup_deadline=not.is.null&makeup_deadline=lt.${nowIso}`
    + `&select=id,scheduled_lesson_id,student_id,status,makeup_deadline`,
  );

  if (expired.length === 0) {
    return new Response(JSON.stringify({ scanned: 0, flipped: 0 }), { status: 200 });
  }

  // 2) For these (lesson, student) pairs, fetch existing makeup_submissions
  //    that already satisfy the obligation (submitted | approved).
  const lessonIds = [...new Set(expired.map((a) => a.scheduled_lesson_id))];
  const studentIds = [...new Set(expired.map((a) => a.student_id))];

  const submissions = await sb<MakeupSubmissionRow[]>(
    `makeup_submissions?scheduled_lesson_id=in.(${lessonIds.join(',')})`
    + `&student_id=in.(${studentIds.join(',')})`
    + `&status=in.(submitted,approved)`
    + `&select=scheduled_lesson_id,student_id,status`,
  );

  const satisfied = new Set(
    submissions.map((s) => `${s.scheduled_lesson_id}|${s.student_id}`),
  );

  // 3) Flip those NOT satisfied to 'absent'
  const toFlip = expired.filter(
    (a) => !satisfied.has(`${a.scheduled_lesson_id}|${a.student_id}`),
  );

  let flipped = 0;
  for (const a of toFlip) {
    try {
      // Use RPC so the audit log carries source='cron' instead of
      // an anonymous actor_id=NULL row (see migration 042 §A4).
      await sb<unknown>(
        'rpc/auto_expire_makeup_deadline',
        {
          method: 'POST',
          body:   JSON.stringify({ p_attendance_id: a.id }),
        },
      );
      flipped++;
      // Best-effort push to the student so they understand why the FJ became F.
      // Failures here never block the flip itself.
      await notifyStudent(a);
    } catch (e) {
      console.error(`[expire-makeup] failed to flip attendance ${a.id}`, e);
    }
  }

  return new Response(
    JSON.stringify({ scanned: expired.length, flipped, satisfied: expired.length - toFlip.length }),
    { status: 200 },
  );
};

// Run once a day at 06:00 UTC (~03:00 BRT).
export const config: Config = {
  schedule: '0 6 * * *',
};
