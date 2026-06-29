// POST /api/invite
// Sends an invite e-mail with temporary credentials via Resend.
// REQUIRES: caller must be authenticated as coordenação (Supabase JWT in
// Authorization header). Previously open to anonymous callers — that allowed
// phishing via the institutional Resend domain.

import { verifyCoordinator } from './_auth';

export const handler = async (event: {
  httpMethod: string;
  body: string | null;
  headers?: Record<string, string | undefined>;
}) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const auth = await verifyCoordinator(event.headers);
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { email, fullName, password, to, name } = parsed as {
    email?: string;
    fullName?: string;
    password?: string;
    to?: string;
    name?: string;
  };

  // Accept both { email, fullName } and { to, name } for backwards compat
  const recipientEmail = email ?? to;
  const recipientName = fullName ?? name;

  if (!recipientEmail || !recipientName || !password) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'email, fullName e password são obrigatórios.' }),
    };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[IV] RESEND_API_KEY não configurada. E-mail de convite não enviado.');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, emailSent: false }),
    };
  }

  const emailBody = {
    from: 'LMS Education Platform <plataforma@talentsflow.com.br>',
    to: recipientEmail,
    subject: 'Suas credenciais de acesso — LMS Education Platform',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2 style="color:#6366f1">LMS Education Platform</h2>
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

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailBody),
    });

    if (!response.ok) {
      const err = (await response.json()) as { message?: string };
      console.error('[IV] Resend error:', err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message ?? 'Erro ao enviar e-mail.' }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, emailSent: true }) };
  } catch (err) {
    console.error('[IV] /api/invite error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erro interno ao enviar e-mail.' }),
    };
  }
};
