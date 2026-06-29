// Scheduled function: every 5 minutes, scan upcoming lessons and dispatch
// push reminders to assigned professors at the 60/30/10-minute marks.
//
// netlify.toml registers this on a cron (see [[functions]] schedule).
//
// To avoid duplicate pushes, we record dispatched (lesson_id, offset)
// pairs in a tiny `push_dispatch_log` table. If the table is missing
// the scan still runs but may double-fire on overlapping invocations.

import type { Config } from '@netlify/functions';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SITE_URL = process.env.URL ?? process.env.DEPLOY_URL ?? 'http://localhost:8888';

const REMINDER_OFFSETS_MIN = [60, 30, 10] as const;

interface ScheduledLessonRow {
  id: string;
  class_id: string;
  lesson_id: string | null;
  professor_id: string | null;
  scheduled_at: string;
  status: string;
  modality: 'online' | 'presencial' | 'hibrida' | null;
}

interface ClassRow { id: string; name: string; modality: 'online' | 'presencial' | 'hibrida' | null; location: string | null }
interface LessonRow { id: string; title: string }
interface ClassMonitorRow { class_id: string; monitor_id: string }

async function sb<T>(path: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
  return await r.json() as T;
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ skipped: 'missing env' }), { status: 200 });
  }

  const now = Date.now();
  const horizon = now + 65 * 60 * 1000; // a bit beyond 60-min mark
  const fromIso = new Date(now).toISOString();
  const toIso = new Date(horizon).toISOString();

  const upcoming = await sb<ScheduledLessonRow[]>(
    `scheduled_lessons?status=eq.scheduled&scheduled_at=gte.${fromIso}&scheduled_at=lte.${toIso}`
    + `&select=id,class_id,lesson_id,professor_id,scheduled_at,status,modality`,
  );

  if (upcoming.length === 0) {
    return new Response(JSON.stringify({ scanned: 0 }), { status: 200 });
  }

  const classIds = [...new Set(upcoming.map((l) => l.class_id))];
  const lessonIds = [...new Set(upcoming.map((l) => l.lesson_id).filter(Boolean))] as string[];

  const [classes, lessons] = await Promise.all([
    classIds.length
      ? sb<ClassRow[]>(`classes?id=in.(${classIds.join(',')})&select=id,name,modality,location`)
      : Promise.resolve([] as ClassRow[]),
    lessonIds.length
      ? sb<LessonRow[]>(`lessons?id=in.(${lessonIds.join(',')})&select=id,title`)
      : Promise.resolve([] as LessonRow[]),
  ]);
  const classMap = Object.fromEntries(classes.map((c) => [c.id, c]));
  const lessonMap = Object.fromEntries(lessons.map((l) => [l.id, l]));

  // Phase 2 monitor rollout: monitors of the class also receive reminders.
  // Aggregated once per class to avoid N queries inside the loop. Soft-fail
  // on RLS/network so a missing monitor row never blocks the professor.
  const monitorsByClass: Record<string, string[]> = {};
  if (classIds.length) {
    try {
      const rows = await sb<ClassMonitorRow[]>(
        `class_monitors?class_id=in.(${classIds.join(',')})&select=class_id,monitor_id`,
      );
      for (const r of rows) {
        (monitorsByClass[r.class_id] ??= []).push(r.monitor_id);
      }
    } catch (err) {
      console.warn('[push-reminders] monitors fetch failed:', err);
    }
  }

  let pushed = 0;
  for (const sl of upcoming) {
    const dueAt = new Date(sl.scheduled_at).getTime();
    const minsUntil = Math.round((dueAt - now) / 60000);

    // Pick the LARGEST applicable bucket so we send at most one reminder per
    // run per lesson (60 → 30 → 10), and only inside a small ± window.
    const bucket = REMINDER_OFFSETS_MIN.find((m) => Math.abs(minsUntil - m) <= 2);
    if (!bucket) continue;

    const cls = classMap[sl.class_id];
    const effective = sl.modality ?? cls?.modality ?? 'online';
    const isPresencial = effective === 'presencial';
    const monitors = monitorsByClass[sl.class_id] ?? [];

    // Recipient policy:
    //  • online/hibrida → professor + monitores (mantém comportamento atual).
    //  • presencial    → monitores (quem faz a chamada). Sem monitor: fallback
    //                   para professor titular se existir; senão pula (coord
    //                   recebe alerta via /push-events fallback).
    let recipients: string[];
    if (isPresencial) {
      if (monitors.length > 0) recipients = monitors;
      else if (sl.professor_id) recipients = [sl.professor_id];
      else continue;
    } else {
      if (!sl.professor_id) continue;
      recipients = [sl.professor_id, ...monitors];
    }

    // Idempotency: claim the (lesson, bucket) pair in push_dispatch_log.
    // ON CONFLICT DO NOTHING + RETURNING means we only proceed when this is
    // the first run that sees this bucket — protecting against overlapping
    // cron invocations.
    const eventKey = `lesson-reminder-${bucket}:${sl.id}`;
    const claim = await fetch(`${SUPABASE_URL}/rest/v1/push_dispatch_log`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify([{ event_key: eventKey }]),
    });
    if (!claim.ok) continue;
    const claimed = await claim.json() as Array<{ event_key: string }>;
    if (claimed.length === 0) continue; // already dispatched

    const les = sl.lesson_id ? lessonMap[sl.lesson_id] : null;
    const lessonTitle = les?.title ?? 'Aula livre';
    const className = cls?.name ?? 'Turma';
    const location = cls?.location?.trim() || null;

    const payload = {
      userIds: recipients,
      title: isPresencial
        ? `Chamada em ~${bucket} min`
        : `Lembrete: aula em ~${bucket} min`,
      body: isPresencial
        ? (location
          ? `${lessonTitle} • ${className} • ${location}`
          : `${lessonTitle} • ${className} (presencial)`)
        : `${lessonTitle} • ${className}`,
      url: isPresencial
        ? `/presencas?aula=${sl.id}`
        : `/turmas/${sl.class_id}`,
      tag: eventKey,
      kind: isPresencial ? 'lesson-reminder-presencial' : 'lesson-reminder',
    };

    try {
      const r = await fetch(`${SITE_URL}/.netlify/functions/push-send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify(payload),
      });
      if (r.ok) pushed++;
    } catch (e) {
      console.error('[IV scheduled push] dispatch failed', e);
    }
  }

  return new Response(JSON.stringify({ scanned: upcoming.length, pushed }), { status: 200 });
};

export const config: Config = {
  schedule: '*/5 * * * *',
};
