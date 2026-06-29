import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { listChatMessages, insertChatMessage, listChatMessagesBefore, deleteChatMessage as deleteChatMessageRow } from '../services/chat.service';
import { writeAuditLog } from '../services/audit.service';
import { getAudioPrefs } from '../lib/audioPrefs';

// ── Types ────────────────────────────────────────────────────────────────────

export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'disconnected';

export interface Peer {
  userId: string;
  userName: string;
  stream: MediaStream | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** True when this peer is currently broadcasting their screen via
   *  `getDisplayMedia` (replacing their camera track). Used by the UI
   *  to switch into "presentation mode". */
  screenSharing: boolean;
  connectionQuality: ConnectionQuality;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
}

export interface RoomClosedParticipant {
  userId: string;
  userName: string;
  joinedAt: number;
}

interface PeerConnection {
  pc: RTCPeerConnection;
  userId: string;
  userName: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  /**
   * True if WE created the initial offer for this peer (i.e. we joined later).
   * Tracked so that on renegotiation we know whether it's safe to pre-create
   * a recvonly video transceiver (only the offerer may do so without breaking
   * m-line order in subsequent offers/answers).
   */
  isOfferer: boolean;
  /**
   * Transceiver kept around when we joined audio-only — reused by toggleVideo
   * to upgrade to sendrecv via `transceiver.sender.replaceTrack()`. Without
   * this reference, calling `addTrack()` later would create a SECOND m=video
   * line, duplicating the video section and breaking renegotiation.
   */
  recvonlyVideoTransceiver?: RTCRtpTransceiver;
  /**
   * Symmetric to recvonlyVideoTransceiver — kept when we joined as a pure
   * listener (no mic) or when the initial audio fallback failed. Reused by
   * `toggleAudio` to promote the m=audio line to sendrecv via
   * `transceiver.sender.replaceTrack()` once we actually acquire a mic,
   * without breaking m-line order on the next renegotiation.
   */
  recvonlyAudioTransceiver?: RTCRtpTransceiver;
  // Stable MediaStream reference reused across syncPeers() calls.
  cachedStream?: MediaStream;
  cachedTrackIds?: string;
  // Telemetry: timestamp when the PC was created, used to measure
  // time-to-connect for audit logging.
  connectStartedAt: number;
  // Whether we've already emitted the 'connected' telemetry event for this peer.
  telemetryEmitted?: boolean;
  // Audio telemetry sampling: when sampled (10% of peers), this holds the
  // setInterval handle that emits a `webrtc.audio_snapshot` audit row every
  // 30s. Cleared on peer removal. Auditoria §3.5 #2.
  audioTelemetryInterval?: number;
  /**
   * Per-peer ICE failure counter. After 2 consecutive failures this peer is
   * recreated with iceTransportPolicy='relay' (TURN-only). Kept per-peer so
   * a single failing link doesn't force all other peers into relay mode.
   */
  iceFailureCount: number;
  /**
   * True once this peer has been escalated to TURN relay-only after repeated
   * ICE failures. Tracks per-peer relay state independently of other peers.
   */
  relayOnly: boolean;
}

interface UseWebRTCOptions {
  roomId: string;
  userId: string;
  userName: string;
  /**
   * Authoritative host userId (e.g. the lesson's professor_id). When provided,
   * this overrides the presence-based fallback so host status survives
   * reconnects and is not lost if the host is briefly absent.
   */
  expectedHostId?: string;
  /**
   * If provided, chat messages are persisted to / loaded from
   * `lesson_chat_messages` so late joiners see history.
   */
  scheduledLessonId?: string;
  /**
   * Initial "lesson actually started at" timestamp (ms epoch). Used by the
   * host on reload to restore the running clock without forcing a re-click
   * of "Iniciar aula".
   */
  initialLessonStartedAt?: number | null;
  /** Fired (host only) when the host clicks "Iniciar aula" — for DB persistence. */
  onLessonStarted?: (startedAt: number) => void;
  onKicked?: () => void;
  onRoomClosed?: (participants: RoomClosedParticipant[]) => void;
}

// ── ICE / TURN configuration ────────────────────────────────────────────────
// Three sources, in order of precedence:
//   1. Ephemeral credentials fetched from /api/turn/credentials (Cloudflare).
//      Recommended for production: token stays server-side, credentials TTL
//      ~24 h. Loaded lazily on first use and refreshed before expiry.
//   2. Static VITE_TURN_* envs baked at build time. Useful for self-hosted
//      coturn or local dev where you don't want a Netlify Function call.
//   3. STUN-only fallback (Google public STUN). ~30 % of users behind
//      symmetric NAT (corporate, 4G/5G, hotel) will fail to connect.

const STATIC_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function getStaticTurnFromEnv(): RTCIceServer | null {
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;
  if (!turnUrl || !turnUsername || !turnCredential) return null;
  return {
    urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
    username: turnUsername,
    credential: turnCredential,
  };
}

interface CachedIce {
  servers: RTCIceServer[];
  // epoch ms when the credentials expire and a refresh should be triggered
  expiresAt: number;
}

let iceCache: CachedIce | null = null;
let inflightFetch: Promise<RTCIceServer[]> | null = null;

const TURN_ENDPOINT = '/api/turn/credentials';
const TURN_REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

async function fetchEphemeralIceServers(): Promise<RTCIceServer[]> {
  const { authHeaders } = await import('../lib/apiAuth');
  const res = await fetch(TURN_ENDPOINT, {
    method: 'GET',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`TURN endpoint returned ${res.status}`);
  const data = (await res.json()) as {
    iceServers: RTCIceServer[];
    ttl?: number;
    expiresAt?: string;
  };
  if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
    throw new Error('TURN endpoint returned no iceServers');
  }
  const expiresAt = data.expiresAt
    ? new Date(data.expiresAt).getTime() - TURN_REFRESH_SAFETY_WINDOW_MS
    : Date.now() + (data.ttl ? data.ttl * 1000 : 3600_000) - TURN_REFRESH_SAFETY_WINDOW_MS;
  iceCache = { servers: data.iceServers, expiresAt };
  return data.iceServers;
}

/** Resolve ICE servers using cache → ephemeral fetch → static env → STUN-only. */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  // 1. Prefer static env override if present (skip remote fetch entirely)
  const staticTurn = getStaticTurnFromEnv();
  if (staticTurn) return [...STATIC_STUN_SERVERS, staticTurn];

  // 2. Cached and still valid
  if (iceCache && iceCache.expiresAt > Date.now()) return iceCache.servers;

  // 3. Coalesce concurrent callers into a single in-flight request
  if (!inflightFetch) {
    inflightFetch = fetchEphemeralIceServers().catch((err) => {
      console.warn('[IV] Failed to fetch ephemeral TURN credentials, falling back to STUN-only:', err);
      if (import.meta.env.PROD) {
        console.warn(
          '[IV] TURN indisponível. Conexões atrás de NAT simétrico (corporativo / 4G) podem falhar.',
        );
      }
      return STATIC_STUN_SERVERS;
    }).finally(() => {
      inflightFetch = null;
    });
  }
  return inflightFetch;
}

/** Synchronous accessor — returns last cached config or STUN-only.
 *  Always pair with loadIceServers() preload at hook init. */
function getCachedIceServers(): RTCIceServer[] {
  if (iceCache && iceCache.expiresAt > Date.now()) return iceCache.servers;
  const staticTurn = getStaticTurnFromEnv();
  if (staticTurn) return [...STATIC_STUN_SERVERS, staticTurn];
  return STATIC_STUN_SERVERS;
}

export function hasTurnServers(servers: RTCIceServer[]): boolean {
  return servers.some(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'));
  });
}

function buildIceConfig(): RTCConfiguration {
  return {
    iceServers: getCachedIceServers(),
    // Bundle all media on a single transport — saves ~20% bandwidth on 3G/4G
    // and reduces ICE checks (Android low-end CPU benefit).
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
  };
}

/** Force TURN-only relay. Used as fallback when initial connect fails on
 *  symmetric NAT (common on Brazilian mobile carriers). */
function buildRelayOnlyConfig(): RTCConfiguration {
  return { ...buildIceConfig(), iceTransportPolicy: 'relay' };
}

// ── Telemetry ──────────────────────────────────────────────────────────────
// One audit event per peer-connect tells us, in production:
//   - what % of clients need TURN (relay) vs direct (host/srflx)
//   - p50/p95 time-to-connect by network
//   - whether relay-only escalation is being triggered
// Cardinality is bounded: ~5 events per student per lesson.

export interface IceWinningCandidate {
  type: RTCIceCandidateType | 'unknown';
  protocol?: string;
  address?: string;
  port?: number;
  rttMs?: number;
}

/** Extract the chosen local ICE candidate from getStats(). Works in Chromium
 *  and Firefox; on Safari we may only get partial info but never throws. */
export async function getWinningCandidate(pc: RTCPeerConnection): Promise<IceWinningCandidate> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    let rttMs: number | undefined;
    stats.forEach((report) => {
      if (
        report.type === 'candidate-pair' &&
        (report.state === 'succeeded' || (report as RTCIceCandidatePairStats & { nominated?: boolean }).nominated)
      ) {
        pairId = (report as RTCIceCandidatePairStats).localCandidateId;
        const rtt = (report as RTCIceCandidatePairStats).currentRoundTripTime;
        if (typeof rtt === 'number') rttMs = Math.round(rtt * 1000);
      }
    });
    if (!pairId) return { type: 'unknown' };
    const local = stats.get(pairId) as
      | { candidateType?: RTCIceCandidateType; address?: string; port?: number; protocol?: string }
      | undefined;
    if (!local) return { type: 'unknown', rttMs };
    return {
      type: (local.candidateType as RTCIceCandidateType) ?? 'unknown',
      protocol: local.protocol,
      address: local.address,
      port: local.port,
      rttMs,
    };
  } catch {
    return { type: 'unknown' };
  }
}

interface WebRtcTelemetryContext {
  actorId: string;
  roomId: string;
  scheduledLessonId?: string | null;
  remoteUserId: string;
  connectStartedAt: number;
  relayOnly: boolean;
}

async function emitWebRtcTelemetry(pc: RTCPeerConnection, ctx: WebRtcTelemetryContext): Promise<void> {
  try {
    const winning = await getWinningCandidate(pc);
    const timeToConnectMs = Math.round(performance.now() - ctx.connectStartedAt);
    await writeAuditLog({
      actor_id: ctx.actorId,
      action: 'webrtc.peer_connected',
      entity: 'webrtc_session',
      entity_id: ctx.scheduledLessonId ?? ctx.roomId,
      details: {
        room_id: ctx.roomId,
        scheduled_lesson_id: ctx.scheduledLessonId ?? null,
        remote_user_id: ctx.remoteUserId,
        candidate_type: winning.type,
        protocol: winning.protocol,
        rtt_ms: winning.rttMs,
        time_to_connect_ms: timeToConnectMs,
        relay_only_mode: ctx.relayOnly,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : null,
      },
    });
  } catch (err) {
    // Telemetry must never break the call.
    console.warn('[IV] WebRTC telemetry failed:', err);
  }
}

