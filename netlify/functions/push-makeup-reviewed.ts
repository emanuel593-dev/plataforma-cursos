// POST /api/push/makeup-reviewed
//
// Body: { submissionId: string }
//
// Auth: Bearer token. Only coordenacao/professor (revisor) may trigger.
//
// Effect: sends a push notification to the student informing whether the
//         makeup summary was approved or rejected, plus optional reviewer
//         feedback. Deep-links back to the class detail (Reposição tab).
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import webpush from 'web-push';

const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const VAPID_PUBLIC              = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE             = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT             = process.env.VAPID_SUBJECT ?? 'mailto:plataforma@talentsflow.com.br';

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
  apikey:        SUPABASE_SERVICE_ROLE_KEY,
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

  // ── Auth ─────────────────────────────────────────────────────────────────
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

  const profiles = await sb<Array<{ role: string }>>(`profiles?id=eq.${caller.id}&select=role`);
  const callerRole = profiles?.[0]?.role;
  if (callerRole !== 'coordenacao' && callerRole !== 'professor') {
    return { statusCode: 403, headers: respHeaders, body: JSON.stringify({ error: 'Apenas coordenação/professor pode revisar.' }) };
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let parsed: { submissionId?: string };
  try { parsed = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const submissionId = parsed.submissionId;
  if (!submissionId || typeof submissionId !== 'string') {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: '`submissionId` é obrigatório.' }) };
  }

  // ── Load submission ──────────────────────────────────────────────────────
  const subs = await sb<Array<{
    id: string;
    student_id: string;
    class_id: string | null;
    status: string;
    reviewer_notes: string | null;
  }>>(`makeup_submissions?id=eq.${submissionId}&select=id,student_id,class_id,status,reviewer_notes`);
  if (!subs || subs.length === 0) {
    return { statusCode: 404, headers: respHeaders, body: JSON.stringify({ error: 'Submissão não encontrada.' }) };
  }
  const sub = subs[0];
  if (sub.status !== 'approved' && sub.status !== 'rejected') {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, skipped: 'status not reviewed' }) };
  }

  // ── Resolve class name (best effort) ─────────────────────────────────────
  let className = '';
  if (sub.class_id) {
    const cls = await sb<Array<{ name: string }>>(`classes?id=eq.${sub.class_id}&select=name`);
    if (cls?.[0]?.name) className = cls[0].name;
  }

  // ── Subscriptions of the student ─────────────────────────────────────────
  const subscriptions = await sb<SubscriptionRow[]>(
    `push_subscriptions?user_id=eq.${sub.student_id}&select=id,user_id,endpoint,p256dh,auth`,
  );
  if (!subscriptions || subscriptions.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, recipients: 1, subscribers: 0 }) };
  }

  // ── Compose payload ──────────────────────────────────────────────────────
  const isApproved = sub.status === 'approved';
  const titleText  = isApproved ? '✅ Reposição aprovada' : '❌ Reposição reprovada';
  const baseBody   = isApproved
    ? 'Sua reposição foi aprovada pela coordenação.'
    : 'Sua reposição foi reprovada. Verifique o feedback.';
  const noteSnippet = sub.reviewer_notes
    ? ` "${sub.reviewer_notes.slice(0, 100)}${sub.reviewer_notes.length > 100 ? '…' : ''}"`
    : '';
  const bodyText = (className ? `Turma: ${className}. ` : '') + baseBody + noteSnippet;

  const url = sub.class_id ? `/turmas/${sub.class_id}?tab=reposicao` : '/gravacoes';

  const payload = JSON.stringify({
    title: titleText,
    body:  bodyText,
    url,
    tag:   `makeup-reviewed-${sub.id}`,
    kind:  'makeup-reviewed',
    requireInteraction: false,
    vibrate: [80, 40, 80],
  });

  let sent = 0, failed = 0, removed = 0;
  await Promise.all(subscriptions.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24 }, // 24h
      );
      sent++;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await deleteSubscription(s.id);
        removed++;
      } else {
        failed++;
        console.error('[IV push makeup-reviewed] send error', status, err);
      }
    }
  }));

  return {
    statusCode: 200,
    headers: respHeaders,
    body: JSON.stringify({ sent, failed, removed, recipients: 1, subscribers: subscriptions.length }),
  };
};
