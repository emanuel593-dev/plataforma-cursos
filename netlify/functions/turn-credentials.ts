// GET /api/turn/credentials
//
// Returns short-lived ICE servers (STUN + TURN) issued by Cloudflare Realtime.
// The Cloudflare API token is kept server-side; the client receives only
// ephemeral username/credential pairs (default TTL 24 h).
//
// Env (set in Netlify → Site settings → Environment variables):
//   CLOUDFLARE_TURN_KEY_ID    — TURN Token ID (the path segment in the URL)
//   CLOUDFLARE_TURN_API_TOKEN — Bearer token with Realtime TURN:Edit permission
//   CLOUDFLARE_TURN_TTL       — optional, seconds (default 86400)
//
// Response shape mirrors what RTCPeerConnection expects:
//   { iceServers: RTCIceServer[], ttl: number, expiresAt: string }

import { verifyAuthenticated } from './_auth';

const KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID ?? '';
const API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN ?? '';
const TTL_SECONDS = Number(process.env.CLOUDFLARE_TURN_TTL ?? 86_400);

interface CloudflareIceResponse {
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

export const handler = async (event: {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
}) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed.' }),
    };
  }

  const auth = await verifyAuthenticated(event.headers);
  if (!auth.ok) {
    return {
      statusCode: auth.statusCode,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: auth.error }),
    };
  }

  if (!KEY_ID || !API_TOKEN) {
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        error: 'TURN não configurado. Defina CLOUDFLARE_TURN_KEY_ID e CLOUDFLARE_TURN_API_TOKEN.',
      }),
    };
  }

  try {
    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('[turn-credentials] Cloudflare API error', upstream.status, text);
      return {
        statusCode: 502,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Upstream TURN provider error', status: upstream.status }),
      };
    }

    const data = (await upstream.json()) as CloudflareIceResponse;
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();

    return {
      statusCode: 200,
      headers: {
        ...JSON_HEADERS,
        // Browser caches ~80% of TTL → avoids hitting Cloudflare on every reload.
        'Cache-Control': `private, max-age=${Math.floor(TTL_SECONDS * 0.8)}`,
      },
      body: JSON.stringify({ iceServers: data.iceServers, ttl: TTL_SECONDS, expiresAt }),
    };
  } catch (err) {
    console.error('[turn-credentials] unexpected error', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};