// ── Audio quality snapshot (auditoria §3.5 #2) ───────────────────────────────
// Diagnóstico para H1 (AGC) e H3 (BWE). Capturado a cada 30 s em ~10% dos
// peers conectados, com payload pequeno (não polui audit_logs).
interface AudioSnapshotPrev {
  packetsSent?: number;
  packetsLost?: number;
  bytesSent?: number;
}

async function emitAudioSnapshot(
  pc: RTCPeerConnection,
  ctx: WebRtcTelemetryContext,
  prev: AudioSnapshotPrev,
): Promise<AudioSnapshotPrev> {
  try {
    if (pc.connectionState !== 'connected') return prev;
    const stats = await pc.getStats();
    let outTargetBitrate: number | null = null;
    let outPacketsSent: number | null = null;
    let outBytesSent: number | null = null;
    let inJitter: number | null = null;
    let inPacketsLost: number | null = null;
    let inAudioLevel: number | null = null;
    stats.forEach((report) => {
      const r = report as RTCStats & Record<string, unknown>;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') {
        outTargetBitrate = (r['targetBitrate'] as number | undefined) ?? outTargetBitrate;
        outPacketsSent = (r['packetsSent'] as number | undefined) ?? outPacketsSent;
        outBytesSent = (r['bytesSent'] as number | undefined) ?? outBytesSent;
      } else if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        inJitter = (r['jitter'] as number | undefined) ?? inJitter;
        inPacketsLost = (r['packetsLost'] as number | undefined) ?? inPacketsLost;
        inAudioLevel = (r['audioLevel'] as number | undefined) ?? inAudioLevel;
      }
    });

    const lostDelta = (inPacketsLost ?? 0) - (prev.packetsLost ?? 0);
    const sentDelta = (outPacketsSent ?? 0) - (prev.packetsSent ?? 0);

    await writeAuditLog({
      actor_id: ctx.actorId,
      action: 'webrtc.audio_snapshot',
      entity: 'webrtc_session',
      entity_id: ctx.scheduledLessonId ?? ctx.roomId,
      details: {
        room_id: ctx.roomId,
        scheduled_lesson_id: ctx.scheduledLessonId ?? null,
        remote_user_id: ctx.remoteUserId,
        out_target_bitrate: outTargetBitrate,
        out_packets_sent: outPacketsSent,
        out_packets_sent_delta: sentDelta,
        out_bytes_sent: outBytesSent,
        in_jitter_s: inJitter,
        in_packets_lost: inPacketsLost,
        in_packets_lost_delta: lostDelta,
        in_audio_level: inAudioLevel,
      },
    });
    return {
      packetsSent: outPacketsSent ?? prev.packetsSent,
      packetsLost: inPacketsLost ?? prev.packetsLost,
      bytesSent: outBytesSent ?? prev.bytesSent,
    };
  } catch (err) {
    console.warn('[IV] audio snapshot failed:', err);
    return prev;
  }
}

const AUDIO_TELEMETRY_SAMPLE_RATE = 0.1;     // 10% dos peers
const AUDIO_TELEMETRY_INTERVAL_MS = 30_000;  // a cada 30s

// ── Adaptive media constraints ─────────────────────────────────────────────
// Capping resolution/framerate is critical on Android low-end devices, where
// requesting 1080p@30fps via empty `{video:true}` saturates the encoder and
// causes frame drops, lag, and battery drain. We also enable AEC/NS/AGC.

function getDefaultAudioConstraints(): MediaTrackConstraints {
  // Lê preferências por-device (localStorage). Default: AGC desligado, EC/NS ligados.
  // Ver auditoria §3.5 #1 (H1 — AGC era a causa mais provável da "queda gradual" de áudio).
  const prefs = getAudioPrefs();
  return {
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl,
    channelCount: 1,
  };
}

function getDefaultVideoConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: 640, max: 1280 },
    height: { ideal: 480, max: 720 },
    frameRate: { ideal: 24, max: 30 },
    facingMode: 'user',
  };
}

/** Try a getUserMedia constraint set, falling back through progressively
 *  weaker constraints on OverconstrainedError / NotReadableError.
 *
 *  Fallback ladder (audio is critical and tried in three tiers):
 *    1. Original (full) audio + video constraints
 *    2. Original audio       + low-res video baseline
 *    3. Minimal audio (no AEC/NS/AGC) + low-res video baseline
 *    4. Audio without device pinning (drop deviceId.exact) + low-res video
 *
 *  Tier 3 rescues legacy USB mics / iOS hardware that can't run AEC+NS+AGC
 *  simultaneously: previously the retry kept the same audio constraints and
 *  failed for the same reason, leaving the user without any microphone. */
async function getUserMediaWithFallback(
  audio: boolean | MediaTrackConstraints,
  video: boolean | MediaTrackConstraints,
): Promise<MediaStream> {
  const audioConstraint = audio === true ? getDefaultAudioConstraints() : audio;
  const videoConstraint = video === true ? getDefaultVideoConstraints() : video;
  const lowResVideo: MediaTrackConstraints = {
    width: { max: 320 },
    height: { max: 240 },
    frameRate: { max: 15 },
  };
  const wantAudio = audio !== false;
  const wantVideo = video !== false;

  // Tier 1 — exact constraints requested by caller.
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: wantAudio ? audioConstraint : false,
      video: wantVideo ? videoConstraint : false,
    });
  } catch (err1) {
    const isRecoverable = err1 instanceof DOMException
      && (err1.name === 'OverconstrainedError' || err1.name === 'NotReadableError');
    if (!isRecoverable) throw err1;

    // Tier 2 — keep audio, drop video to baseline.
    console.warn('[IV] Media constraints too strict, retrying with low-res video baseline:', err1.name);
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: wantAudio ? audioConstraint : false,
        video: wantVideo ? lowResVideo : false,
      });
    } catch (err2) {
      const isRecov2 = err2 instanceof DOMException
        && (err2.name === 'OverconstrainedError' || err2.name === 'NotReadableError');
      if (!isRecov2 || !wantAudio) throw err2;

      // Tier 3 — minimal audio (rescues mics that reject AEC/NS/AGC combos).
      console.warn('[IV] Audio constraints too strict, retrying with minimal audio profile:', err2.name);
      const minimalAudio: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: minimalAudio,
          video: wantVideo ? lowResVideo : false,
        });
      } catch (err3) {
        // Tier 4 — drop deviceId.exact pinning (some Android devices reject
        // exact deviceId after a permission grant cycle).
        const hasDevicePin = typeof audioConstraint === 'object'
          && audioConstraint !== null
          && 'deviceId' in (audioConstraint as Record<string, unknown>);
        if (!hasDevicePin) throw err3;
        console.warn('[IV] Retrying without exact deviceId pinning');
        return await navigator.mediaDevices.getUserMedia({
          audio: minimalAudio,
          video: wantVideo ? lowResVideo : false,
        });
      }
    }
  }
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000;
// Heartbeat: each connected peer broadcasts a lightweight ping every
// HEARTBEAT_INTERVAL_MS. If no ping is received for ZOMBIE_THRESHOLD_MS
// (3× the interval), the peer is declared zombie and evicted — catching
// hard crashes, OS kills, and frozen tabs where RTCPeerConnection.connectionState
// can stay 'connected' even after the remote process has died.
const HEARTBEAT_INTERVAL_MS = 15_000;
const ZOMBIE_THRESHOLD_MS   = 45_000;

// In-memory chat retains everything received during the session up to a
// soft RAM ceiling. The underlying lesson_chat_messages table is the
// durable store; older messages remain accessible via
// listChatMessagesBefore() / loadOlderMessages(). The cap protects long
// (4h+) sessions from unbounded array growth without hurting normal
// scroll-back — 2000 msgs ≈ 300 KB.
// Implementation lives in src/lib/mediaQuality so it can be unit-tested
// in isolation. We re-export so existing imports keep working.
import { appendChat, shouldAutoDegrade, shouldDegradeUplink } from '../lib/mediaQuality';
export { appendChat, CHAT_RAM_SOFT_CAP } from '../lib/mediaQuality';
export { shouldDegradeUplink } from '../lib/mediaQuality';

// ── Bitrate caps for mesh topology ───────────────────────────────────────────
// In a mesh, each participant uploads N-1 streams. Capping per-stream bitrate
// keeps total upload sane on consumer connections.
const MAX_VIDEO_BITRATE = 350_000;   // 350 kbps per peer (camera)
const MAX_SCREEN_BITRATE = 800_000;  // 800 kbps per peer (screen share)
const MAX_AUDIO_BITRATE = 40_000;    // 40 kbps per peer (Opus)

// ── SDP munging para Opus (auditoria §3.5 #3, mitiga H3 BWE) ─────────────────
// Força flags úteis nos `a=fmtp:<pt> ...` da m=audio:
//   * useinbandfec=1  → ativa Forward Error Correction in-band do Opus.
//                       Recupera ~30% de pacotes perdidos sem retransmissão.
//   * usedtx=0        → desliga DTX (silencia emissão em silêncio). Evita
//                       que o decoder precise interpolar e produza áudio
//                       "abafado" depois de pausas longas do professor.
//   * maxaveragebitrate=40000 → reforça o cap mesmo sob pressão do BWE,
//                       caso o `setParameters` não tenha pegado.
//   * stereo=0; sprop-stereo=0 → mono explícito (já é o nosso channelCount=1).
const OPUS_FMTP_PARAMS: Record<string, string> = {
  useinbandfec: '1',
  usedtx: '0',
  maxaveragebitrate: String(MAX_AUDIO_BITRATE),
  stereo: '0',
  'sprop-stereo': '0',
};

