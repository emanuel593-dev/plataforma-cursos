// Pure helpers used by useWebRTC.
//
// Extracted so unit tests can exercise the auto-degrade decision and the
// chat RAM cap in isolation, without spinning up the WebRTC hook.

// In-memory chat retains everything received during the session up to a
// soft RAM ceiling. The underlying lesson_chat_messages table is the
// durable store; older messages remain accessible via
// listChatMessagesBefore() / loadOlderMessages(). The cap protects long
// (4h+) sessions from unbounded array growth without hurting normal
// scroll-back — 2000 msgs ≈ 300 KB.
export const CHAT_RAM_SOFT_CAP = 2000;

export function appendChat<T>(prev: T[], msg: T): T[] {
  const next = [...prev, msg];
  return next.length > CHAT_RAM_SOFT_CAP
    ? next.slice(next.length - CHAT_RAM_SOFT_CAP)
    : next;
}

// ── Auto-degrade decision (Sprint 4.3) ───────────────────────────────────────
// We drop the local video track after N consecutive 'poor' samples to spare
// the user's uplink. To avoid flicker when the user re-enables the camera
// on a stubbornly bad link, we honour a cooldown after any manual enable.

export const AUTO_DEGRADE_THRESHOLD = 2;
export const AUTO_DEGRADE_COOLDOWN_MS = 30_000;
// Protects against false economy-mode triggers right after joining: ICE/TURN
// negotiation naturally produces high RTT for the first few seconds, which
// would otherwise fire 2 consecutive 'poor' samples and auto-degrade before
// the user's uplink quality is even established.
export const AUTO_DEGRADE_JOIN_GRACE_MS = 30_000;

export interface AutoDegradeContext {
  consecutivePoor: number;
  videoEnabled: boolean;
  lastManualVideoEnableMs: number;
  joinedAtMs: number;
  nowMs: number;
}

export function shouldAutoDegrade(ctx: AutoDegradeContext): boolean {
  if (!ctx.videoEnabled) return false;
  if (ctx.consecutivePoor < AUTO_DEGRADE_THRESHOLD) return false;
  if (ctx.nowMs - ctx.joinedAtMs <= AUTO_DEGRADE_JOIN_GRACE_MS) return false;
  if (ctx.nowMs - ctx.lastManualVideoEnableMs <= AUTO_DEGRADE_COOLDOWN_MS) return false;
  return true;
}

// ── Uplink saturation detection (Auditoria §6 Falha Crítica) ──────────────────
// Detecta quando o próprio emissor (professor/aluno) está com o uplink saturado
// por banda insuficiente — cego para a auto-degradação original (downlink-only).
//
// Usa `outbound-rtp.qualityLimitationDurations.bandwidth` (acumulador em
// segundos). A diferença entre dois ciclos de 5s indica o tempo que o encoder
// passou throttled por falta de upload. Se > UPLINK_BANDWIDTH_RATIO_THRESHOLD
// do intervalo por 2 ciclos seguidos, degrada câmera local (mesmo mecanismo).
//
// Safari / Firefox não expõem `qualityLimitationDurations` → undefined → 0,
// nunca dispara falso positivo nesses browsers.

// Fração do intervalo de stats (5s) em que o encoder pode ficar limitado por
// banda antes de contar como amostra ruim. 0.4 = mais de 2s dos 5s.
export const UPLINK_BANDWIDTH_RATIO_THRESHOLD = 0.4;
// Número de amostras consecutivas de uplink ruim antes de degradar.
export const UPLINK_DEGRADE_THRESHOLD = 2;
// Duração nominal de cada ciclo do stats monitor em segundos.
export const STATS_INTERVAL_S = 5;

export interface UplinkDegradeContext {
  /** Segundos acumulados em qualityLimitationReason='bandwidth' neste ciclo. */
  bandwidthLimitedDeltaS: number;
  videoEnabled: boolean;
  consecutiveUplinkPoor: number;
  lastManualVideoEnableMs: number;
  joinedAtMs: number;
  nowMs: number;
}

export function shouldDegradeUplink(ctx: UplinkDegradeContext): boolean {
  if (!ctx.videoEnabled) return false;
  // Mesmas proteções de join grace e cooldown manual.
  if (ctx.nowMs - ctx.joinedAtMs <= AUTO_DEGRADE_JOIN_GRACE_MS) return false;
  if (ctx.nowMs - ctx.lastManualVideoEnableMs <= AUTO_DEGRADE_COOLDOWN_MS) return false;
  // Limiar de saturação: quanto do intervalo esteve throttled por banda.
  const ratio = ctx.bandwidthLimitedDeltaS / STATS_INTERVAL_S;
  if (ratio < UPLINK_BANDWIDTH_RATIO_THRESHOLD) return false;
  if (ctx.consecutiveUplinkPoor < UPLINK_DEGRADE_THRESHOLD) return false;
  return true;
}
