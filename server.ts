/**
 * Local development HTTP server.
 *
 * In production, all `/api/*` endpoints are served by Netlify Functions
 * under `netlify/functions/`. This file mirrors them for `npm run server`
 * so the same routes work when running outside of Netlify (e.g. local dev
 * or self-hosted preview).
 *
 * WebRTC signaling is NOT handled here — it goes through Supabase Realtime
 * channels directly from the client (see `src/hooks/useWebRTC.ts`).
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { config } from 'dotenv';

config(); // load .env

const PORT = Number(process.env.PORT) || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── Structured logger ────────────────────────────────────────────────────────

function auditLog(action: string, by: string, details: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), action, by, ...details };
  console.log(JSON.stringify(entry));

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    // Log actions to audit table (requires valid Supabase credentials)
    fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        actor_id: by || null,
        action,
        entity: details.entity ?? action.split('_')[0] ?? 'system',
        entity_id: (details.target_uid ?? details.target_email ?? null) as string | null,
        details,
      }),
    }).catch((err) => console.error('[IV] audit_logs insert error:', err));
  }
}

// ── Auth middleware: verify Supabase JWT + require coordenacao ────────────────

interface AuthRequest extends Request {
  requesterId?: string;
}

async function requireCoordinator(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(401).json({ error: 'Não autorizado.' });
    return;
  }

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!userRes.ok) { res.status(401).json({ error: 'Token inválido.' }); return; }
    const user = await userRes.json() as { id: string };

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
      },
    );
    const profiles = await profileRes.json() as Array<{ role: string }>;

    if (!profiles?.[0] || profiles[0].role !== 'coordenacao') {
      res.status(403).json({ error: 'Apenas coordenação pode executar esta ação.' });
      return;
    }

    req.requesterId = user.id;
    next();
  } catch {
    res.status(401).json({ error: 'Falha na autenticação.' });
  }
}

async function supabaseAdminFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}

const app = express();
app.use(cors());
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Admin: create user ────────────────────────────────────────────────────────

app.post('/api/admin/create-user', requireCoordinator, async (req: AuthRequest, res) => {
  const { email, fullName, password, role } = req.body as {
    email: string; fullName: string; password: string; role: string;
  };

  if (!email || !fullName || !password || !role) {
    res.status(400).json({ error: 'email, fullName, password e role são obrigatórios.' });
    return;
  }

  const { ok, status, body } = await supabaseAdminFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    }),
  });

  if (!ok) {
    const msg: string = (body as { msg?: string; message?: string }).msg
      ?? (body as { msg?: string; message?: string }).message
      ?? 'Erro ao criar usuário.';
    res.status(status).json({ error: msg });
    return;
  }

  const user = body as { id: string; email: string };
  auditLog('create_user', req.requesterId!, { target_email: email, role });
  res.json({ id: user.id, email: user.email });
});

// ── Admin: delete user ────────────────────────────────────────────────────────

app.delete('/api/admin/users/:uid', requireCoordinator, async (req: AuthRequest, res) => {
  const { uid } = req.params;

  const { ok, status, body } = await supabaseAdminFetch(`/users/${uid}`, { method: 'DELETE' });

  if (!ok) {
    const msg: string = (body as { msg?: string; message?: string }).msg
      ?? (body as { msg?: string; message?: string }).message
      ?? 'Erro ao excluir usuário.';
    res.status(status).json({ error: msg });
    return;
  }

  auditLog('delete_user', req.requesterId!, { target_uid: uid });
  res.json({ success: true });
});

// ── Admin: update user email ──────────────────────────────────────────────────

app.patch('/api/admin/users/:uid', requireCoordinator, async (req: AuthRequest, res) => {
  const { uid } = req.params;
  const { email } = req.body as { email?: string };

  if (!email) {
    res.status(400).json({ error: 'email é obrigatório.' });
    return;
  }

  const { ok, status, body } = await supabaseAdminFetch(`/users/${uid}`, {
    method: 'PUT',
    body: JSON.stringify({ email }),
  });

  if (!ok) {
    const msg: string = (body as { msg?: string; message?: string }).msg
      ?? (body as { msg?: string; message?: string }).message
      ?? 'Erro ao atualizar e-mail.';
    res.status(status).json({ error: msg });
    return;
  }

  auditLog('update_user_email', req.requesterId!, { target_uid: uid, new_email: email });
  res.json({ success: true });
});

// ── Professor invite (uses Resend) ───────────────────────────────────────────

app.post('/api/invite', async (req, res) => {
  const { email, fullName, password, to, name } = req.body as {
    email?: string; fullName?: string; password: string; to?: string; name?: string;
  };
  const recipientEmail = email || to;
  const recipientName = fullName || name;

  if (!recipientEmail || !recipientName || !password) {
    res.status(400).json({ error: 'email, fullName e password são obrigatórios.' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[IV] RESEND_API_KEY não configurada. E-mail de convite não enviado.');
    res.json({ success: true, emailSent: false });
    return;
  }

  try {
    const body = {
      from: 'LMS Platform <notifications@your-domain.com>',
      to: recipientEmail,
      subject: 'Suas credenciais de acesso — LMS Platform',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
          <h2 style="color:#6366f1">LMS Platform</h2>
          <p>Olá, <strong>${recipientName}</strong>!</p>
          <p>Suas credenciais de acesso ao sistema foram criadas:</p>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:8px;font-weight:bold">E-mail:</td><td style="padding:8px">${recipientEmail}</td></tr>
            <tr><td style="padding:8px;font-weight:bold">Senha temporária:</td><td style="padding:8px;font-family:monospace">${password}</td></tr>
          </table>
          <p style="color:#ef4444;font-size:13px">⚠ Você será solicitado a alterar sua senha no primeiro acesso.</p>
          <p><a href="https://demo-lms.netlify.app" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Acessar sistema</a></p>
        </div>
      `,
    };

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json() as { message?: string };
      console.error('[IV] Resend error:', err);
      res.status(500).json({ error: err.message ?? 'Erro ao enviar e-mail.' });
      return;
    }

    res.json({ success: true, emailSent: true });
  } catch (err) {
    console.error('[IV] /api/invite error:', err);
    res.status(500).json({ error: 'Erro interno ao enviar e-mail.' });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[IV Platform] Local API server running on port ${PORT}`);
  console.log('[IV Platform] Note: WebRTC signaling uses Supabase Realtime — not this server.');
});