function mungeOpusSdp(sdp: string): string {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r?\n/);
  // 1. Localizar o payload type do Opus na primeira m=audio.
  const opusPts: string[] = [];
  let inAudio = false;
  for (const line of lines) {
    if (line.startsWith('m=')) inAudio = line.startsWith('m=audio');
    if (inAudio && /^a=rtpmap:(\d+)\s+opus\/48000/i.test(line)) {
      const m = line.match(/^a=rtpmap:(\d+)/);
      if (m) opusPts.push(m[1]);
    }
  }
  if (opusPts.length === 0) return sdp;

  // 2. Para cada PT do Opus, garantir/atualizar a linha a=fmtp:<pt> ...
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
    if (fmtpMatch && opusPts.includes(fmtpMatch[1])) {
      const pt = fmtpMatch[1];
      const existing = fmtpMatch[2].split(';').map((p) => p.trim()).filter(Boolean);
      const map = new Map<string, string>();
      for (const p of existing) {
        const eq = p.indexOf('=');
        if (eq > 0) map.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
        else map.set(p, '');
      }
      for (const [k, v] of Object.entries(OPUS_FMTP_PARAMS)) map.set(k, v);
      const merged = Array.from(map.entries())
        .map(([k, v]) => (v === '' ? k : `${k}=${v}`))
        .join(';');
      out.push(`a=fmtp:${pt} ${merged}`);
      seen.add(pt);
    } else {
      out.push(line);
    }
  }

  // 3. Para PTs que não tinham a=fmtp, adicionar logo após o respectivo a=rtpmap.
  if (seen.size < opusPts.length) {
    const finalOut: string[] = [];
    for (const line of out) {
      finalOut.push(line);
      const m = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
      if (m && !seen.has(m[1])) {
        const merged = Object.entries(OPUS_FMTP_PARAMS)
          .map(([k, v]) => `${k}=${v}`)
          .join(';');
        finalOut.push(`a=fmtp:${m[1]} ${merged}`);
        seen.add(m[1]);
      }
    }
    return finalOut.join('\r\n');
  }
  return out.join('\r\n');
}

async function applySenderBitrate(
  sender: RTCRtpSender,
  maxBitrate: number,
  degradationPreference?: RTCDegradationPreference,
): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    for (const enc of params.encodings) {
      enc.maxBitrate = maxBitrate;
    }
    // 'maintain-framerate' suits camera (motion); 'maintain-resolution'
    // suits screen share (text legibility). Either one cuts encoder CPU
    // significantly when bandwidth is constrained.
    if (degradationPreference) {
      (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference })
        .degradationPreference = degradationPreference;
    }
    await sender.setParameters(params);
  } catch (err) {
    console.warn('[IV] Failed to apply bitrate cap:', err);
  }
}

/** Dynamic per-peer cap: in mesh, total upload = (N-1) × cap. We keep the
 *  global ceiling around 1.4 Mbps regardless of room size, with a 150 kbps
 *  floor so quality stays usable. */
function videoBitrateForPeerCount(peerCount: number): number {
  return peerCount <= 2
    ? MAX_VIDEO_BITRATE
    : Math.max(150_000, Math.floor(MAX_VIDEO_BITRATE * 2 / peerCount));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWebRTC({ roomId, userId, userName, expectedHostId, scheduledLessonId, initialLessonStartedAt, onLessonStarted, onKicked, onRoomClosed }: UseWebRTCOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const peersRef = useRef<Map<string, PeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Per-peer recovery timers: when a peer enters 'disconnected' we wait before
  // tearing down so transient network blips (Wi-Fi handoff, cell fluctuation)
  // can self-heal without triggering a full reconnect cycle.
  const disconnectTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Per-peer ICE candidate buffer: stores candidates that arrive before
  // setRemoteDescription is called (broadcast delivery races the async
  // offer/answer flow). Flushed inside the offer/answer handlers.
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Heartbeat intervals and per-peer last-seen timestamps for zombie detection.
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const zombieWatchdog    = useRef<ReturnType<typeof setInterval> | null>(null);
  const peerLastSeen      = useRef<Map<string, number>>(new Map());

  // Keep callbacks in refs so socket handlers always call the latest version
  const onKickedRef = useRef(onKicked);
  onKickedRef.current = onKicked;
  // Per-peer ICE failure tracking and relay escalation are now stored directly
  // in each PeerConnection entry (peer.iceFailureCount / peer.relayOnly).
  // This prevents a single failing peer-link from forcing ALL other peers into
  // TURN relay-only mode. (Auditoria §6 Falha Média — fix applied 2026-06-17)
  const onRoomClosedRef = useRef(onRoomClosed);
  onRoomClosedRef.current = onRoomClosed;
  const onLessonStartedRef = useRef(onLessonStarted);
  onLessonStartedRef.current = onLessonStarted;

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [isHost, setIsHost] = useState(false);
  // True while the authoritative host (expectedHostId or earliest joiner)
  // is physically tracked in Supabase Presence. Used by ClassroomView to
  // open Gate 1 for students before the host clicks "Iniciar Aula".
  const [hostIsPresent, setHostIsPresent] = useState(false);
  // Tracks the current host's userId so clients can verify that
  // sensitive broadcasts (mute-remote, kicked, room-closed) actually
  // come from the host. Determined by earliest joinedAt in presence.
  const hostUserIdRef = useRef<string | null>(null);
  // True when the host is actively recording — broadcast to all
  // participants so non-hosts can show an informational consent banner.
  const [isRemoteRecordingActive, setIsRemoteRecordingActive] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);

  const [connected, setConnected] = useState(false);
  const [turnAvailable, setTurnAvailable] = useState<boolean | null>(null);
  
  // Preload ephemeral TURN credentials (or static env override) once when the
  // hook mounts. Coalesced + cached at module scope, so multiple concurrent
  // hooks share a single fetch.
  useEffect(() => {
    void loadIceServers().then(servers => {
      setTurnAvailable(hasTurnServers(servers));
    });
  }, []);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>('good');
  // Sprint 4.2/4.3: explicit "economy mode" — video off + a UI banner so the
  // user understands why their camera dropped. Manually toggleable via
  // setEconomyMode(); also auto-engaged after 2 consecutive 'poor' samples
  // (4.3) when the user has video enabled.
  const [economyMode, setEconomyMode] = useState(false);
  const [autoDegraded, setAutoDegraded] = useState(false);
  const consecutivePoorRef = useRef(0);
  // Uplink saturation detection (Auditoria §6 Falha Crítica).
  // Tracks consecutive cycles where the local video encoder was bandwidth-
  // limited on the SEND side — invisible to the downlink-only 'poor' checker.
  const consecutiveUplinkPoorRef = useRef(0);
  // Accumulates qualityLimitationDurations.bandwidth from the previous stats
  // cycle so we can compute a per-cycle delta. Keyed by peer userId but since
  // this is the LOCAL sender it's the same track across all peers; we use a
  // single scalar (the first video sender found) to keep it simple.
  const prevBandwidthLimitedSecsRef = useRef(0);
  // Sprint 4.3 fix: timestamp of the user's most recent manual video toggle
  // (re-enable). The auto-degrade watcher refuses to act for the cooldown
  // window (see AUTO_DEGRADE_COOLDOWN_MS in src/lib/mediaQuality) after a
  // manual re-enable so a stubborn user on a poor link doesn't see the
  // camera flicker on/off every 10 s.
  const lastManualVideoEnableRef = useRef<number>(0);
  const joinedAtRef = useRef<number>(0);
  // Authoritative "aula realmente começou" timestamp. Distinct from joinedAt:
  // joinedAt = when this client connected to the room; lessonStartedAt = when
  // the host explicitly clicked "Iniciar aula". Cronometer + report duration
  // + auto-attendance ratio all key off this.
  const [lessonStartedAt, setLessonStartedAt] = useState<number | null>(initialLessonStartedAt ?? null);
  const lessonStartedAtRef = useRef<number | null>(initialLessonStartedAt ?? null);
  // Sync the prop → state/ref when it arrives asynchronously (e.g. host
  // reloading mid-lesson: ClassroomView loads `sl.started_at` in an effect
  // that resolves AFTER the hook mounts). First-write-wins to avoid clobbering
  // a value already received via broadcast.
  useEffect(() => {
    if (initialLessonStartedAt && lessonStartedAtRef.current === null) {
      lessonStartedAtRef.current = initialLessonStartedAt;
      setLessonStartedAt(initialLessonStartedAt);
    }
  }, [initialLessonStartedAt]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Re-cap every existing video sender when the peer count changes so the
  // global upload ceiling stays bounded as participants join/leave.
  const lastVideoCapRef = useRef<number>(0);
  const rebalanceVideoBitrate = useCallback(() => {
    const cap = videoBitrateForPeerCount(peersRef.current.size + 1);
    if (cap === lastVideoCapRef.current) return;
    lastVideoCapRef.current = cap;
    // Don't touch screen-share senders (their cap is higher and intentional).
    const screenTrackId = screenStreamRef.current?.getVideoTracks()[0]?.id;
    peersRef.current.forEach((peer) => {
      peer.pc.getSenders().forEach((sender) => {
        if (sender.track?.kind !== 'video') return;
        if (screenTrackId && sender.track.id === screenTrackId) return;
        void applySenderBitrate(sender, cap, 'maintain-framerate');
      });
    });
  }, []);

  const syncPeers = useCallback(() => {
    const list: Peer[] = [];
    peersRef.current.forEach((pc) => {
      // Cache the MediaStream per peer so the React `stream` reference stays
      // stable across renders. Recreating the stream on every sync caused
      // <video> elements to re-attach srcObject and (on some mobile motors)
      // briefly drop frames + leak GC pressure.
      let cached = pc.cachedStream;
      const receivers = pc.pc.getReceivers().filter((r) => r.track);
      const trackIds = receivers.map((r) => r.track.id).sort().join('|');
      if (!cached || pc.cachedTrackIds !== trackIds) {
        cached = new MediaStream();
        receivers.forEach((r) => cached!.addTrack(r.track));
        pc.cachedStream = cached;
        pc.cachedTrackIds = trackIds;
      }
      list.push({
        userId: pc.userId,
        userName: pc.userName,
        stream: cached.getTracks().length > 0 ? cached : null,
        audioEnabled: pc.audioEnabled,
        videoEnabled: pc.videoEnabled,
        screenSharing: pc.screenSharing,
        connectionQuality: mapConnectionState(pc.pc.connectionState),
      });
    });
    setPeers(list);
    rebalanceVideoBitrate();
  }, [rebalanceVideoBitrate]);

  function mapConnectionState(state: RTCPeerConnectionState): ConnectionQuality {
    switch (state) {
      case 'connected': return 'excellent';
      case 'connecting': return 'good';
      case 'disconnected': return 'poor';
      case 'failed': case 'closed': return 'disconnected';
      default: return 'good';
    }
  }

  // ── Peer connection factory ────────────────────────────────────────────────

  const createPeerConnection = useCallback(
    (remoteUserId: string, remoteUserName: string, isOfferer: boolean): RTCPeerConnection => {
      // Close existing if any
      const existing = peersRef.current.get(remoteUserId);
      if (existing) {
        const existingTimer = disconnectTimers.current.get(remoteUserId);
        if (existingTimer) { clearTimeout(existingTimer); disconnectTimers.current.delete(remoteUserId); }
        if (existing.audioTelemetryInterval !== undefined) {
          clearInterval(existing.audioTelemetryInterval);
        }
        existing.pc.close();
        peersRef.current.delete(remoteUserId);
      }

      // Per-peer relay state: check if a previous PC for this peer had already
      // escalated to relay-only before being torn down (existing?.relayOnly).
      const wasRelayOnly = existing?.relayOnly ?? false;
      const pc = new RTCPeerConnection(wasRelayOnly ? buildRelayOnlyConfig() : buildIceConfig());
      let recvonlyVideoTransceiver: RTCRtpTransceiver | undefined;
      let recvonlyAudioTransceiver: RTCRtpTransceiver | undefined;

      const hasLocalAudio = !!localStreamRef.current?.getAudioTracks().length;
      const hasLocalVideo = !!localStreamRef.current?.getVideoTracks().length;

      if (localStreamRef.current) {
        const videoCap = videoBitrateForPeerCount(peersRef.current.size + 1);
        localStreamRef.current.getTracks().forEach((track) => {
          const sender = pc.addTrack(track, localStreamRef.current!);
          if (track.kind === 'video') {
            try { (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion'; } catch { /* noop */ }
            void applySenderBitrate(sender, videoCap, 'maintain-framerate');
          } else if (track.kind === 'audio') {
            void applySenderBitrate(sender, MAX_AUDIO_BITRATE);
          }
        });
      }
      // For devices missing a given media kind (no camera → no video track;
      // no mic OR full listener → no audio track), pre-create a recvonly
      // transceiver so the offer SDP still carries that m-line. Without it:
      //   • answerer has no m=<kind> to map its track to → can't send to us;
      //   • a pure listener (null stream) would emit an EMPTY offer with NO
      //     m-lines, so no media would flow in either direction → the
      //     classic "I can hear no one and no one can hear me" symptom on
      //     cameraless / mic-denied devices.
      //
      // CRITICAL: only the OFFERER may pre-create transceivers. If the
      // answerer pre-creates one before processing the remote offer, the
      // local m-line order diverges from the offer's, and subsequent
      // negotiations fail with "The order of m-lines in subsequent offer
      // doesn't match". The answerer gets recvonly transceivers implicitly
      // from setRemoteDescription() when the offer advertises them.
      if (isOfferer && !hasLocalVideo) {
        try {
          recvonlyVideoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
        } catch (err) {
          console.warn('[IV] addTransceiver(video recvonly) failed:', err);
        }
      }
      if (isOfferer && !hasLocalAudio) {
        try {
          recvonlyAudioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
        } catch (err) {
          console.warn('[IV] addTransceiver(audio recvonly) failed:', err);
        }
      }

      pc.onicecandidate = (event) => {
        if (event.candidate && channelRef.current) {
          channelRef.current.send({
            type: 'broadcast',
            event: 'ice-candidate',
            payload: { target: remoteUserId, candidate: event.candidate, userId },
          });
        }
      };

      // Guard against concurrent offers (e.g. addTrack triggers
      // negotiationneeded while presence handler is also offering).
      //
      // Old behaviour: silently dropped the renegotiation if not 'stable'.
      // That caused a real audio/video bug: a track added during
      // 'have-local-offer' was never advertised to the remote peer, so the
      // remote never received the new m-line and the corresponding stream.
      //
      // New behaviour: poll signalingState briefly and retry once it returns
      // to 'stable'. Capped at ~3s to avoid deadlock on stuck negotiations.
      pc.onnegotiationneeded = async () => {
        // Skip if the initial offer/answer hasn't completed yet.  When addTrack /
        // addTransceiver are called inside createPeerConnection, onnegotiationneeded
        // fires immediately with signalingState='stable' but remoteDescription=null
        // (brand-new PC).  Without this guard the handler races with the presence /
        // offer-broadcast handler, each sending a separate "initial" offer (glare).
        // The remote closes its first PC and opens a second one; the audio-only
        // device ends up connected to the closed PC → its audio never reaches anyone.
        // All legitimate renegotiations (screen-share, bitrate change, reconnect)
        // happen only after setRemoteDescription has been called at least once.
        if (!pc.remoteDescription) return;

        const NEGOTIATION_WAIT_MS = 3000;
        const POLL_INTERVAL_MS = 50;
        const deadline = Date.now() + NEGOTIATION_WAIT_MS;
        while (pc.signalingState !== 'stable' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (pc.signalingState !== 'stable') {
          console.warn('[IV] negotiationneeded: peer never returned to stable; deferring',
            { remoteUserId, signalingState: pc.signalingState });
          return; // Remote-driven negotiation will catch up next round.
        }
        try {
          // Reaplica o cap de bitrate em todos os senders ANTES da renegotiation
          // (auditoria §3.5 #4). Em renegoções (screen-share, recriação de
          // sender), o `setParameters` aplicado no addTrack original pode ter
          // sido perdido. Reforçar aqui é barato e evita estouro de banda.
          for (const sender of pc.getSenders()) {
            if (!sender.track) continue;
            if (sender.track.kind === 'audio') {
              void applySenderBitrate(sender, MAX_AUDIO_BITRATE);
            } else if (sender.track.kind === 'video') {
              const videoCap = videoBitrateForPeerCount(peersRef.current.size + 1);
              void applySenderBitrate(sender, videoCap, 'maintain-framerate');
            }
          }

          const offer = await pc.createOffer();
          // Re-check after the await: another negotiation could have raced in.
          if (pc.signalingState !== 'stable') {
            console.warn('[IV] negotiationneeded: state shifted during createOffer; aborting');
            return;
          }
          if (offer.sdp) offer.sdp = mungeOpusSdp(offer.sdp);
          await pc.setLocalDescription(offer);
          channelRef.current?.send({
            type: 'broadcast',
            event: 'offer',
            payload: { target: remoteUserId, sdp: offer, userId, userName },
          });
        } catch (err) {
          console.error('[IV] Error during renegotiation:', err);
        }
      };

      pc.ontrack = () => {
        syncPeers();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          // Cancel any pending disconnect timer — peer recovered from transient drop.
          const pendingTimer = disconnectTimers.current.get(remoteUserId);
          if (pendingTimer) { clearTimeout(pendingTimer); disconnectTimers.current.delete(remoteUserId); }
          // Telemetry: report ICE outcome once per peer to audit_logs.
          // We capture the winning candidate type (host/srflx/relay), RTT,
          // time-to-connect, and whether we were forced into relay-only.
          const peer = peersRef.current.get(remoteUserId);
          if (peer && !peer.telemetryEmitted) {
            peer.telemetryEmitted = true;
            void emitWebRtcTelemetry(pc, {
              actorId: userId,
              roomId,
              scheduledLessonId,
              remoteUserId,
              connectStartedAt: peer.connectStartedAt,
              relayOnly: peer.relayOnly,
            });

            // Audio snapshot sampling — 10% dos peers logam estatísticas a
            // cada 30 s para diagnóstico de áudio (auditoria §3.5 #2).
            if (Math.random() < AUDIO_TELEMETRY_SAMPLE_RATE) {
              const ctx = {
                actorId: userId,
                roomId,
                scheduledLessonId,
                remoteUserId,
                connectStartedAt: peer.connectStartedAt,
                relayOnly: peer.relayOnly,
              };
              let prev: AudioSnapshotPrev = {};
              peer.audioTelemetryInterval = window.setInterval(async () => {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
                prev = await emitAudioSnapshot(pc, ctx, prev);
              }, AUDIO_TELEMETRY_INTERVAL_MS);
            }
          }
        }
        if (pc.connectionState === 'failed') {
          // First attempt: in-place ICE restart (lightweight).
          // Second attempt: escalate THIS PEER to TURN-only and rebuild it.
          // Per-peer counters prevent a single failing link from forcing all
          // other peers into relay mode. (Auditoria §6 Falha Média fix)
          const peerEntry = peersRef.current.get(remoteUserId);
          if (peerEntry) peerEntry.iceFailureCount += 1;
          const peerIceFailures = peerEntry?.iceFailureCount ?? 1;
          const peerRelayOnly   = peerEntry?.relayOnly ?? false;
          if (peerIceFailures >= 2 && !peerRelayOnly) {
            const currentIceServers = getCachedIceServers();
            if (!hasTurnServers(currentIceServers)) {
              // Auditoria §6 Fix Médio: TURN sem confirmação.
              // O relayOnly exige TURN. Se só tivermos STUN, recriar em relay-only
              // vai garantir que a conexão nunca mais volte (0 candidatos).
              // Em vez disso, continuamos tentando um ICE restart normal.
              console.warn('[IV] Repeated ICE failures, but no TURN server available. Proceeding with STUN in-place restart.');
              pc.restartIce();
            } else {
              console.warn('[IV] Repeated ICE failures for peer', remoteUserId,
                '— escalating this peer to TURN relay-only (other peers unaffected)');
              if (peerEntry) peerEntry.relayOnly = true;
              const wasOfferer = peerEntry?.isOfferer ?? true;
              try { pc.close(); } catch { /* noop */ }
              peersRef.current.delete(remoteUserId);
              // Recreate with relay-only; the offer will be retried by onnegotiationneeded.
              createPeerConnection(remoteUserId, remoteUserName, wasOfferer);
            }
          } else {
            pc.restartIce();
          }
        }
        if (pc.connectionState === 'disconnected') {
          // 'disconnected' is transient — give WebRTC 7 s to self-heal before
          // tearing down the peer. Removing immediately here was the primary
          // cause of the "multiple drops" regression: every brief network blip
          // (Wi-Fi handoff, cell-signal fluctuation) triggered a full
          // offer/answer/ICE cycle that lasted several seconds.
          if (!disconnectTimers.current.has(remoteUserId)) {
            const timer = setTimeout(() => {
              disconnectTimers.current.delete(remoteUserId);
              const p = peersRef.current.get(remoteUserId);
              if (p && p.pc.connectionState !== 'connected' && p.pc.connectionState !== 'connecting') {
                removePeer(remoteUserId);
              }
            }, 7000);
            disconnectTimers.current.set(remoteUserId, timer);
          }
        }
        if (pc.connectionState === 'closed') {
          removePeer(remoteUserId);
        }
        syncPeers();
      };

      pc.oniceconnectionstatechange = () => {
        syncPeers();
      };

      peersRef.current.set(remoteUserId, {
        pc,
        userId: remoteUserId,
        userName: remoteUserName,
        audioEnabled: true,
        videoEnabled: true,
        screenSharing: false,
        isOfferer,
        recvonlyVideoTransceiver,
        recvonlyAudioTransceiver,
        connectStartedAt: performance.now(),
        iceFailureCount: 0,
        relayOnly: wasRelayOnly,
      });
      return pc;
    },
    [userId, syncPeers, roomId, scheduledLessonId],
  );

  const removePeer = useCallback((remoteUserId: string) => {
    const peer = peersRef.current.get(remoteUserId);
    if (peer) {
      const timer = disconnectTimers.current.get(remoteUserId);
      if (timer) { clearTimeout(timer); disconnectTimers.current.delete(remoteUserId); }
      if (peer.audioTelemetryInterval !== undefined) {
        clearInterval(peer.audioTelemetryInterval);
      }
      peer.pc.close();
      peersRef.current.delete(remoteUserId);
      pendingCandidates.current.delete(remoteUserId);
      peerLastSeen.current.delete(remoteUserId);
      syncPeers();
    }
  }, [syncPeers]);

  // ── Connection quality monitor ─────────────────────────────────────────────

  const startStatsMonitor = useCallback(() => {
    if (statsInterval.current) clearInterval(statsInterval.current);
    statsInterval.current = setInterval(async () => {
      // Skip while tab is hidden — stats don't matter when nobody is looking
      // and getStats() is one of the heavier WebRTC calls (~5-15ms/peer).
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (peersRef.current.size === 0) {
        setConnectionQuality('excellent');
        return;
      }
      let worstQuality: ConnectionQuality = 'excellent';

      // Run getStats in parallel across peers (Promise.all) instead of
      // awaiting sequentially — same wall-clock cost regardless of N.
      const peers = Array.from(peersRef.current.values());

      // ── Uplink saturation check (Auditoria §6 Falha Crítica) ────────────────
      // Read outbound-rtp qualityLimitationDurations from the first active
      // video sender. This is a property of the LOCAL encoder, not of any
      // specific remote peer, so we sample it once per cycle outside the
      // per-peer loop. Safari/Firefox omit this field → we safely fall back to 0.
      let bandwidthLimitedDeltaS = 0;
      try {
        const videoTrack = localStreamRef.current?.getVideoTracks()[0];
        if (videoTrack?.enabled && peers.length > 0) {
          // Use first peer's sender as a representative sample of the local encoder.
          const samplePeer = peers[0];
          const sStats = await samplePeer.pc.getStats();
          sStats.forEach((report) => {
            const r = report as RTCStats & Record<string, unknown>;
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
              const durations = r['qualityLimitationDurations'] as
                | Record<string, number>
                | undefined;
              const currentBwLimited = durations?.['bandwidth'] ?? 0;
              bandwidthLimitedDeltaS = Math.max(
                0,
                currentBwLimited - prevBandwidthLimitedSecsRef.current,
              );
              prevBandwidthLimitedSecsRef.current = currentBwLimited;
            }
          });
        }
      } catch { /* non-fatal — uplink check must never break the call */ }

      const results = await Promise.all(peers.map(async (peer) => {
        try {
          const stats = await peer.pc.getStats();
          let rtt = 0;
          let packetsLost = 0;
          let packetsTotal = 0;
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              rtt = report.currentRoundTripTime ?? 0;
            }
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              packetsLost = report.packetsLost ?? 0;
              packetsTotal = (report.packetsReceived ?? 0) + packetsLost;
            }
          });
          const lossRate = packetsTotal > 0 ? packetsLost / packetsTotal : 0;
          let quality: ConnectionQuality = 'excellent';
          if (rtt > 0.3 || lossRate > 0.1) quality = 'poor';
          else if (rtt > 0.15 || lossRate > 0.03) quality = 'good';
          return quality;
        } catch {
          return 'excellent' as ConnectionQuality;
        }
      }));
      for (const q of results) {
        if (qualityRank(q) > qualityRank(worstQuality)) worstQuality = q;
      }

      setConnectionQuality((prev) => prev === worstQuality ? prev : worstQuality);

      // Sprint 4.3: auto-degrade to audio-only after 2 consecutive 'poor'
      // samples while video is on. This intentionally reads from refs (not
      // the React state) to avoid a stale closure inside the interval.
      if (worstQuality === 'poor') {
        consecutivePoorRef.current += 1;
      } else {
        consecutivePoorRef.current = 0;
      }

      // ── Uplink saturation auto-degrade (Auditoria §6 Falha Crítica) ─────────
      // Counts consecutive cycles where the local video encoder was throttled
      // by insufficient upload bandwidth (>= 40% of the cycle time).
      const uplinkRatio = bandwidthLimitedDeltaS / 5; // STATS_INTERVAL_S
      if (uplinkRatio >= 0.4) { // UPLINK_BANDWIDTH_RATIO_THRESHOLD
        consecutiveUplinkPoorRef.current += 1;
      } else {
        consecutiveUplinkPoorRef.current = 0;
      }

      const now = Date.now();
      const videoCurrentlyEnabled = !!localStreamRef.current?.getVideoTracks()[0]?.enabled;

      // ── Dynamic Soft-Cap (Auditoria Fix Médio) ──────────────────────────────
      // Reduces the video bitrate ceiling immediately upon the first sign of
      // congestion (uplink OR downlink). Gives the encoder a chance to survive
      // without cutting the camera entirely.
      if (localStreamRef.current) {
        const vt = localStreamRef.current.getVideoTracks()[0];
        if (vt?.enabled) {
          const hasCongestion = consecutivePoorRef.current >= 1 || consecutiveUplinkPoorRef.current >= 1;
          const currentCap = videoBitrateForPeerCount(peers.length);
          const softCap = Math.min(150_000, currentCap);
          const targetCap = hasCongestion ? softCap : currentCap;
          
          peers.forEach(peer => {
            const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
              void applySenderBitrate(sender, targetCap, 'maintain-framerate');
            }
          });
        }
      }

      const degradeByDownlink = shouldAutoDegrade({
        consecutivePoor: consecutivePoorRef.current,
        videoEnabled: videoCurrentlyEnabled,
        lastManualVideoEnableMs: lastManualVideoEnableRef.current,
        joinedAtMs: joinedAtRef.current,
        nowMs: now,
      });

      const degradeByUplink = shouldDegradeUplink({
        bandwidthLimitedDeltaS,
        videoEnabled: videoCurrentlyEnabled,
        consecutiveUplinkPoor: consecutiveUplinkPoorRef.current,
        lastManualVideoEnableMs: lastManualVideoEnableRef.current,
        joinedAtMs: joinedAtRef.current,
        nowMs: now,
      });

      if ((degradeByDownlink || degradeByUplink) && localStreamRef.current) {
        const vt = localStreamRef.current.getVideoTracks()[0];
        if (vt) {
          vt.enabled = false;
          setVideoEnabled(false);
          setEconomyMode(true);
          setAutoDegraded(true);
          channelRef.current?.send({
            type: 'broadcast', event: 'peer-state-change',
            payload: { userId, roomId, videoEnabled: false },
          });
          if (degradeByUplink) {
            console.warn('[IV] uplink saturation: auto-degrading to audio-only',
              { bandwidthLimitedDeltaS, consecutiveUplinkPoor: consecutiveUplinkPoorRef.current });
          }
          consecutivePoorRef.current = 0;
          consecutiveUplinkPoorRef.current = 0;
        }
      }
    }, 5000);
  }, [userId, roomId]);

  function qualityRank(q: ConnectionQuality): number {
    return q === 'excellent' ? 0 : q === 'good' ? 1 : q === 'poor' ? 2 : 3;
  }

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    try {
      // Get local media with graceful fallback. We pass our adaptive
      // constraints (capped resolution/fps) on the FIRST attempt to avoid
      // the encoder spinning up at 1080p@30 on capable cameras — this is
      // a major source of CPU/battery drain on long mobile calls.
      let stream: MediaStream | null = null;
      try {
        stream = await getUserMediaWithFallback(true, true);
      } catch (mediaErr) {
        // Check if user denied permissions
        const isDenied = mediaErr instanceof DOMException &&
          (mediaErr.name === 'NotAllowedError' || mediaErr.name === 'PermissionDeniedError');

        try {
          stream = await getUserMediaWithFallback(true, false);
          console.warn('[IV] No camera found, using audio-only');
        } catch {
          console.warn('[IV] No media devices found, joining as listener');
          if (isDenied) {
            console.warn('[IV] User denied media permissions — listener mode');
          }
        }
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      setAudioEnabled(stream?.getAudioTracks().some((t) => t.enabled) ?? false);
      setVideoEnabled(stream?.getVideoTracks().some((t) => t.enabled) ?? false);

      // ── Supabase Realtime channel ──────────────────────────────────────────
      const channel = supabase.channel(`room:${roomId}`, {
        config: { broadcast: { self: false }, presence: { key: userId } },
      });
      channelRef.current = channel;

      // ── Presence: track who is in the room ────────────────────────────────
      channel.on('presence', { event: 'join' }, async ({ newPresences }) => {
        for (const p of newPresences) {
          const remoteUserId = p.userId as string;
          const remoteUserName = p.userName as string;
          if (remoteUserId === userId) continue;

          // Seed heartbeat timestamp so the zombie watchdog doesn't fire
          // before the peer's first ping has had a chance to arrive.
          peerLastSeen.current.set(remoteUserId, Date.now());

          // I am the "later" joiner — send offer
          const pc = createPeerConnection(remoteUserId, remoteUserName, /* isOfferer */ true);
          try {
            const offer = await pc.createOffer();
            if (offer.sdp) offer.sdp = mungeOpusSdp(offer.sdp);
            await pc.setLocalDescription(offer);
            channel.send({
              type: 'broadcast',
              event: 'offer',
              payload: { target: remoteUserId, sdp: offer, userId, userName },
            });
          } catch (err) {
            console.error('[IV] Error creating offer:', err);
          }
          // If I'm the host and the lesson already started, re-broadcast the
          // start timestamp so this late-joiner shows the correct clock and
          // is properly evaluated for attendance.
          if (
            hostUserIdRef.current === userId
            && lessonStartedAtRef.current !== null
          ) {
            channel.send({
              type: 'broadcast',
              event: 'lesson-started',
              payload: { senderUserId: userId, startedAt: lessonStartedAtRef.current },
            });
          }
          // If I'm currently sharing my screen, advertise it to the new peer
          // so its UI immediately switches to presentation mode.
          if (screenStreamRef.current) {
            channel.send({
              type: 'broadcast',
              event: 'peer-state-change',
              payload: { userId, roomId, screenSharing: true },
            });
          }
          syncPeers();
        }
      });

      channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
        for (const p of leftPresences) {
          peerLastSeen.current.delete(p.userId as string);
          removePeer(p.userId as string);
        }
      });

      // ── Broadcast: heartbeat (zombie detection) ────────────────────────────
      channel.on('broadcast', { event: 'heartbeat-ping' }, ({ payload }) => {
        if (payload.userId) peerLastSeen.current.set(payload.userId as string, Date.now());
      });

      // ── Broadcast: WebRTC signaling ────────────────────────────────────────
      channel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
        if (payload.target !== userId) return;
        const pc = createPeerConnection(payload.userId, payload.userName, /* isOfferer */ false);
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          // Flush any ICE candidates that arrived before the offer was processed.
          const bufferedOfferCandidates = pendingCandidates.current.get(payload.userId) ?? [];
          for (const c of bufferedOfferCandidates) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* noop */ }
          }
          pendingCandidates.current.delete(payload.userId);
          const answer = await pc.createAnswer();
          if (answer.sdp) answer.sdp = mungeOpusSdp(answer.sdp);
          await pc.setLocalDescription(answer);
          channel.send({
            type: 'broadcast',
            event: 'answer',
            payload: { target: payload.userId, sdp: answer, userId, userName },
          });
        } catch (err) {
          console.error('[IV] Error handling offer:', err);
        }
        syncPeers();
      });

      channel.on('broadcast', { event: 'answer' }, async ({ payload }) => {
        if (payload.target !== userId) return;
        const peer = peersRef.current.get(payload.userId);
        if (peer) {
          try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            // Flush any ICE candidates that arrived before the answer was processed.
            const bufferedAnswerCandidates = pendingCandidates.current.get(payload.userId) ?? [];
            for (const c of bufferedAnswerCandidates) {
              try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* noop */ }
            }
            pendingCandidates.current.delete(payload.userId);
          } catch (err) {
            console.error('[IV] Error setting remote description:', err);
          }
        }
      });

      channel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
        if (payload.target !== userId) return;
        const peer = peersRef.current.get(payload.userId);
        if (!peer) {
          // Peer not yet created — buffer candidate for flush after offer/answer.
          const buf = pendingCandidates.current.get(payload.userId) ?? [];
          buf.push(payload.candidate);
          pendingCandidates.current.set(payload.userId, buf);
          return;
        }
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (err) {
          // Remote description not yet set — buffer for flush after setRemoteDescription.
          if (err instanceof DOMException && (err.name === 'InvalidStateError' || err.name === 'OperationError')) {
            const buf = pendingCandidates.current.get(payload.userId) ?? [];
            buf.push(payload.candidate);
            pendingCandidates.current.set(payload.userId, buf);
          } else {
            console.error('[IV] Error adding ICE candidate:', err);
          }
        }
      });

      channel.on('broadcast', { event: 'peer-state-change' }, ({ payload }) => {
        const peerConn = peersRef.current.get(payload.userId);
        if (peerConn) {
          if (payload.audioEnabled !== undefined) peerConn.audioEnabled = payload.audioEnabled;
          if (payload.videoEnabled !== undefined) peerConn.videoEnabled = payload.videoEnabled;
          if (payload.screenSharing !== undefined) peerConn.screenSharing = payload.screenSharing;
        }
        setPeers((prev) => {
          let changed = false;
          const next = prev.map((p) => {
            if (p.userId !== payload.userId) return p;
            const newAudio = payload.audioEnabled ?? p.audioEnabled;
            const newVideo = payload.videoEnabled ?? p.videoEnabled;
            const newScreen = payload.screenSharing ?? p.screenSharing;
            if (newAudio === p.audioEnabled && newVideo === p.videoEnabled && newScreen === p.screenSharing) {
              return p;
            }
            changed = true;
            return { ...p, audioEnabled: newAudio, videoEnabled: newVideo, screenSharing: newScreen };
          });
          // Skip the re-render entirely if no field actually changed.
          return changed ? next : prev;
        });
      });

      channel.on('broadcast', { event: 'chat-message' }, ({ payload }) => {
        setChatMessages((prev) => appendChat(prev, payload as ChatMessage));
      });

      // Moderator (coord / class monitor / message owner) deleted a message.
      // Drop it from local state so every participant sees it disappear.
      channel.on('broadcast', { event: 'chat-deleted' }, ({ payload }) => {
        const { messageId } = payload as { messageId?: string };
        if (!messageId) return;
        setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
      });

      channel.on('broadcast', { event: 'mute-remote' }, ({ payload }) => {
        // Only honour mute commands from the verified host.
        if (!hostUserIdRef.current || payload.senderUserId !== hostUserIdRef.current) return;
        if (payload.target !== userId && payload.target !== 'all') return;
        if (localStreamRef.current) {
          localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = false));
          setAudioEnabled(false);
          channel.send({
            type: 'broadcast',
            event: 'peer-state-change',
            payload: { userId, roomId, audioEnabled: false },
          });
        }
      });

      channel.on('broadcast', { event: 'kicked' }, async ({ payload }) => {
        // Only honour kick commands from the verified host.
        if (!hostUserIdRef.current || payload.senderUserId !== hostUserIdRef.current) return;
        if (payload.target !== userId) return;
        // Run user callback BEFORE disconnect so it can still read joinedAt etc.
        try { await onKickedRef.current?.(); } catch { /* non-fatal */ }
        disconnect();
      });

      channel.on('broadcast', { event: 'room-closed' }, async ({ payload }) => {
        // Only honour close commands from the verified host.
        if (!hostUserIdRef.current || payload.senderUserId !== hostUserIdRef.current) return;
        // Await the user callback so it can save reports / attendance using
        // joinedAt before disconnect() resets internal refs.
        try { await onRoomClosedRef.current?.(payload.participants ?? []); } catch { /* non-fatal */ }
        disconnect();
      });

      channel.on('broadcast', { event: 'lesson-started' }, ({ payload }) => {
        // Only honour from the verified host (prevents a student forging start).
        if (!hostUserIdRef.current || payload.senderUserId !== hostUserIdRef.current) return;
        const ts = Number(payload.startedAt);
        if (!Number.isFinite(ts) || ts <= 0) return;
        // First-write-wins so re-broadcasts on late-join don't bump the clock.
        if (lessonStartedAtRef.current !== null) return;
        lessonStartedAtRef.current = ts;
        setLessonStartedAt(ts);
      });

      channel.on('broadcast', { event: 'recording-started' }, ({ payload }) => {
        // Accept from professor (host) OR monitor — both may operate RecordingControls.
        // Filter only self-sent events so the recorder doesn't mark their own
        // session as "remote" (which would block the Stop button).
        if (!payload.senderUserId || payload.senderUserId === userId) return;
        setIsRemoteRecordingActive(true);
      });

      channel.on('broadcast', { event: 'recording-stopped' }, ({ payload }) => {
        if (!payload.senderUserId || payload.senderUserId === userId) return;
        setIsRemoteRecordingActive(false);
      });

      // ── Subscribe and track presence ───────────────────────────────────────
      const recomputeHost = () => {
        const state = channel.presenceState<{ userId: string; userName: string; joinedAt: number }>();
        const all = Object.values(state).flat();
        // If an authoritative host is configured (lesson professor),
        // use it directly — no presence guessing needed.
        if (expectedHostId) {
          hostUserIdRef.current = expectedHostId;
          setIsHost(expectedHostId === userId);
          // Track physical presence: is the expected professor in the channel?
          setHostIsPresent(all.some((p) => p.userId === expectedHostId));
          return;
        }
        if (all.length === 0) {
          hostUserIdRef.current = null;
          setIsHost(false);
          setHostIsPresent(false);
          return;
        }
        // Fallback: host = participant with earliest joinedAt.
        // In this case the host is by definition present (they are in all[]).
        const earliest = all.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b));
        hostUserIdRef.current = earliest.userId;
        setIsHost(earliest.userId === userId);
        setHostIsPresent(true);
      };

      channel.on('presence', { event: 'sync' }, recomputeHost);

      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          setConnected(true);
          reconnectAttempts.current = 0;
          joinedAtRef.current = Date.now();
          await channel.track({ userId, userName, joinedAt: Date.now() });
          // Host will be set by the presence 'sync' handler above.

          // Load chat history so late joiners see prior messages.
          try {
            const history = await listChatMessages(roomId);
            if (history.length > 0) {
              setChatMessages((prev) => {
                // Merge by id to avoid duplicates if reconnecting.
                const seen = new Set(prev.map((m) => m.id));
                const fromDb: ChatMessage[] = history
                  .filter((h) => !seen.has(h.id))
                  .map((h) => ({
                    id: h.id,
                    userId: h.user_id,
                    userName: h.user_name,
                    text: h.text,
                    timestamp: new Date(h.created_at).getTime(),
                  }));
                const merged = [...fromDb, ...prev].sort((a, b) => a.timestamp - b.timestamp);
                return merged;
              });
            }
          } catch { /* non-fatal */ }
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          setConnected(false);
          attemptReconnect();
        }
      });

      startStatsMonitor();

      // Heartbeat sender: broadcast a lightweight ping so peers can track
      // our liveness. Uses channelRef so it keeps working through reconnects.
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = setInterval(() => {
        channelRef.current?.send({
          type: 'broadcast',
          event: 'heartbeat-ping',
          payload: { userId },
        });
      }, HEARTBEAT_INTERVAL_MS);

      // Zombie watchdog: scan peersRef every HEARTBEAT_INTERVAL_MS and evict
      // any peer whose last-seen timestamp is older than ZOMBIE_THRESHOLD_MS.
      // Covers hard crashes and frozen tabs where connectionState may lie.
      if (zombieWatchdog.current) clearInterval(zombieWatchdog.current);
      zombieWatchdog.current = setInterval(() => {
        const now = Date.now();
        peersRef.current.forEach((_, remoteUserId) => {
          const lastSeen = peerLastSeen.current.get(remoteUserId);
          if (lastSeen === undefined) return;
          if (now - lastSeen > ZOMBIE_THRESHOLD_MS) {
            console.warn('[IV] Zombie peer evicted — no heartbeat for',
              Math.round((now - lastSeen) / 1000), 's:', remoteUserId);
            removePeer(remoteUserId);
          }
        });
      }, HEARTBEAT_INTERVAL_MS);
    } catch (err) {
      console.error('[IV] Error connecting to room:', err);
    }
  }, [roomId, userId, userName, expectedHostId, createPeerConnection, syncPeers, removePeer, startStatsMonitor]);

  // ── Reconnection ───────────────────────────────────────────────────────────

  const attemptReconnect = useCallback(() => {
    if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[IV] Max reconnect attempts reached');
      return;
    }
    // Clear any previous timer to prevent multiple parallel subscribe() calls
    // when CHANNEL_ERROR fires in rapid succession.
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts.current);
    reconnectAttempts.current++;
    console.log(`[IV] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`);
    reconnectTimer.current = setTimeout(() => {
      // Sweep zombie peers stuck in terminal states before resubscribing.
      // Without this, peers that died during the Realtime outage stay in the
      // map forever (presence sync won't recreate them because their ids are
      // still present), leading to permanent black tiles.
      const stale: string[] = [];
      peersRef.current.forEach((peer, id) => {
        const state = peer.pc.connectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          stale.push(id);
        }
      });
      for (const id of stale) {
        console.warn(`[IV] attemptReconnect: removing stale peer ${id} in state ${peersRef.current.get(id)?.pc.connectionState}`);
        removePeer(id);
      }
      channelRef.current?.subscribe();
    }, delay);
  }, [removePeer]);

  // Elapsed time is intentionally NOT tracked here — derive it from
  // `lessonStartedAt` in an isolated component so the per-second tick
  // doesn't re-render the entire ClassroomView (and all VideoTiles).

  // ── Controls ───────────────────────────────────────────────────────────────

  const toggleAudio = useCallback(async () => {
    // If we have NO local stream yet (pure listener — e.g. cameraless device
    // whose initial audio fallback failed, or user originally denied mic and
    // is now retrying), try to acquire one BEFORE bailing. Returning early
    // here used to be the root cause of "I click the mic and nothing happens"
    // on devices that joined without a camera.
    if (!localStreamRef.current) {
      try {
        const stream = await getUserMediaWithFallback(true, false);
        const newTrack = stream.getAudioTracks()[0];
        if (!newTrack) throw new Error('audio:NoTrack');
        localStreamRef.current = stream;
        setLocalStream(stream);

        // Promote every peer's recvonly audio m-line to sendrecv via
        // replaceTrack — DO NOT addTrack, which would create a duplicate
        // m=audio line and break the next renegotiation.
        peersRef.current.forEach((peer) => {
          const recvonly = peer.recvonlyAudioTransceiver;
          if (recvonly && recvonly.sender) {
            void recvonly.sender.replaceTrack(newTrack);
            try { recvonly.direction = 'sendrecv'; } catch { /* noop */ }
            void applySenderBitrate(recvonly.sender, MAX_AUDIO_BITRATE);
            peer.recvonlyAudioTransceiver = undefined;
            return;
          }
          // Fallback: no cached transceiver (e.g. we were the answerer for
          // this peer, so the implicit recvonly audio transceiver was created
          // by setRemoteDescription rather than by us). Find it by kind on
          // the receiver side and promote it to sendrecv.
          const implicitAudio = peer.pc.getTransceivers().find(
            (t) => t.receiver?.track?.kind === 'audio' && !t.sender.track && t.currentDirection !== 'stopped',
          );
          if (implicitAudio) {
            void implicitAudio.sender.replaceTrack(newTrack);
            try { implicitAudio.direction = 'sendrecv'; } catch { /* noop */ }
            void applySenderBitrate(implicitAudio.sender, MAX_AUDIO_BITRATE);
            return;
          }
          const existingAudioSender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio');
          if (existingAudioSender) {
            void existingAudioSender.replaceTrack(newTrack);
            void applySenderBitrate(existingAudioSender, MAX_AUDIO_BITRATE);
          } else {
            const newSender = peer.pc.addTrack(newTrack, localStreamRef.current!);
            void applySenderBitrate(newSender, MAX_AUDIO_BITRATE);
          }
        });

        setAudioEnabled(true);
        channelRef.current?.send({ type: 'broadcast', event: 'peer-state-change', payload: { userId, roomId, audioEnabled: true } });
      } catch (e) {
        console.error('[IV] Could not acquire audio for listener-mode peer', e);
        const name = e instanceof DOMException ? e.name : 'Error';
        throw new Error(`audio:${name}`);
      }
      return;
    }

    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    
    if (audioTrack) {
        const enabled = !audioEnabled;
        audioTrack.enabled = enabled;
        setAudioEnabled(enabled);
        channelRef.current?.send({ type: 'broadcast', event: 'peer-state-change', payload: { userId, roomId, audioEnabled: enabled } });
    } else if (!audioEnabled) {
        // Dynamically request audio with progressive fallback (AEC/NS/AGC →
        // minimal → no device pin). Errors are re-thrown so the caller can
        // surface a toast — silent failure used to leave the mic permanently
        // off without any user feedback.
        try {
            const stream = await getUserMediaWithFallback(true, false);
            const newTrack = stream.getAudioTracks()[0];
            localStreamRef.current.addTrack(newTrack);

            // Prefer reusing the cached recvonly audio transceiver (created at
            // join time when this side started without a mic). Using
            // `transceiver.sender.replaceTrack` + flipping direction='sendrecv'
            // upgrades the existing m=audio line in place; calling addTrack
            // would create a second m=audio line and break renegotiation.
            peersRef.current.forEach(peer => {
                const recvonly = peer.recvonlyAudioTransceiver;
                if (recvonly && recvonly.sender) {
                    void recvonly.sender.replaceTrack(newTrack);
                    try { recvonly.direction = 'sendrecv'; } catch { /* noop */ }
                    void applySenderBitrate(recvonly.sender, MAX_AUDIO_BITRATE);
                    peer.recvonlyAudioTransceiver = undefined;
                    return;
                }
                const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
                if (sender) {
                    void sender.replaceTrack(newTrack);
                    void applySenderBitrate(sender, MAX_AUDIO_BITRATE);
                } else {
                    const newSender = peer.pc.addTrack(newTrack, localStreamRef.current!);
                    void applySenderBitrate(newSender, MAX_AUDIO_BITRATE);
                }
            });
            
            setAudioEnabled(true);
            channelRef.current?.send({ type: 'broadcast', event: 'peer-state-change', payload: { userId, roomId, audioEnabled: true } });
        } catch (e) {
            console.error('[IV] Could not get audio', e);
            // Surface a typed error so ClassroomView can show a translated
            // toast distinguishing permission-denied from hardware busy.
            const name = e instanceof DOMException ? e.name : 'Error';
            throw new Error(`audio:${name}`);
        }
    }
  }, [audioEnabled, userId, roomId]);

  const toggleVideo = useCallback(async () => {
    if (!localStreamRef.current) return;

    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    
    if (videoTrack) {
      const enabled = !videoEnabled;
      videoTrack.enabled = enabled;
      setVideoEnabled(enabled);
      // Sprint 4.3 fix: stamp cooldown so the auto-degrade watcher won't
      // immediately redisable a manually re-enabled camera on a poor link.
      if (enabled) lastManualVideoEnableRef.current = Date.now();
      channelRef.current?.send({ type: 'broadcast', event: 'peer-state-change', payload: { userId, roomId, videoEnabled: enabled } });
    } else if (!videoEnabled) {
        // dynamically request video with adaptive constraints (Android-friendly)
        try {
            const stream = await getUserMediaWithFallback(false, true);
            const newTrack = stream.getVideoTracks()[0];
            try { (newTrack as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion'; } catch { /* noop */ }
            localStreamRef.current.addTrack(newTrack);

            const cap = videoBitrateForPeerCount(peersRef.current.size + 1);
            // For each peer, prefer reusing an existing transceiver — either
            // the sendrecv one we created when this side already had video (rare
            // path: video disabled but track still present), or the recvonly
            // one created on join when we were audio-only. Using
            // `transceiver.sender.replaceTrack` + setting direction='sendrecv'
            // upgrades in place; calling `addTrack` instead would create a
            // second m=video line and break renegotiation.
            peersRef.current.forEach(peer => {
                const recvonly = peer.recvonlyVideoTransceiver;
                if (recvonly && recvonly.sender) {
                    void recvonly.sender.replaceTrack(newTrack);
                    try { recvonly.direction = 'sendrecv'; } catch { /* noop */ }
                    void applySenderBitrate(recvonly.sender, cap, 'maintain-framerate');
                    // Once upgraded, drop the cached reference so subsequent
                    // toggles don't try to re-mutate the same transceiver.
                    peer.recvonlyVideoTransceiver = undefined;
                    return;
                }
                const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    void sender.replaceTrack(newTrack);
                    void applySenderBitrate(sender, cap, 'maintain-framerate');
                } else {
                    const newSender = peer.pc.addTrack(newTrack, localStreamRef.current!);
                    void applySenderBitrate(newSender, cap, 'maintain-framerate');
                }
            });

            setVideoEnabled(true);
            lastManualVideoEnableRef.current = Date.now();
            channelRef.current?.send({ type: 'broadcast', event: 'peer-state-change', payload: { userId, roomId, videoEnabled: true } });
        } catch (e) {
            console.error('[IV] Could not get video', e);
        }
    }
  }, [videoEnabled, userId, roomId]);

  const toggleScreenShare = useCallback(async () => {
    if (screenSharing) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setLocalScreenStream(null);
      setScreenSharing(false);
      channelRef.current?.send({
        type: 'broadcast',
        event: 'peer-state-change',
        payload: { userId, roomId, screenSharing: false },
      });
      if (localStreamRef.current) {
        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoTrack) {
          try { (videoTrack as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion'; } catch { /* noop */ }
          const cap = videoBitrateForPeerCount(peersRef.current.size + 1);
          peersRef.current.forEach((peer) => {
            const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
            sender?.replaceTrack(videoTrack);
            if (sender) void applySenderBitrate(sender, cap, 'maintain-framerate');
          });
        }
      }
    } else {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screen;
        setLocalScreenStream(screen);
        setScreenSharing(true);
        channelRef.current?.send({
          type: 'broadcast',
          event: 'peer-state-change',
          payload: { userId, roomId, screenSharing: true },
        });
        const screenTrack = screen.getVideoTracks()[0];
        // 'detail' hint tells the encoder to favour resolution/text legibility
        // over motion smoothness — perfect for slides / IDE / docs.
        try { (screenTrack as MediaStreamTrack & { contentHint?: string }).contentHint = 'detail'; } catch { /* noop */ }
        peersRef.current.forEach((peer) => {
          const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
          sender?.replaceTrack(screenTrack);
          if (sender) void applySenderBitrate(sender, MAX_SCREEN_BITRATE, 'maintain-resolution');
        });
        screenTrack.onended = () => {
          setScreenSharing(false);
          setLocalScreenStream(null);
          screenStreamRef.current = null;
          channelRef.current?.send({
            type: 'broadcast',
            event: 'peer-state-change',
            payload: { userId, roomId, screenSharing: false },
          });
          if (localStreamRef.current) {
            const camTrack = localStreamRef.current.getVideoTracks()[0];
            if (camTrack) {
              try { (camTrack as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion'; } catch { /* noop */ }
              const cap = videoBitrateForPeerCount(peersRef.current.size + 1);
              peersRef.current.forEach((peer) => {
                const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
                sender?.replaceTrack(camTrack);
                if (sender) void applySenderBitrate(sender, cap, 'maintain-framerate');
              });
            }
          }
        };
      } catch (err) {
        console.error('Screen share error:', err);
      }
    }
  }, [screenSharing, userId, roomId]);

  // Broadcast recording state to all room participants. Host-only; called by
  // ClassroomView when RecordingControls reports a status change to/from
  // 'recording'. Non-hosts receive the event and show a consent banner.
  const broadcastRecordingEvent = useCallback((active: boolean) => {
    if (!channelRef.current) return;
    try {
      channelRef.current.send({
        type: 'broadcast',
        event: active ? 'recording-started' : 'recording-stopped',
        payload: { senderUserId: userId },
      });
    } catch { /* non-fatal */ }
  }, [userId]);

  // Start the lesson — host only. Sets the authoritative "aula começou"
  // timestamp, broadcasts to all participants, and notifies the parent so
  // it can persist (e.g. update scheduled_lessons.started_at). Idempotent:
  // a second click is a no-op.
  const startLesson = useCallback(() => {
    if (!isHost) return;
    if (lessonStartedAtRef.current !== null) return;
    const ts = Date.now();
    lessonStartedAtRef.current = ts;
    setLessonStartedAt(ts);
    try {
      channelRef.current?.send({
        type: 'broadcast',
        event: 'lesson-started',
        payload: { senderUserId: userId, startedAt: ts },
      });
    } catch { /* non-fatal */ }
    try { onLessonStartedRef.current?.(ts); } catch { /* non-fatal */ }
  }, [isHost, userId]);

  // Close room — host only. Sender does NOT receive its own broadcast
  // (broadcast.self === false), so we must also trigger the local flow here
  // otherwise the host stays connected forever.
  const closeRoom = useCallback(async () => {
    if (!isHost) return;
    const participants = Array.from(peersRef.current.values()).map((p) => ({
      userId: p.userId,
      userName: p.userName,
      joinedAt: 0,
    }));
    const payload = { senderUserId: userId, closedBy: userId, participants };
    try {
      channelRef.current?.send({ type: 'broadcast', event: 'room-closed', payload });
    } catch { /* non-fatal */ }
    // Run the same callback remote peers run, so host saves the report and
    // navigates away just like any other participant.
    try { await onRoomClosedRef.current?.(participants); } catch { /* non-fatal */ }
    disconnect();
    // disconnect is declared later in this hook; closure captures the latest
    // reference at call time. Intentionally omitted from deps to avoid TDZ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, userId]);

  // Chat
  const sendChatMessage = useCallback((text: string) => {
    if (!text.trim() || !channelRef.current) return;
    const trimmed = text.trim().slice(0, 2000);
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      userId,
      userName,
      text: trimmed,
      timestamp: Date.now(),
    };
    channelRef.current.send({ type: 'broadcast', event: 'chat-message', payload: { roomId, ...msg } });
    setChatMessages((prev) => appendChat(prev, msg));
    // Fire-and-forget persistence so late joiners can fetch history.
    void insertChatMessage({
      scheduled_lesson_id: scheduledLessonId ?? null,
      room_id: roomId,
      user_id: userId,
      user_name: userName,
      text: trimmed,
    });
  }, [roomId, userId, userName, scheduledLessonId]);

  // Moderation: delete a message (own message, coord, or class monitor).
  // Mutates the durable store via RLS-checked DELETE, then broadcasts so
  // peers strip the bubble from their UI without waiting for a re-fetch.
  const deleteChatMessage = useCallback(async (messageId: string) => {
    if (!messageId) return;
    await deleteChatMessageRow(messageId);
    channelRef.current?.send({
      type: 'broadcast',
      event: 'chat-deleted',
      payload: { roomId, messageId },
    });
    setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, [roomId]);

  // Host controls
  const muteParticipant = useCallback((targetUserId: string) => {
    if (!isHost) return;
    channelRef.current?.send({
      type: 'broadcast',
      event: 'mute-remote',
      payload: { senderUserId: userId, target: targetUserId },
    });
  }, [isHost, userId]);

  const kickParticipant = useCallback((targetUserId: string) => {
    if (!isHost) return;
    channelRef.current?.send({
      type: 'broadcast',
      event: 'kicked',
      payload: { senderUserId: userId, target: targetUserId },
    });
  }, [isHost, userId]);

  const muteAll = useCallback(() => {
    if (!isHost) return;
    channelRef.current?.send({
      type: 'broadcast',
      event: 'mute-remote',
      payload: { senderUserId: userId, target: 'all' },
    });
  }, [isHost, userId]);

  // ── Switch device mid-call ─────────────────────────────────────────────────

  const switchDevice = useCallback(async (kind: 'audio' | 'video', deviceId: string) => {
    if (!localStreamRef.current) return;
    try {
      const constraints: MediaStreamConstraints = kind === 'audio'
        ? { audio: { deviceId: { exact: deviceId }, ...getDefaultAudioConstraints() } }
        : { video: { deviceId: { exact: deviceId }, ...getDefaultVideoConstraints() } };
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = newStream.getTracks()[0];
      if (!newTrack) return;

      // Replace in local stream
      const oldTrack = kind === 'audio'
        ? localStreamRef.current.getAudioTracks()[0]
        : localStreamRef.current.getVideoTracks()[0];
      if (oldTrack) {
        localStreamRef.current.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStreamRef.current.addTrack(newTrack);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));

      // Replace in all peer connections
      peersRef.current.forEach((peer) => {
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === newTrack.kind);
        sender?.replaceTrack(newTrack);
      });
    } catch (err) {
      console.error(`Error switching ${kind} device:`, err);
    }
  }, []);

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    // Cancel timers synchronously \u2014 they would otherwise fire against
    // half-torn-down state and throw.
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (statsInterval.current) clearInterval(statsInterval.current);
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    if (zombieWatchdog.current)    clearInterval(zombieWatchdog.current);
    disconnectTimers.current.forEach((t) => clearTimeout(t));
    disconnectTimers.current.clear();
    pendingCandidates.current.clear();
    peerLastSeen.current.clear();

    // Snapshot resources to release; null the refs immediately so any
    // re-entry sees an already-disconnected room.
    const localStream = localStreamRef.current;
    const screenStream = screenStreamRef.current;
    const peers = Array.from(peersRef.current.values());
    const channel = channelRef.current;
    localStreamRef.current = null;
    screenStreamRef.current = null;
    peersRef.current.clear();
    channelRef.current = null;

    // UI-visible state flips first so React can paint the empty room.
    setLocalStream(null);
    setPeers([]);
    setConnected(false);
    setIsHost(false);
    setHostIsPresent(false);
    setIsRemoteRecordingActive(false);
    setScreenSharing(false);
    setChatMessages([]);
    joinedAtRef.current = 0;
    lessonStartedAtRef.current = null;
    setLessonStartedAt(null);

    // BUG FIX: Stop media tracks SYNCHRONOUSLY so the OS releases the
    // camera/microphone immediately (Chrome notification disappears at once).
    // Previously this was deferred via queueMicrotask, which on mobile could
    // leave the device LED/notification active for several seconds after the
    // user navigated away. Track.stop() is cheap (µs, not ms) so doing it
    // synchronously does not block the main thread meaningfully.
    try {
      localStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      screenStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
    } catch { /* defensive */ }

    // The expensive part — closing N RTCPeerConnections and removing the
    // realtime channel — stays deferred so disconnect() returns instantly.
    queueMicrotask(() => {
      try {
        peers.forEach((peer) => { try { peer.pc.close(); } catch { /* noop */ } });
        if (channel) {
          void supabase.removeChannel(channel);
        }
      } catch { /* defensive: never throw from teardown */ }
    });
  }, []);

  useEffect(() => {
    return () => { disconnect(); };
  }, [disconnect]);

  // Safety net: if the user closes the tab / refreshes / navigates away via
  // hard reload, beforeunload fires before the React unmount lifecycle has a
  // chance to run. Without this, the camera/mic indicator can persist on
  // mobile browsers until the OS GCs the page. Stops tracks only — we
  // intentionally don't run full disconnect() here because it would race with
  // the page navigation.
  useEffect(() => {
    const handler = () => {
      try {
        localStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
        screenStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      } catch { /* defensive */ }
    };
    window.addEventListener('beforeunload', handler);
    window.addEventListener('pagehide', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('pagehide', handler);
    };
  }, []);

  // Sprint 4.2: explicit setter for the \u201cModo economia\u201d toggle. Disabling
  // turns the camera off (without releasing the device, so re-enabling is
  // instant) and clears the auto-degraded flag so the UI banner goes away.
  // Re-enabling does NOT auto-turn-the-camera-back-on \u2014 the user must
  // press the camera button again, which is the safer UX (we don\u2019t want
  // a stale poor-network read to ping-pong the video).
  const setEconomyModeManual = useCallback((enabled: boolean) => {
    setEconomyMode(enabled);
    if (enabled) {
      const vt = localStreamRef.current?.getVideoTracks()[0];
      if (vt && vt.enabled) {
        vt.enabled = false;
        setVideoEnabled(false);
        channelRef.current?.send({
          type: 'broadcast', event: 'peer-state-change',
          payload: { userId, roomId, videoEnabled: false },
        });
      }
    } else {
      setAutoDegraded(false);
      consecutivePoorRef.current = 0;
    }
  }, [userId, roomId]);

  // Sprint 4.4: paginated chat scroll-back. Returns how many messages were
  // prepended; UI uses that to decide whether to show \u201cno older messages\u201d.
  const loadOlderMessages = useCallback(async (limit = 100): Promise<number> => {
    const oldest = chatMessages[0];
    if (!oldest) return 0;
    const beforeIso = new Date(oldest.timestamp).toISOString();
    try {
      const older = await listChatMessagesBefore(roomId, beforeIso, limit);
      if (older.length === 0) return 0;
      const mapped: ChatMessage[] = older.map((h) => ({
        id: h.id,
        userId: h.user_id,
        userName: h.user_name,
        text: h.text,
        timestamp: new Date(h.created_at).getTime(),
      }));
      setChatMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = mapped.filter((m) => !seen.has(m.id));
        return [...fresh, ...prev];
      });
      return older.length;
    } catch {
      return 0;
    }
  }, [roomId, chatMessages]);

  return {
    localStream,
    peers,
    isHost,
    /** True when the authoritative professor is physically in the Realtime channel. */
    hostIsPresent,
    /** True when the host started recording — shown as a consent banner to non-hosts. */
    isRemoteRecordingActive,
    connected,
    audioEnabled,
    videoEnabled,
    screenSharing,
    localScreenStream,
    connectionQuality,
    /** Sprint 4.2/4.3: true while audio-only is in effect. */
    economyMode,
    /** True when economy mode was engaged automatically by 4.3 watcher. */
    autoDegraded,
    chatMessages,
    /** ms epoch when the host clicked "Iniciar aula"; null while waiting. */
    lessonStartedAt,
    expectedHostId,
    turnAvailable,
    /** Timestamp (ms epoch) when the local user successfully joined the room. 0 before join. */
    joinedAt: joinedAtRef.current,
    /** Stable getter for joinedAt to avoid stale-closure issues in async callbacks. */
    getJoinedAt: () => joinedAtRef.current,
    connect,
    disconnect,
    closeRoom,
    startLesson,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
    sendChatMessage,
    /** Phase 1 monitor: hard-delete a chat message (owner / coord / monitor). */
    deleteChatMessage,
    /** Sprint 4.4: prepend up to `limit` older messages from the durable\n     *  store. Returns count actually fetched. */
    loadOlderMessages,
    /** Sprint 4.2: user-driven economy mode toggle. */
    setEconomyMode: setEconomyModeManual,
    muteParticipant,
    kickParticipant,
    muteAll,
    switchDevice,
    broadcastRecordingEvent,
  };
}
