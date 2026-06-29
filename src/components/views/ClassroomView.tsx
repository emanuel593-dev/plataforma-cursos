import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Video, VideoOff, Mic, MicOff, Monitor, PhoneOff,
  Users, Crown, VolumeX, LogOut, Loader2,
  MessageCircle, Send, Wifi, WifiOff, Clock, X, Settings, Square, Play,
  Leaf, Trash2, ClipboardCheck, BarChart3, AlertTriangle,
} from 'lucide-react';
import { useWebRTC, type Peer, type ConnectionQuality, type ChatMessage, type RoomClosedParticipant } from '../../hooks/useWebRTC';
import { useSpeakingDetection } from '../../hooks/useSpeakingDetection';
import { useWakeLock } from '../../hooks/useWakeLock';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { saveReport } from '../../services/reports.service';
import { endLesson, getScheduledLesson, markLessonStarted, notifyLessonStarted } from '../../services/schedule.service';
import { getLesson } from '../../services/modules.service';
import { listProfessorsOfClass, listEnrollmentsByClass, getClass } from '../../services/classes.service';
import { listMonitorsOfClass } from '../../services/monitors.service';
import { listProfilesByRole } from '../../services/profiles.service';
import { upsertAttendance, getAttendance, flushAttendanceProgress } from '../../services/attendance.service';
import { recordAttendanceJoinCore } from '../../lib/attendanceJoin';
import { shouldSkipFlush, markFlushed, clearFlushMarker } from '../../lib/attendanceFlushLock';
import { supabase } from '../../lib/supabase';
import ConfirmModal from '../ui/ConfirmModal';
import RecordingControls from '../ui/RecordingControls';
import type { RecordingStatus } from '../../hooks/useRecording';
import EvaluateLessonModal from './EvaluateLessonModal';
import PollsDrawer from './PollsDrawer';
import PollResponseModal from './PollResponseModal';
import { AttendanceProgressBadge } from './AttendanceProgressBadge';
import { subscribeToPolls, listPollsByLesson } from '../../services/lessonPolls.service';
import type { LessonPoll } from '../../types';
import type { Profile } from '../../types';
import { effectiveLessonModality } from '../../types';

// ── Presence-check config ────────────────────────────────────────────────────

/** Minimum percentage of class duration to count as present */
const MIN_DURATION_RATIO = 0.75;
/** How long (ms) the student has to respond to a presence check */
const CHECK_RESPONSE_TIMEOUT_MS = 30_000;
/** Maximum number of checks per class session */
const MAX_CHECKS = 3;
/** Min/max delay (ms) between checks — randomised within range */
const CHECK_INTERVAL_MIN_MS = 8 * 60_000;   // 8 min
const CHECK_INTERVAL_MAX_MS = 15 * 60_000;  // 15 min

export default function ClassroomView() {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const scheduledLessonId = searchParams.get('aula') ?? undefined;
  const navigate = useNavigate();
  const onLeave = useCallback(() => navigate('/'), [navigate]);
  const { profile } = useAuth();
  const { showToast } = useToast();
  const [joined, setJoined] = useState(false);

  // ── Recording-aware room close ─────────────────────────────────────────────
  // stopRef is populated by RecordingControls so we can call stopRecording()
  // before navigating away, preventing stuck "Gravando…" rows in the DB.
  const recordingStopRef = useRef<(() => void) | null>(null);
  const [liveRecStatus, setLiveRecStatus] = useState<RecordingStatus>('idle');
  const liveRecStatusRef = useRef<RecordingStatus>('idle');
  const [pendingRoomClose, setPendingRoomClose] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  // Roster of students enrolled in the class hosting this lesson — used by
  // the participants drawer to show who is matriculated vs who is connected.
  const [classId, setClassId] = useState<string | null>(null);
  const [enrolledStudents, setEnrolledStudents] = useState<Profile[]>([]);
  // Set of user_ids that are class monitors of the current room. Loaded once
  // when classId resolves so VideoTile can render the "Monitor" chip next to
  // their name without an extra round trip per peer.
  const [monitorIds, setMonitorIds] = useState<Set<string>>(new Set());
  // Phase 3 — confidential post-lesson evaluation form (monitors only).
  const [evalModalOpen, setEvalModalOpen] = useState(false);
  // Lesson DB status — set once getScheduledLesson resolves. Used in the
  // pre-join gate so students can enter as soon as the room is `in_progress`,
  // even before the professor has pressed "Iniciar Aula" inside the classroom.
  const [lessonStatus, setLessonStatus] = useState<string | null>(null);
  // Phase 4 — live in-class polls. The drawer is staff-only; students get
  // an auto-mounted modal whenever any poll for this lesson is `open`.
  const [pollsDrawerOpen, setPollsDrawerOpen] = useState(false);
  const [polls, setPolls] = useState<LessonPoll[]>([]);
  // Tracks polls the student dismissed locally so closing the modal once
  // doesn't immediately re-open it on the next realtime tick. Cleared
  // implicitly when the poll transitions away from `open`.
  const [dismissedPollIds, setDismissedPollIds] = useState<Set<string>>(new Set());
  // Reset unread counter when chat is opened.
  useEffect(() => { if (chatOpen) setUnreadChat(0); }, [chatOpen]);

  // Close chat with ESC (desktop)
  useEffect(() => {
    if (!chatOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChatOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatOpen]);
  // Close participants drawer with ESC (desktop)
  useEffect(() => {
    if (!participantsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setParticipantsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [participantsOpen]);
  // Load enrolled students once we know the class.
  useEffect(() => {
    if (!classId) return;
    let cancelled = false;
    (async () => {
      try {
        const [enrolls, allStudents] = await Promise.all([
          listEnrollmentsByClass(classId),
          listProfilesByRole('aluno'),
        ]);
        if (cancelled) return;
        const activeIds = new Set(
          enrolls.filter((e) => e.status === 'active').map((e) => e.student_id),
        );
        const roster = allStudents
          .filter((s) => activeIds.has(s.id))
          .sort((a, b) => a.full_name.localeCompare(b.full_name, 'pt-BR'));
        setEnrolledStudents(roster);
      } catch {
        /* drawer falls back to peers-only view */
      }
    })();
    return () => { cancelled = true; };
  }, [classId]);

  // Load class monitors so the room UI can flag them with a "Monitor" badge.
  useEffect(() => {
    if (!classId) {
      setMonitorIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ids = await listMonitorsOfClass(classId);
        if (!cancelled) setMonitorIds(new Set(ids));
      } catch {
        /* badge silently absent if RLS denies the read */
      }
    })();
    return () => { cancelled = true; };
  }, [classId]);
  // Phase 4 — load polls for this lesson and subscribe to live changes so
  // staff sees status transitions without refresh and students get auto
  // -prompted whenever a poll opens. Skipped when there's no scheduled
  // lesson (ad-hoc rooms have no persisted polls).
  useEffect(() => {
    if (!scheduledLessonId) {
      setPolls([]);
      return;
    }
    let cancelled = false;
    listPollsByLesson(scheduledLessonId).then((rows) => {
      if (!cancelled) setPolls(rows);
    }).catch(() => { /* RLS may filter; harmless */ });
    const unsub = subscribeToPolls(scheduledLessonId, (event, row, oldRow) => {
      setPolls((prev) => {
        if (event === 'DELETE') return prev.filter((p) => p.id !== oldRow?.id);
        if (!row) return prev;
        const idx = prev.findIndex((p) => p.id === row.id);
        if (idx === -1) return [row, ...prev];
        const next = prev.slice();
        next[idx] = row;
        return next;
      });
      // When a poll exits the `open` state, allow it to re-prompt next time
      // (covers the rare case of staff reopening — also keeps the dismiss
      // set from growing unbounded).
      if (row && row.status !== 'open') {
        setDismissedPollIds((cur) => {
          if (!cur.has(row.id)) return cur;
          const next = new Set(cur);
          next.delete(row.id);
          return next;
        });
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [scheduledLessonId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const checksRef = useRef<{ verified: number; total: number }>({ verified: 0, total: 0 });
  // Cumulative counters across reconnects within the same lesson, seeded from
  // the existing attendance row on join. Without this, dropping & rejoining
  // wipes the previous duration/checks and the student ends with only the
  // last session counted (e.g. 42% instead of 90%).
  const priorDurationRef = useRef<number>(0);
  const priorVerifiedRef = useRef<number>(0);
  const priorTotalRef = useRef<number>(0);
  // Track what was already flushed in the CURRENT session segment so each
  // flush sends only the incremental delta to attendance_increment_duration.
  // Reset to 0 on every (re)connect; on a clean drop we flush whatever is
  // outstanding before resetting.
  const lastFlushedSessionSecondsRef = useRef<number>(0);
  const lastFlushedVerifiedRef = useRef<number>(0);
  const lastFlushedTotalRef = useRef<number>(0);
  // FIX BUG #2: timestamp absoluto da PRIMEIRA entrada na sala nesta sessão de
  // navegação. Diferente de getJoinedAt() (que é zerado e re-setado a cada
  // reconexão WebRTC), este ref só é atribuído uma vez no handleJoin() e
  // permanece estável durante toda a sessão — inclusive durante reconexões.
  // Usado como baseline do cálculo de duração total no flush final.
  const originalJoinedAtRef = useRef<number>(0);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Absolute timestamp at which the next presence check should fire. Used
  // by the watcher interval below to recover from background tab throttling
  // (mobile browsers heavily throttle / pause `setTimeout` when the app is
  // not foregrounded; relying on setTimeout alone causes whole intervals
  // to be silently skipped — students reported "40 min sem nenhuma
  // verificação" after backgrounding the PWA).
  const nextCheckAtRef = useRef<number | null>(null);
  const checkWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const classDurationRef = useRef<number>(60); // minutes, updated from scheduled lesson
  const classTitleRef = useRef<string>(''); // lesson title
  const lessonStatusRef = useRef<string>('scheduled');
  // Authoritative host = professor_id of the lesson's class. Survives reconnect.
  const [expectedHostId, setExpectedHostId] = useState<string | undefined>(undefined);
  // If the host already clicked "Iniciar aula" earlier (e.g. before a reload),
  // restore the clock from scheduled_lessons.started_at.
  const [initialLessonStartedAt, setInitialLessonStartedAt] = useState<number | null>(null);
  // Mirror of `lessonStartedAt` from the hook so callbacks defined BEFORE the
  // hook destructuring (recordAttendanceLeave, etc.) can read the latest
  // value without re-creating themselves.
  const lessonStartedClientRef = useRef<number | null>(null);

  // Presence-check UI state
  const [presenceCheckVisible, setPresenceCheckVisible] = useState(false);
  const [checkCountdown, setCheckCountdown] = useState(0);

  // Confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
  const [confirmVariant, setConfirmVariant] = useState<'danger' | 'warning'>('warning');
  const [confirmLabel, setConfirmLabel] = useState('Confirmar');

  // ── Modality guard ────────────────────────────────────────────────
  // Presencial lessons have no virtual room. Block render and direct the
  // user back. We resolve modality from scheduled_lessons.modality (override)
  // falling back to classes.modality once both rows are loaded.
  type ModalityState = 'loading' | 'allowed' | 'presencial';
  const [modalityState, setModalityState] = useState<ModalityState>(
    scheduledLessonId ? 'loading' : 'allowed',
  );
  const [presencialClassId, setPresencialClassId] = useState<string | null>(null);

  // ── Load scheduled lesson duration ─────────────────────────────────────────

  useEffect(() => {
    if (!scheduledLessonId) return;
    getScheduledLesson(scheduledLessonId).then(async (sl) => {
      if (sl) {
        classDurationRef.current = sl.duration_minutes;
        if (sl.class_id) setClassId(sl.class_id);
        // Resolve effective modality (lesson override OR class default).
        // We must fetch the class row when the lesson has no override so the
        // guard works for presencial classes scheduled before the override
        // existed. Any failure is treated as "allowed" — we never block
        // legitimate online rooms because of a transient DB hiccup.
        try {
          let cls = null as Awaited<ReturnType<typeof getClass>>;
          if (sl.class_id) cls = await getClass(sl.class_id);
          const eff = effectiveLessonModality(sl, cls);
          if (eff === 'presencial') {
            setPresencialClassId(sl.class_id ?? null);
            setModalityState('presencial');
            return;
          }
          setModalityState('allowed');
        } catch {
          setModalityState('allowed');
        }
        // Authoritative host: prefer the per-lesson assignment; fall back to
        // any of the class professors (first in the junction).
        if (sl.professor_id) {
          setExpectedHostId(sl.professor_id);
        } else if (sl.class_id) {
          try {
            const profs = await listProfessorsOfClass(sl.class_id);
            if (profs[0]) setExpectedHostId(profs[0]);
          } catch { /* fallback to presence-based host */ }
        }
        // Fetch title from the related lesson template
        if (sl.lesson_id) {
          const lesson = await getLesson(sl.lesson_id);
          classTitleRef.current = lesson?.title || 'Aula sem título';
        }
        lessonStatusRef.current = sl.status;
        setLessonStatus(sl.status);
        if (sl.started_at) {
          const ts = Date.parse(sl.started_at);
          if (Number.isFinite(ts) && ts > 0) setInitialLessonStartedAt(ts);
        }
        if (sl.status === 'completed') {
          showToast('Esta aula já foi encerrada e não pode mais ser acessada.', 'warning');
          onLeave();
        }
      }
    }).catch(() => {});
  }, [scheduledLessonId, onLeave, showToast]);

  // ── Realtime: react to lesson titular changes (swap accepted, coord
  //    forced substitution, manual edit). Without this, a student-pattern UI
  //    block (Aguardando o professor iniciar) would persist indefinitely for
  //    the new titular even after the swap completed in the DB.
  useEffect(() => {
    if (!scheduledLessonId) return;
    const channel = supabase
      .channel(`scheduled-lesson:${scheduledLessonId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'scheduled_lessons',
          filter: `id=eq.${scheduledLessonId}`,
        },
        (payload) => {
          const next = payload.new as { professor_id?: string | null; status?: string; started_at?: string | null };
          if (next.professor_id !== undefined) {
            setExpectedHostId(next.professor_id ?? undefined);
          }
          if (next.started_at) {
            const ts = Date.parse(next.started_at);
            if (Number.isFinite(ts) && ts > 0) setInitialLessonStartedAt(ts);
          }
          if (next.status === 'completed') {
            showToast('A aula foi encerrada pelo professor.', 'info');
            onLeave();
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [scheduledLessonId, onLeave, showToast]);

  // ── Presence-check scheduler ───────────────────────────────────────────────

  // Triggers the actual modal + countdown. Called either by the watcher
  // interval (when `Date.now()` crosses `nextCheckAtRef`) or directly by
  // visibilitychange catch-up. Idempotent: ignored if a check is already
  // visible or the cap is reached.
  const firePresenceCheck = useCallback(() => {
    if (presenceCheckVisible) return;
    // FIX BUG #1 (hardening): considera o total acumulado no banco (priorTotalRef)
    // somado ao local. Sem isso, reconexoes que zerem o checksRef local
    // permitem novos checks mesmo que o banco ja tenha atingido MAX_CHECKS.
    if ((checksRef.current.total + priorTotalRef.current) >= MAX_CHECKS) return;
    nextCheckAtRef.current = null;
    checksRef.current.total += 1;
    setPresenceCheckVisible(true);
    setCheckCountdown(Math.ceil(CHECK_RESPONSE_TIMEOUT_MS / 1000));

    // Best-effort OS-level notification when the app is in background. The
    // in-app modal alone is invisible to a user with the tab minimized, so
    // we ping the service worker to surface a system notification with
    // vibration. Not awaited; failures (no permission, no SW) are silent.
    if (
      typeof document !== 'undefined'
      && document.visibilityState === 'hidden'
      && typeof Notification !== 'undefined'
      && Notification.permission === 'granted'
    ) {
      void (async () => {
        try {
          const reg = 'serviceWorker' in navigator
            ? await navigator.serviceWorker.getRegistration()
            : null;
          const opts: NotificationOptions = {
            body: 'Confirme que você ainda está assistindo a aula. Você tem 30 segundos.',
            tag: 'presence-check',
            icon: '/logo-192.png',
            badge: '/logo-192.png',
            renotify: true,
            requireInteraction: true,
            silent: false,
            vibrate: [200, 100, 200, 100, 400],
          } as NotificationOptions;
          if (reg && reg.active) {
            await reg.showNotification('Verificação de presença', opts);
          } else {
            new Notification('Verificação de presença', opts);
          }
        } catch { /* no-op */ }
      })();
    }

    // Countdown UI
    const countdownId = setInterval(() => {
      setCheckCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownId);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Auto-fail after timeout
    if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);
    checkTimeoutRef.current = setTimeout(() => {
      clearInterval(countdownId);
      setPresenceCheckVisible(false);
      setCheckCountdown(0);
      // Failed check — schedule next
      scheduleNextCheck();
    }, CHECK_RESPONSE_TIMEOUT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceCheckVisible]);

  const scheduleNextCheck = useCallback(() => {
    if (checkTimerRef.current) { clearTimeout(checkTimerRef.current); checkTimerRef.current = null; }
    // FIX BUG #1 (hardening): total acumulado = local + banco (priorTotalRef).
    // Previne agendamento de novo check quando o banco ja tem MAX_CHECKS
    // registrados de sessoes anteriores (ex: reconexao apos longa queda).
    if ((checksRef.current.total + priorTotalRef.current) >= MAX_CHECKS) {
      nextCheckAtRef.current = null;
      return;
    }
    const delay = CHECK_INTERVAL_MIN_MS + Math.random() * (CHECK_INTERVAL_MAX_MS - CHECK_INTERVAL_MIN_MS);
    nextCheckAtRef.current = Date.now() + delay;
    // Primary trigger — fast path when the tab is foregrounded.
    checkTimerRef.current = setTimeout(() => {
      checkTimerRef.current = null;
      firePresenceCheck();
    }, delay);
  }, [firePresenceCheck]);

  // Watcher interval: recovers checks that were "swallowed" by mobile
  // background throttling. Runs every 15s while the user is joined as
  // aluno; if `Date.now()` has passed `nextCheckAtRef`, fires immediately.
  // Also fires immediately on `visibilitychange` → visible to minimize
  // perceived delay when the user reopens the app.
  useEffect(() => {
    if (profile?.role !== 'aluno') return;
    if (!joined) return;
    const tick = () => {
      const due = nextCheckAtRef.current;
      if (due !== null && Date.now() >= due) {
        firePresenceCheck();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    checkWatcherRef.current = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (checkWatcherRef.current) {
        clearInterval(checkWatcherRef.current);
        checkWatcherRef.current = null;
      }
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [joined, profile?.role, firePresenceCheck]);

  const handlePresenceCheckConfirm = useCallback(() => {
    if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);
    checksRef.current.verified += 1;
    setPresenceCheckVisible(false);
    setCheckCountdown(0);
    scheduleNextCheck();
  }, [scheduleNextCheck]);

  const stopChecks = useCallback(() => {
    if (checkTimerRef.current) { clearTimeout(checkTimerRef.current); checkTimerRef.current = null; }
    if (checkTimeoutRef.current) { clearTimeout(checkTimeoutRef.current); checkTimeoutRef.current = null; }
    nextCheckAtRef.current = null;
    setPresenceCheckVisible(false);
    setCheckCountdown(0);
  }, []);

  // ── Auto-attendance helpers ────────────────────────────────────────────────

  const recordAttendanceJoin = useCallback(async () => {
    if (!scheduledLessonId || !profile) return;
    try {
      // Delegate the upsert decision (notably: "do NOT overwrite status on
      // rejoin") to a pure helper so the rule is unit-tested in isolation.
      // See src/lib/attendanceJoin.ts and the regression test for context.
      const result = await recordAttendanceJoinCore(
        { getAttendance, upsertAttendance },
        scheduledLessonId,
        profile.id,
      );
      priorDurationRef.current = result.priorDurationSeconds;
      priorVerifiedRef.current = result.priorVerifiedChecks;
      priorTotalRef.current = result.priorTotalChecks;
      // Session-segment counters reset every (re)connect: subsequent flushes
      // send only what has accumulated since this point.
      lastFlushedSessionSecondsRef.current = 0;
      lastFlushedVerifiedRef.current = 0;
      lastFlushedTotalRef.current = 0;
    } catch (err) {
      console.error('Auto-attendance join error:', err);
    }
  }, [scheduledLessonId, profile]);

  const recordAttendanceLeave = useCallback(async (opts?: { final?: boolean }) => {
    const isFinal = opts?.final ?? false;
    const joinedAt = getJoinedAt();
    if (!scheduledLessonId || !profile || !joinedAt) return;
    if (isFinal) stopChecks();

    // Multi-tab / duplicate-handler dedup. Skip non-final flushes that fire
    // within 5s of a previous one (visibilitychange + beforeunload often
    // fire back-to-back). Final flushes always go through.
    if (!isFinal && shouldSkipFlush(scheduledLessonId, profile.id, 5000)) {
      return;
    }
    markFlushed(scheduledLessonId, profile.id);

    try {
      const leftAt = new Date().toISOString();
      // UUID por flush — usado pela RPC para idempotência (BUG F).
      const requestId = crypto.randomUUID();

      // FIX BUG #2: Usar originalJoinedAtRef (timestamp absoluto da primeira
      // entrada) como âncora do tempo de sessão. getJoinedAt() é resetado a
      // cada reconexão WebRTC e não representa o início real da sessão do aluno.
      //
      // originalJoinedAtRef é setado apenas em handleJoin() e permanece
      // estável durante toda a permanência na aula.
      const lessonStart = lessonStartedClientRef.current;
      const absJoinedAt = originalJoinedAtRef.current || joinedAt;
      const baseStart = lessonStart !== null ? Math.max(absJoinedAt, lessonStart) : absJoinedAt;

      // totalSessionSeconds = tempo total desde que o aluno entrou (descontando
      // pré-aula). Este número só cresce — nunca retrocede entre reconexões.
      const totalSessionSeconds = Math.max(0, Math.round((Date.now() - baseStart) / 1000));

      // sessionDelta = o que ainda não foi enviado ao banco nesta sessão.
      // lastFlushedSessionSecondsRef acumula tudo que já foi confirmado.
      const sessionDelta = Math.max(0, totalSessionSeconds - lastFlushedSessionSecondsRef.current);
      const verifiedDelta = Math.max(0, checksRef.current.verified - lastFlushedVerifiedRef.current);
      const totalDelta = Math.max(0, checksRef.current.total - lastFlushedTotalRef.current);

      // ── Intermediate flush (visibilitychange / beforeunload / reconnect) ──
      // Send only the deltas; status/notes are NULL so the server preserves
      // whatever was decided previously. The RPC sums counters atomically.
      if (!isFinal) {
        if (sessionDelta === 0 && verifiedDelta === 0 && totalDelta === 0) return;
        // FIX BUG #2: só avança os cursores APÓS await bem-sucedido.
        // Antes, a atualização ocorria antes do await e um erro de rede
        // "apagava" o delta, nunca sendo reenviado.
        await flushAttendanceProgress(scheduledLessonId, profile.id, {
          deltaSeconds: sessionDelta,
          verifiedChecksDelta: verifiedDelta,
          totalChecksDelta: totalDelta,
          leftAt,
          requestId,
        });
        // Cursores avançados somente após flush confirmado pelo servidor.
        lastFlushedSessionSecondsRef.current = totalSessionSeconds;
        lastFlushedVerifiedRef.current = checksRef.current.verified;
        lastFlushedTotalRef.current = checksRef.current.total;
        return;
      }

      // ── Final evaluation (explicit leave / kick / room closed) ───────────
      // A partir da migration 031, o trigger server-side `attendance_recompute_trg`
      // é a fonte de verdade para `status`/`notes`: ele recalcula a cada
      // mudança de duration_seconds usando a duração REAL da aula
      // (`ended_at - started_at` quando disponível).
      //
      // Aqui só preservamos o caminho especial "aula não iniciada formalmente":
      // nesse caso enviamos status='absent' + nota explícita. O trigger
      // detecta `sl.started_at IS NULL` e respeita esse status.
      // Para todos os outros casos enviamos os deltas SEM status/notes — o
      // trigger decide. Isso elimina BUG A (denominador volátil), BUG B
      // (status congelado) e BUG C (duração agendada vs real).
      let finalStatus: 'present' | 'absent' | null = null;
      let note: string | null = null;

      if (lessonStart === null) {
        finalStatus = 'absent';
        note = 'Aula não iniciada formalmente pelo anfitrião. Presença automática não contabilizada.';
      }

      // Final flush: send remaining deltas. Status/notes só são enviados no
      // caminho "aula não iniciada"; os demais são derivados pelo trigger.
      await flushAttendanceProgress(scheduledLessonId, profile.id, {
        deltaSeconds: sessionDelta,
        verifiedChecksDelta: verifiedDelta,
        totalChecksDelta: totalDelta,
        leftAt,
        status: finalStatus,
        notes: note,
        markedBy: profile.id,
        requestId,
      });
      // Lesson session is over for this user — stop holding the lock.
      clearFlushMarker(scheduledLessonId, profile.id);
    } catch (err) {
      console.error('Auto-attendance leave error:', err);
    }
  }, [scheduledLessonId, profile, stopChecks]);

  // Pre-join preview
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');

  // Track previous `connected` state so we can detect a drop while joined
  // and accumulate the elapsed time of the dropped session into
  // priorDurationRef BEFORE the hook resets joinedAtRef on the next
  // SUBSCRIBED. Without this, Realtime reconnects (Wi-Fi blips, network
  // changes) silently discard whole intervals and can push a present
  // student below the 75% threshold → false `absent`.
  const lastConnectedRef = useRef<boolean>(false);

  const {
    localStream,
    peers,
    isHost,
    hostIsPresent,
    isRemoteRecordingActive,
    connected,
    audioEnabled,
    videoEnabled,
    screenSharing,
    localScreenStream,
    connectionQuality,
    chatMessages,
    lessonStartedAt,
    connect,
    disconnect,
    closeRoom,
    startLesson,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
    sendChatMessage,
    deleteChatMessage,
    loadOlderMessages,
    economyMode,
    autoDegraded,
    setEconomyMode,
    muteParticipant,
    kickParticipant,
    muteAll,
    switchDevice,
    getJoinedAt,
    broadcastRecordingEvent,
    turnAvailable,
  } = useWebRTC({
    roomId: roomId ?? '',
    userId: profile?.id ?? '',
    userName: profile?.full_name ?? '',
    expectedHostId,
    scheduledLessonId,
    initialLessonStartedAt,
    onLessonStarted: (ts: number) => {
      // Persist on the scheduled lesson so reloads / late-joiners restore
      // the clock without needing a re-click.
      if (scheduledLessonId) {
        void markLessonStarted(scheduledLessonId, ts).catch((err) => {
          console.warn('[IV] markLessonStarted failed:', err);
        });
        // Fan out a push notification to enrolled students. Best-effort.
        void notifyLessonStarted(scheduledLessonId);
      }
      // Start presence checks for the local user (students only) now that
      // the lesson has actually begun.
      if (profile?.role === 'aluno') scheduleNextCheck();
    },
    onKicked: async () => {
      // Persist accumulated time/checks BEFORE the hook calls disconnect()
      // (which zeros joinedAtRef and would early-return inside
      // recordAttendanceLeave). Otherwise kicked students stay forever as
      // `present` with no left_at / duration_seconds.
      try { await recordAttendanceLeave({ final: true }); } catch { /* non-fatal */ }
      showToast('Você foi removido da sala pelo anfitrião.', 'warning');
      onLeave();
    },
    onRoomClosed: async (participants: RoomClosedParticipant[]) => {
      // Record attendance leave for this user
      await recordAttendanceLeave({ final: true });
      // Save lesson report if this is the host and has a scheduled lesson
      if (isHost && scheduledLessonId && profile) {
        try {
          const lessonStart = lessonStartedClientRef.current;
          const joinedAt = getJoinedAt();
          const baseStart = lessonStart ?? joinedAt ?? Date.now();
          const startedAt = new Date(baseStart).toISOString();
          const endedAt = new Date().toISOString();
          const durationMs = Math.max(0, Date.now() - baseStart);
          await saveReport({
            scheduled_lesson_id: scheduledLessonId,
            title: classTitleRef.current || 'Aula sem título',
            professor_id: profile.id,
            professor_name: profile.full_name,
            started_at: startedAt,
            ended_at: endedAt,
            duration_minutes: Math.round(durationMs / 60000),
            participants: participants.map((p) => ({ userId: p.userId, userName: p.userName })),
          });
          await endLesson(scheduledLessonId);
        } catch (err) {
          console.error('Error saving lesson report:', err);
        }
      }
      setJoined(false);
      // Monitors assigned to this class get redirected to /avaliacoes so they
      // can fill the post-lesson evaluation before navigating elsewhere.
      if (
        profile?.role === 'monitor' &&
        scheduledLessonId &&
        classId &&
        monitorIds.has(profile.id)
      ) {
        navigate('/avaliacoes', {
          state: {
            pendingEval: {
              scheduledLessonId,
              classId,
              monitorId: profile.id,
              lessonTitle: classTitleRef.current || undefined,
            },
          },
        });
      } else {
        onLeave();
      }
    },
  });

  const { isSpeaking: localSpeaking, audioLevel } = useSpeakingDetection(localStream);

  // Increment unread counter for messages from other users when chat is closed.
  // Placed here (after useWebRTC) so chatMessages is already in scope.
  const prevChatLengthRef = React.useRef(0);
  useEffect(() => {
    const prev = prevChatLengthRef.current;
    const curr = chatMessages.length;
    if (curr > prev && !chatOpen) {
      // Count only the new messages that are from other users.
      const newFromOthers = chatMessages
        .slice(prev)
        .filter((m) => m.userId !== (profile?.id ?? '')).length;
      if (newFromOthers > 0) setUnreadChat((n) => n + newFromOthers);
    }
    prevChatLengthRef.current = curr;
  }, [chatMessages, chatOpen, profile?.id]);

  // Keep the screen awake while in the call. On mobile/PWA, screen sleep
  // throttles WebRTC media — the most common cause of "audio captured but
  // not transmitted" reports.
  useWakeLock(joined);

  // Pause the camera track when the tab has been hidden long enough that the
  // user is clearly multitasking. `track.enabled = false` keeps the RTP
  // session alive (peers still see the same connection) but stops the
  // encoder, eliminating the bulk of CPU/battery drain in background.
  // Audio stays live so the user can keep listening.
  useEffect(() => {
    if (!joined || !localStream) return;
    const BACKGROUND_PAUSE_DELAY = 30_000; // 30s grace period
    let pauseTimer: ReturnType<typeof setTimeout> | null = null;
    let pausedByUs = false;

    const pause = () => {
      const track = localStream.getVideoTracks()[0];
      if (track && track.enabled) {
        track.enabled = false;
        pausedByUs = true;
      }
    };
    const resume = () => {
      if (!pausedByUs) return;
      const track = localStream.getVideoTracks()[0];
      // Only resume if user still wants video on (don't override a manual mute).
      if (track && videoEnabled) track.enabled = true;
      pausedByUs = false;
    };

    function onVis() {
      if (document.visibilityState === 'hidden') {
        if (pauseTimer) clearTimeout(pauseTimer);
        pauseTimer = setTimeout(pause, BACKGROUND_PAUSE_DELAY);
      } else {
        if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
        resume();
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (pauseTimer) clearTimeout(pauseTimer);
      resume();
    };
  }, [joined, localStream, videoEnabled]);

  // Mirror lessonStartedAt into the ref read by recordAttendanceLeave / report
  // saving. Also kick off student presence checks the moment the host starts
  // the lesson (covers students who joined the room early, before the click).
  // Additionally fire a non-intrusive haptic + toast when the lesson starts so
  // students with the tab in background are notified.
  const lessonStartAnnouncedRef = useRef(false);
  useEffect(() => {
    lessonStartedClientRef.current = lessonStartedAt;
    if (
      joined
      && lessonStartedAt !== null
      && profile?.role === 'aluno'
      && checkTimerRef.current === null
      && checksRef.current.total < MAX_CHECKS
    ) {
      scheduleNextCheck();
    }
    // Announce "a aula começou" once per session (alunos only)
    if (
      joined
      && lessonStartedAt !== null
      && profile?.role === 'aluno'
      && !lessonStartAnnouncedRef.current
    ) {
      lessonStartAnnouncedRef.current = true;
      try {
        // Haptic burst (mobile only)
        if ('vibrate' in navigator) navigator.vibrate?.([60, 40, 60]);
      } catch { /* non-fatal */ }
      showToast('A aula começou agora.', 'info');
    }
    if (lessonStartedAt === null) {
      lessonStartAnnouncedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonStartedAt, joined, profile?.role]);

  // Persistent "poor connection" warning. Fires a single toast when quality
  // stays at `poor` for >= POOR_CONNECTION_DELAY_MS continuously, and resets
  // the ability to warn again once it recovers (avoids spamming the user on
  // flapping connections).
  const POOR_CONNECTION_DELAY_MS = 30_000;
  const poorConnectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poorConnectionWarnedRef = useRef(false);
  useEffect(() => {
    // Clear pending timer on every quality change
    if (poorConnectionTimerRef.current) {
      clearTimeout(poorConnectionTimerRef.current);
      poorConnectionTimerRef.current = null;
    }
    if (!joined) return;
    if (connectionQuality === 'poor') {
      if (poorConnectionWarnedRef.current) return;
      poorConnectionTimerRef.current = setTimeout(() => {
        poorConnectionWarnedRef.current = true;
        const tip = videoEnabled
          ? 'Conexão instável. Considere desligar a câmera para preservar áudio e estabilidade.'
          : 'Conexão instável detectada. Áudio pode falhar — verifique sua rede.';
        showToast(tip, 'warning');
      }, POOR_CONNECTION_DELAY_MS);
    } else if (connectionQuality === 'good') {
      // Recovery → allow warning again on next degradation
      poorConnectionWarnedRef.current = false;
    }
    return () => {
      if (poorConnectionTimerRef.current) {
        clearTimeout(poorConnectionTimerRef.current);
        poorConnectionTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionQuality, joined, videoEnabled]);

  // Sprint 4.3: notify the user once when the watcher auto-engaged economy
  // mode. We rely on the hook owning the actual track flip and toast only
  // for awareness so they understand why their camera turned off.
  const autoDegradedNotifiedRef = useRef(false);
  useEffect(() => {
    if (autoDegraded && !autoDegradedNotifiedRef.current) {
      autoDegradedNotifiedRef.current = true;
      showToast(
        'Modo economia ativado automaticamente: conex\u00e3o inst\u00e1vel detectada. C\u00e2mera desligada para preservar \u00e1udio.',
        'warning',
      );
    }
    if (!autoDegraded) autoDegradedNotifiedRef.current = false;
  }, [autoDegraded, showToast]);

  // ── Reconnect duration accumulation ───────────────────────────────────────
  // When Realtime drops (`connected` flips true→false) while the user is
  // still in the room, flush the current session's delta to the server
  // (incremental RPC) so the time is persisted before joinedAtRef gets
  // reset on the subsequent SUBSCRIBED. Then on reconnect, recordAttendanceJoin
  // re-reads the (now updated) prior totals from DB and resets the
  // session-flush refs to 0 for the new segment.
  useEffect(() => {
    if (!joined) { lastConnectedRef.current = false; return; }
    if (lastConnectedRef.current && !connected) {
      // Best-effort flush. recordAttendanceLeave({final:false}) sends only
      // the unflushed delta and skips itself if a recent flush exists.
      void recordAttendanceLeave({ final: false });
    }
    // Reconnect (false → true) while joined as aluno: refresh prior counters
    // from DB (in case another session — e.g. user open in two devices, or
    // a quick re-entry — wrote in between) and ensure the presence-check
    // scheduler is armed. Without this re-arm, a Realtime drop that
    // outlives the foreground timer can leave the student silently
    // unscheduled for the rest of the lesson.
    if (!lastConnectedRef.current && connected) {
      if (profile?.role === 'aluno') {
        void recordAttendanceJoin();
        // FIX BUG #1: o guard de re-arm considera o total acumulado no banco
        // (priorTotalRef, lido no recordAttendanceJoin acima) somado ao
        // total local da sessão corrente. Sem isso, reconexões múltiplas
        // re-armam o scheduler repetidamente, acumulando 14+ checks no banco.
        // Nota: priorTotalRef é atualizado de forma assíncrona pelo
        // recordAttendanceJoin — o check aqui usa o valor da sessão anterior
        // (já suficiente para prevenir a maioria dos casos de over-scheduling).
        if (
          lessonStartedClientRef.current !== null
          && checkTimerRef.current === null
          && nextCheckAtRef.current === null
          && (checksRef.current.total + priorTotalRef.current) < MAX_CHECKS
        ) {
          scheduleNextCheck();
        }
      }
    }
    lastConnectedRef.current = connected;
  }, [connected, joined, getJoinedAt, profile?.role, recordAttendanceJoin, recordAttendanceLeave, scheduleNextCheck]);

  // ── Abrupt-exit attendance flush ──────────────────────────────────────────
  // If the user closes the tab, navigates away, kills the app, or loses
  // network, we MUST flush the attendance row so accumulated time is
  // persisted. Without this, students who never click "Sair" lose all
  // duration accounting and may end the lesson registered as absent.
  useEffect(() => {
    if (!joined) return;
    // Debounce intra-session flushes so a user toggling tabs every second
    // doesn't slam Supabase. beforeunload/pagehide stay synchronous.
    let lastFlushAt = 0;
    const FLUSH_DEBOUNCE_MS = 5_000;
    const flushImmediate = () => { void recordAttendanceLeave(); };
    const flushDebounced = () => {
      const now = Date.now();
      if (now - lastFlushAt < FLUSH_DEBOUNCE_MS) return;
      lastFlushAt = now;
      void recordAttendanceLeave();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushDebounced();
    };
    window.addEventListener('beforeunload', flushImmediate);
    window.addEventListener('pagehide', flushImmediate);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flushImmediate);
      window.removeEventListener('pagehide', flushImmediate);
      document.removeEventListener('visibilitychange', onVisibility);
      // Component unmount while still joined → flush as well.
      flushImmediate();
    };
  }, [joined, recordAttendanceLeave]);

  // ── Device enumeration for pre-join ────────────────────────────────────────

  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
      setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
    } catch { /* devices not available */ }
  }, []);

  const startPreview = useCallback(async () => {
    // Adaptive constraints: cap resolution + enable AEC/NS/AGC. Critical for
    // Android low-end devices where empty {video:true} can request 1080p@30fps.
    const audioBase: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    const videoBase: MediaTrackConstraints = {
      width: { ideal: 640, max: 1280 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: 'user',
    };
    // Minimal audio profile for legacy mics that reject AEC/NS/AGC combos.
    const minimalAudio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    const audioWith = (base: MediaTrackConstraints): MediaTrackConstraints =>
      selectedAudioDevice ? { deviceId: { exact: selectedAudioDevice }, ...base } : base;
    const videoWith = (): MediaTrackConstraints =>
      selectedVideoDevice ? { deviceId: { exact: selectedVideoDevice }, ...videoBase } : videoBase;

    // Tier 1 — full audio + video.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioWith(audioBase),
        video: videoWith(),
      });
      setPreviewStream(stream);
      await enumerateDevices();
      return;
    } catch { /* fall through */ }

    // Tier 2 — full audio only (camera blocked / unavailable).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioWith(audioBase) });
      setPreviewStream(stream);
      await enumerateDevices();
      return;
    } catch { /* fall through */ }

    // Tier 3 — minimal audio (mic rejected AEC/NS/AGC).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioWith(minimalAudio) });
      setPreviewStream(stream);
      await enumerateDevices();
    } catch { /* no devices */ }
  }, [selectedAudioDevice, selectedVideoDevice, enumerateDevices]);

  useEffect(() => {
    if (!joined && roomId) {
      startPreview();
    }
    return () => {
      previewStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  async function handleJoin() {
    // Pre-check camera/mic permissions so users get a clear, actionable
    // message instead of a generic getUserMedia error (Android: permission
    // panel under Site Settings, often forgotten after first denial).
    try {
      if ('permissions' in navigator && navigator.permissions?.query) {
        const [cam, mic] = await Promise.all([
          navigator.permissions.query({ name: 'camera' as PermissionName }).catch(() => null),
          navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null),
        ]);
        if (cam?.state === 'denied' && mic?.state === 'denied') {
          showToast('Câmera e microfone bloqueados. Habilite-os nas configurações do navegador para entrar na aula.', 'warning');
        } else if (mic?.state === 'denied') {
          showToast('Microfone bloqueado. Você entrará apenas como ouvinte.', 'warning');
        }
      }
    } catch { /* permissions API unsupported (older browsers) */ }

    previewStream?.getTracks().forEach((t) => t.stop());
    setPreviewStream(null);
    checksRef.current = { verified: 0, total: 0 };
    // FIX BUG #2: registra o timestamp absoluto da primeira entrada. Este ref
    // nunca é sobrescrito em reconexões, garantindo que toda a duração da
    // sessão seja calculada a partir deste ponto original.
    originalJoinedAtRef.current = Date.now();
    // Também reseta os cursores de flush para que a nova sessão comece do zero.
    lastFlushedSessionSecondsRef.current = 0;
    lastFlushedVerifiedRef.current = 0;
    lastFlushedTotalRef.current = 0;
    await connect();
    setJoined(true);
    await recordAttendanceJoin();
    // Start random presence checks only if the lesson has already started
    // (host clicked "Iniciar" earlier). Otherwise wait for the lesson-started
    // event — see the effect below.
    if (profile?.role === 'aluno' && lessonStartedAt !== null) {
      scheduleNextCheck();
    }
  }

  // ── Recording-aware close ──────────────────────────────────────────────────
  // Keep liveRecStatusRef in sync so requestCloseRoom (a non-effect function)
  // can read the latest status without a stale closure.
  useEffect(() => {
    liveRecStatusRef.current = liveRecStatus;
  }, [liveRecStatus]);

  // Once the recording settles (done/error) after a pending room close, proceed.
  useEffect(() => {
    if (pendingRoomClose && (liveRecStatus === 'done' || liveRecStatus === 'error')) {
      setPendingRoomClose(false);
      closeRoom();
    }
  }, [liveRecStatus, pendingRoomClose, closeRoom]);

  // Replaces direct closeRoom() calls — stops an active recording first, then
  // waits for the upload to complete before tearing down the room.
  function requestCloseRoom() {
    const rec = liveRecStatusRef.current;
    if (rec === 'recording') {
      recordingStopRef.current?.();   // triggers stopping → uploading → done/error
      setPendingRoomClose(true);       // useEffect above will call closeRoom() when settled
      return;
    }
    if (rec === 'stopping' || rec === 'uploading') {
      setPendingRoomClose(true);       // already on its way — just wait
      return;
    }
    closeRoom();                       // idle / done / error — close immediately
  }

  function handleLeave() {
    if (isHost) {
      // Host leaving without explicitly clicking "Encerrar" would orphan the
      // lesson in `in_progress` state. Confirm and trigger closeRoom() so the
      // report is generated and the lesson is marked completed for everyone.
      setConfirmTitle('Encerrar aula?');
      setConfirmMsg('Você é o anfitrião. Sair agora encerrará a aula para todos os participantes e gerará o relatório. Deseja continuar?');
      setConfirmVariant('danger');
      setConfirmLabel('Encerrar aula');
      setConfirmAction(() => () => {
        requestCloseRoom();
        // requestCloseRoom() stops any active recording first, then calls closeRoom().
        // onRoomClosed handler (set in useWebRTC options) saves report + endLesson + onLeave().
      });
      setConfirmOpen(true);
      return;
    }

    // Student safeguard: if the lesson has already started and the cumulative
    // time (prior reconnects + current session) is below MIN_DURATION_RATIO,
    // warn that leaving now will count as absent.
    const performLeave = () => {
      recordAttendanceLeave({ final: true });
      disconnect();
      setJoined(false);
      onLeave();
    };

    if (profile?.role === 'aluno' && lessonStartedAt !== null) {
      const joinedAt = getJoinedAt();
      const sessionSec = joinedAt ? Math.max(0, (Date.now() - joinedAt) / 1000) : 0;
      const totalSec = priorDurationRef.current + sessionSec;
      const requiredSec = classDurationRef.current * 60 * MIN_DURATION_RATIO;
      if (totalSec < requiredSec) {
        const minutesNow = Math.floor(totalSec / 60);
        const minutesNeeded = Math.ceil(requiredSec / 60);
        setConfirmTitle('Sair agora?');
        setConfirmMsg(
          `Sair pode marcar você como ausente automaticamente. Você ficou ${minutesNow} min `
          + `dos ${minutesNeeded} min mínimos exigidos. Tem certeza?`,
        );
        setConfirmVariant('warning');
        setConfirmLabel('Sair mesmo assim');
        setConfirmAction(() => () => {
          setConfirmOpen(false);
          performLeave();
        });
        setConfirmOpen(true);
        return;
      }
    }

    performLeave();
  }

  function handleSendChat(e: React.FormEvent) {
    e.preventDefault();
    if (chatInput.trim()) {
      sendChatMessage(chatInput);
      setChatInput('');
    }
  }

  // Chat moderation: coord (any room) or monitor (only their classes — RLS
  // enforces the class scope on the DELETE call). The owner of the message
  // is also able to delete via the same API, so the button is rendered for
  // any moderator OR the message author.
  const canModerateChat = profile?.role === 'coordenacao' || profile?.role === 'monitor';
  const handleDeleteChatMessage = useCallback(async (messageId: string) => {
    try {
      await deleteChatMessage(messageId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao remover mensagem.', 'error');
    }
  }, [deleteChatMessage, showToast]);

  if (!roomId) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-iv-text">Sala de Aula</h2>
        <div className="glass-panel p-8 flex flex-col items-center justify-center text-center space-y-3">
          <Video size={32} className="text-iv-muted/50" />
          <p className="text-sm text-iv-muted">Nenhuma sala selecionada.</p>
          <button onClick={onLeave} className="px-4 py-2 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors">
            Voltar
          </button>
        </div>
      </div>
    );
  }

  // ── Modality guard: presencial → no virtual room ──────────────────────────
  if (modalityState === 'loading') {
    return (
      <div className="space-y-6">
        <div className="glass-panel p-8 flex flex-col items-center justify-center text-center space-y-3">
          <Loader2 size={28} className="text-iv-muted animate-spin" />
          <p className="text-sm text-iv-muted">Verificando aula…</p>
        </div>
      </div>
    );
  }
  if (modalityState === 'presencial') {
    const backTarget = presencialClassId ? `/turmas/${presencialClassId}` : '/agenda';
    return (
      <div className="space-y-6">
        <div className="glass-panel p-6 sm:p-8 flex flex-col items-center justify-center text-center space-y-4 max-w-xl mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/15 text-amber-300 border border-amber-500/20 flex items-center justify-center text-2xl">
            🏛️
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-iv-text">Aula presencial</h2>
          <p className="text-sm text-iv-muted max-w-md">
            Esta aula é presencial e não possui sala virtual. A presença é registrada manualmente pela coordenação ou pelo monitor da turma.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <button
              onClick={() => navigate(backTarget)}
              className="px-4 py-2 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors touch-target"
            >
              {presencialClassId ? 'Ir para a turma' : 'Voltar para a agenda'}
            </button>
            <button
              onClick={onLeave}
              className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-iv-text text-sm font-medium transition-colors touch-target"
            >
              Início
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Pre-join screen with camera preview ────────────────────────────────────

  if (!joined) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-iv-text">Sala de Aula</h2>
        <div className="glass-panel p-6 max-w-lg mx-auto space-y-5">
          {/* Camera preview */}
          <div className="relative rounded-2xl overflow-hidden bg-iv-surface aspect-video">
            {previewStream && previewStream.getVideoTracks().length > 0 ? (
              <PreviewVideo stream={previewStream} />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-20 h-20 rounded-2xl bg-iv-accent/20 text-iv-accent flex items-center justify-center text-2xl font-bold">
                  {(profile?.full_name ?? 'V').charAt(0)}
                </div>
              </div>
            )}
          </div>

          {/* Device selection */}
          {(audioDevices.length > 1 || videoDevices.length > 1) && (
            <div className="space-y-3">
              {audioDevices.length > 1 && (
                <div>
                  <label className="text-xs text-iv-muted mb-1 block">Microfone</label>
                  <select
                    value={selectedAudioDevice}
                    onChange={(e) => setSelectedAudioDevice(e.target.value)}
                    className="w-full bg-iv-surface border border-white/10 rounded-xl px-3 py-2 text-sm text-iv-text"
                  >
                    {audioDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microfone'}</option>
                    ))}
                  </select>
                </div>
              )}
              {videoDevices.length > 1 && (
                <div>
                  <label className="text-xs text-iv-muted mb-1 block">Câmera</label>
                  <select
                    value={selectedVideoDevice}
                    onChange={(e) => setSelectedVideoDevice(e.target.value)}
                    className="w-full bg-iv-surface border border-white/10 rounded-xl px-3 py-2 text-sm text-iv-text"
                  >
                    {videoDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || 'Câmera'}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="text-center space-y-2">
            <p className="text-sm text-iv-muted">
              Sala: <span className="font-mono text-iv-text">{roomId.slice(0, 8)}…</span>
            </p>
            <div className="flex gap-3 justify-center flex-wrap">
              {/* Students are blocked from joining until the host connects
                  (hostIsPresent) or the lesson has already been started
                  (initialLessonStartedAt set). This lets students enter
                  as soon as the professor is in the channel, before the
                  formal "Iniciar Aula" click. */}
              {profile?.role === 'aluno' && initialLessonStartedAt === null && !hostIsPresent && lessonStatus !== 'in_progress' ? (
                <div className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">
                  <Clock size={16} className="shrink-0" />
                  Aguardando o professor iniciar a aula
                </div>
              ) : (
                <button
                  onClick={handleJoin}
                  className="px-6 py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors touch-target"
                >
                  Entrar
                </button>
              )}
              <button
                onClick={() => { previewStream?.getTracks().forEach((t) => t.stop()); onLeave(); }}
                className="px-6 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-iv-muted text-sm font-medium transition-colors touch-target"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Main classroom view ────────────────────────────────────────────────────

  const totalParticipants = 1 + peers.length;

  // "Presentation mode" — when someone is sharing their screen, the focused
  // tile (local or remote) takes ~75% of the area and other participants
  // become a horizontal/vertical strip of thumbnails. Local share takes
  // priority over remote (rare to coexist; the toggle makes them mutually
  // exclusive in practice).
  const remotePresenter = peers.find((p) => p.screenSharing) ?? null;
  const presenting = screenSharing || remotePresenter !== null;

  const gridCols =
    totalParticipants <= 1 ? 'grid-cols-1'
    : totalParticipants <= 2 ? 'grid-cols-1 sm:grid-cols-2'
    : totalParticipants <= 4 ? 'grid-cols-2'
    : totalParticipants <= 6 ? 'grid-cols-2 sm:grid-cols-3'
    : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4';

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] lg:h-[calc(100dvh-2rem)] gap-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-iv-text truncate">Sala de Aula</h2>
          {isHost && (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
              <Crown size={10} /> Anfitrião
            </span>
          )}
          {lessonStartedAt === null && (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
              <Clock size={10} /> Aguardando início
            </span>
          )}
          {!connected && (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 shrink-0">
              <Loader2 size={10} className="animate-spin" /> Reconectando…
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
          {/* Elapsed time — dashes until host clicks "Iniciar aula".
              Lives in its own component so the per-second tick doesn't
              re-render every VideoTile in the room. */}
          <span className="flex items-center gap-1 text-iv-muted">
            <Clock size={13} /> <ElapsedClock startedAt={lessonStartedAt} />
          </span>
          {/* Connection quality */}
          <ConnectionBadge quality={connectionQuality} />
          {/* Participant count */}
          <span className="flex items-center gap-1 text-iv-muted">
            <Users size={14} /> {totalParticipants}
          </span>
        </div>
      </div>

      {/* Banner "Iniciar aula" — host-only, pre-start. Placed ABOVE the grid
          to keep it physically separated from the destructive "Encerrar"
          button in the controls bar (avoids accidental clicks). */}
      {isHost && lessonStartedAt === null && (
        <button
          onClick={startLesson}
          className="shrink-0 w-full rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white px-4 py-3 flex items-center justify-center gap-3 font-semibold shadow-lg shadow-emerald-900/30 animate-pulse transition-colors"
          title="Inicia a aula formalmente — começa a contar o tempo, libera as verificações de presença e notifica os alunos."
        >
          <Play size={18} />
          <span>Iniciar Aula</span>
          <span className="hidden sm:inline text-xs font-normal text-emerald-100/80">
            · começa a contar tempo e dispara presença
          </span>
        </button>
      )}

      {/* Recording consent banner — shown to all participants while recording
          is active. Host broadcast sets isRemoteRecordingActive on clients. */}
      {isRemoteRecordingActive && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300 text-xs">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          Esta aula está sendo gravada. Ao permanecer, você consente com o registro.
        </div>
      )}

      {/* Main area: grid + chat */}
      <div className="flex-1 flex gap-3 min-h-0 relative">
        {/* Overlay "Aguardando início" (alunos pré-start) — reassures the
            student that the connection is healthy and the system is just
            waiting for the professor to click "Iniciar aula". When the
            professor is already connected (hostIsPresent), tone it down. */}
        {!isHost && lessonStartedAt === null && joined && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            {hostIsPresent ? (
              <div className="glass-panel max-w-md mx-4 px-5 py-4 rounded-2xl text-center pointer-events-auto bg-iv-bg/80 backdrop-blur-md border border-emerald-500/30">
                <div className="flex items-center justify-center mb-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                </div>
                <p className="text-sm font-semibold text-iv-text mb-1">
                  Professor conectado
                </p>
                <p className="text-xs text-iv-muted leading-relaxed">
                  A contagem de tempo e as verificações de presença começam
                  quando o professor clicar em <strong>Iniciar Aula</strong>.
                </p>
              </div>
            ) : (
              <div className="glass-panel max-w-md mx-4 px-5 py-4 rounded-2xl text-center pointer-events-auto bg-iv-bg/80 backdrop-blur-md border border-amber-500/30">
                <div className="flex items-center justify-center mb-2">
                  <Clock size={20} className="text-amber-400 animate-pulse" />
                </div>
                <p className="text-sm font-semibold text-iv-text mb-1">
                  Aguardando o professor iniciar a aula
                </p>
                <p className="text-xs text-iv-muted leading-relaxed">
                  Você está conectado. Seu áudio e vídeo já estão funcionando —
                  a contagem de tempo e as verificações de presença começam
                  quando o professor clicar em <strong>Iniciar Aula</strong>.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Video grid */}
        {presenting ? (
          /* Presentation mode: focused tile + thumbnails strip.
             Strip is below on mobile / portrait, on the right on landscape. */
          <div className="flex-1 flex flex-col lg:flex-row gap-2 min-h-0">
            <div className="flex-1 min-h-0 min-w-0 rounded-xl overflow-hidden bg-black/30 ring-1 ring-emerald-500/30">
              {screenSharing ? (
                <VideoTile
                  stream={localScreenStream || localStream}
                  userName={`${profile?.full_name ?? 'Você'} (apresentando)`}
                  isLocal
                  isScreenShare={true}
                  audioEnabled={audioEnabled}
                  videoEnabled={videoEnabled}
                  isHost={isHost}
                  isMonitor={!!profile?.id && monitorIds.has(profile.id)}
                  isSpeaking={localSpeaking}
                />
              ) : remotePresenter ? (
                <RemoteVideoTile
                  key={`focus-${remotePresenter.userId}`}
                  peer={remotePresenter}
                  showHostControls={isHost}
                  isMonitor={monitorIds.has(remotePresenter.userId)}
                  onMute={() => muteParticipant(remotePresenter.userId)}
                  onKick={() => {
                    setConfirmTitle('Remover Participante');
                    setConfirmMsg(`Remover ${remotePresenter.userName} da sala?`);
                    setConfirmVariant('warning');
                    setConfirmLabel('Remover');
                    setConfirmAction(() => () => {
                      setConfirmOpen(false);
                      kickParticipant(remotePresenter.userId);
                    });
                    setConfirmOpen(true);
                  }}
                />
              ) : null}
            </div>
            {/* Thumbnails strip — horizontal on mobile, vertical column on desktop */}
            <div
              className="shrink-0 flex lg:flex-col gap-2 overflow-x-auto lg:overflow-x-visible lg:overflow-y-auto lg:w-40 max-h-28 lg:max-h-none"
            >
              {!screenSharing && (
                <div className="shrink-0 w-32 lg:w-full aspect-video lg:aspect-video">
                  <VideoTile
                    stream={localStream}
                    userName={profile?.full_name ?? 'Você'}
                    isLocal
                    audioEnabled={audioEnabled}
                    videoEnabled={videoEnabled}
                    isHost={isHost}
                    isMonitor={!!profile?.id && monitorIds.has(profile.id)}
                    isSpeaking={localSpeaking}
                  />
                </div>
              )}
              {peers
                .filter((p) => p.userId !== remotePresenter?.userId)
                .map((peer) => (
                  <div key={peer.userId} className="shrink-0 w-32 lg:w-full aspect-video">
                    <RemoteVideoTile
                      peer={peer}
                      showHostControls={isHost}
                      isMonitor={monitorIds.has(peer.userId)}
                      onMute={() => muteParticipant(peer.userId)}
                      onKick={() => {
                        setConfirmTitle('Remover Participante');
                        setConfirmMsg(`Remover ${peer.userName} da sala?`);
                        setConfirmVariant('warning');
                        setConfirmLabel('Remover');
                        setConfirmAction(() => () => {
                          setConfirmOpen(false);
                          kickParticipant(peer.userId);
                        });
                        setConfirmOpen(true);
                      }}
                    />
                  </div>
                ))}
            </div>
          </div>
        ) : (
        <div className={`flex-1 grid ${gridCols} gap-2 auto-rows-fr min-h-0 [&>*]:min-h-[100px]`}>
          <VideoTile
            stream={localStream}
            userName={profile?.full_name ?? 'Você'}
            isLocal
            audioEnabled={audioEnabled}
            videoEnabled={videoEnabled}
            isHost={isHost}
            isMonitor={!!profile?.id && monitorIds.has(profile.id)}
            isSpeaking={localSpeaking}
          />
          {peers.map((peer) => (
            <RemoteVideoTile
              key={peer.userId}
              peer={peer}
              showHostControls={isHost}
              isMonitor={monitorIds.has(peer.userId)}
              onMute={() => muteParticipant(peer.userId)}
              onKick={() => {
                setConfirmTitle('Remover Participante');
                setConfirmMsg(`Remover ${peer.userName} da sala?`);
                setConfirmVariant('warning');
                setConfirmLabel('Remover');
                setConfirmAction(() => () => {
                  setConfirmOpen(false);
                  kickParticipant(peer.userId);
                });
                setConfirmOpen(true);
              }}
            />
          ))}
        </div>
        )}

        {/* Chat panel — sidebar on desktop, fullscreen overlay on mobile */}
        {chatOpen && (
          <>
            {/* Desktop: side panel */}
            <div className="hidden md:flex w-72 flex-col glass-panel rounded-2xl overflow-hidden shrink-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-sm font-medium text-iv-text">Chat</span>
                <button onClick={() => setChatOpen(false)} className="text-iv-muted hover:text-iv-text">
                  <X size={14} />
                </button>
              </div>
              <ChatPanel
                messages={chatMessages}
                currentUserId={profile?.id ?? ''}
                onLoadOlder={loadOlderMessages}
                canModerate={canModerateChat}
                onDeleteMessage={handleDeleteChatMessage}
              />
              <form onSubmit={handleSendChat} className="flex gap-2 p-2 border-t border-white/5">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Mensagem…"
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-sm text-iv-text placeholder:text-iv-muted/50 focus:outline-none focus:ring-1 focus:ring-iv-accent"
                />
                <button type="submit" className="p-1.5 rounded-xl bg-iv-accent text-white hover:bg-iv-accent-hover transition-colors">
                  <Send size={14} />
                </button>
              </form>
            </div>
            {/* Mobile: bottom sheet (~75vh) with backdrop tap-to-close */}
            <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
              {/* Backdrop */}
              <button
                type="button"
                aria-label="Fechar chat"
                onClick={() => setChatOpen(false)}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              />
              {/* Sheet */}
              <div
                className="relative flex flex-col bg-iv-card border-t border-white/10 rounded-t-2xl shadow-2xl"
                style={{ height: 'min(75vh, 75dvh)' }}
                role="dialog"
                aria-modal="true"
                aria-label="Chat da sala"
              >
                {/* Drag handle */}
                <div className="flex justify-center pt-2 pb-1 shrink-0">
                  <span className="w-10 h-1 rounded-full bg-white/20" aria-hidden="true" />
                </div>
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 shrink-0">
                  <span className="text-sm font-medium text-iv-text">Chat</span>
                  <button
                    onClick={() => setChatOpen(false)}
                    className="p-2 -mr-2 text-iv-muted hover:text-iv-text touch-target rounded-lg"
                    aria-label="Fechar chat"
                  >
                    <X size={20} />
                  </button>
                </div>
                <div className="flex-1 min-h-0 flex flex-col">
                  <ChatPanel
                    messages={chatMessages}
                    currentUserId={profile?.id ?? ''}
                    onLoadOlder={loadOlderMessages}
                    canModerate={canModerateChat}
                    onDeleteMessage={handleDeleteChatMessage}
                  />
                </div>
                <form onSubmit={handleSendChat} className="flex gap-2 p-3 border-t border-white/5 safe-bottom shrink-0">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Mensagem…"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-iv-text placeholder:text-iv-muted/50 focus:outline-none focus:ring-1 focus:ring-iv-accent"
                  />
                  <button type="submit" className="p-2 rounded-xl bg-iv-accent text-white hover:bg-iv-accent-hover transition-colors touch-target" aria-label="Enviar">
                    <Send size={16} />
                  </button>
                </form>
              </div>
            </div>
          </>
        )}

        {/* Participants drawer — sidebar on desktop, bottom sheet on mobile.
            Reuses the same UX as the chat panel. */}
        {participantsOpen && (() => {
          const onlineIds = new Set<string>();
          if (profile?.id) onlineIds.add(profile.id);
          for (const p of peers) onlineIds.add(p.userId);
          const peerById = new Map(peers.map((p) => [p.userId, p]));
          const onlineCount = onlineIds.size;
          const totalEnrolled = enrolledStudents.length;
          // Compose the rendered roster: enrolled students first, then any
          // unexpected guests currently connected (e.g. coordinator joining
          // ad-hoc) so the host always sees who is in the room.
          const enrolledIds = new Set(enrolledStudents.map((s) => s.id));
          const extras = peers
            .filter((p) => !enrolledIds.has(p.userId) && p.userId !== profile?.id)
            .map((p) => ({ id: p.userId, full_name: p.userName, isExtra: true }));
          const roster: Array<{ id: string; full_name: string; isExtra?: boolean }> = [
            ...enrolledStudents.map((s) => ({ id: s.id, full_name: s.full_name })),
            ...extras,
          ];

          const renderRow = (item: { id: string; full_name: string; isExtra?: boolean }) => {
            const isOnline = onlineIds.has(item.id);
            const isMe = item.id === profile?.id;
            const peer = peerById.get(item.id);
            return (
              <li
                key={item.id}
                className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors"
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isOnline ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-iv-muted/30'
                  }`}
                  aria-label={isOnline ? 'Conectado' : 'Ausente'}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-iv-text truncate">
                    {item.full_name}
                    {isMe && <span className="ml-1 text-[10px] text-iv-muted">(você)</span>}
                    {item.isExtra && (
                      <span className="ml-1 text-[10px] text-amber-400">(convidado)</span>
                    )}
                  </p>
                  <p className="text-[10px] text-iv-muted">
                    {isOnline ? 'Conectado' : 'Não entrou ainda'}
                  </p>
                </div>
                {isHost && peer && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => muteParticipant(peer.userId)}
                      className="p-1.5 rounded-lg text-iv-muted hover:text-amber-400 hover:bg-white/5 transition-colors"
                      title="Silenciar"
                      aria-label={`Silenciar ${peer.userName}`}
                    >
                      <VolumeX size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setConfirmTitle('Remover Participante');
                        setConfirmMsg(`Remover ${peer.userName} da sala?`);
                        setConfirmVariant('warning');
                        setConfirmLabel('Remover');
                        setConfirmAction(() => () => {
                          setConfirmOpen(false);
                          kickParticipant(peer.userId);
                        });
                        setConfirmOpen(true);
                      }}
                      className="p-1.5 rounded-lg text-iv-muted hover:text-red-400 hover:bg-white/5 transition-colors"
                      title="Remover"
                      aria-label={`Remover ${peer.userName}`}
                    >
                      <LogOut size={14} />
                    </button>
                  </div>
                )}
              </li>
            );
          };

          return (
            <>
              {/* Desktop: side panel */}
              <div className="hidden md:flex w-72 flex-col glass-panel rounded-2xl overflow-hidden shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-iv-text">Participantes</span>
                    <span className="text-[11px] text-iv-muted">
                      {onlineCount} de {totalEnrolled || onlineCount} conectado{onlineCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <button onClick={() => setParticipantsOpen(false)} className="text-iv-muted hover:text-iv-text">
                    <X size={14} />
                  </button>
                </div>
                <ul className="flex-1 overflow-y-auto p-2 space-y-1">
                  {roster.length === 0 ? (
                    <li className="text-xs text-iv-muted text-center py-6">
                      Nenhum participante listado.
                    </li>
                  ) : (
                    roster.map(renderRow)
                  )}
                </ul>
              </div>
              {/* Mobile: bottom sheet */}
              <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
                <button
                  type="button"
                  aria-label="Fechar participantes"
                  onClick={() => setParticipantsOpen(false)}
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                />
                <div
                  className="relative flex flex-col bg-iv-card border-t border-white/10 rounded-t-2xl shadow-2xl"
                  style={{ height: 'min(75vh, 75dvh)' }}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Participantes da sala"
                >
                  <div className="flex justify-center pt-2 pb-1 shrink-0">
                    <span className="w-10 h-1 rounded-full bg-white/20" aria-hidden="true" />
                  </div>
                  <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-iv-text">Participantes</span>
                      <span className="text-[11px] text-iv-muted">
                        {onlineCount} de {totalEnrolled || onlineCount} conectado{onlineCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <button
                      onClick={() => setParticipantsOpen(false)}
                      className="p-2 -mr-2 text-iv-muted hover:text-iv-text touch-target rounded-lg"
                      aria-label="Fechar participantes"
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <ul className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                    {roster.length === 0 ? (
                      <li className="text-xs text-iv-muted text-center py-6">
                        Nenhum participante listado.
                      </li>
                    ) : (
                      roster.map(renderRow)
                    )}
                  </ul>
                </div>
              </div>
            </>
          );
        })()}
      </div>

      {/* Controls bar */}
      <div className="shrink-0 flex flex-wrap items-center justify-center gap-2 py-2 sm:py-3 relative safe-bottom">
        {/* Audio level indicator */}
        <div className="absolute left-4 bottom-5 hidden sm:flex items-center gap-2">
          <AudioLevelBar level={audioLevel} />
        </div>

        {/* Indicador de progresso de presença para o aluno (auditoria Fase C #7) */}
        {profile?.role === 'aluno' && (
          <div className="absolute right-4 bottom-5 hidden sm:flex items-center gap-2">
            <AttendanceProgressBadge
              lessonStartedAt={lessonStartedAt}
              classDurationMin={classDurationRef.current}
              getPriorDurationSec={() => priorDurationRef.current}
              getJoinedAt={getJoinedAt}
            />
          </div>
        )}

        <ControlButton
          active={audioEnabled}
          onClick={async () => {
            // Wrap toggleAudio so failures (NotAllowedError, NotReadableError,
            // OverconstrainedError after the full fallback ladder) surface a
            // clear, actionable toast instead of failing silently.
            try {
              await toggleAudio();
            } catch (err) {
              const code = err instanceof Error ? err.message : '';
              const reason = code.startsWith('audio:') ? code.slice(6) : '';
              const msg =
                reason === 'NotAllowedError' ? 'Microfone bloqueado. Habilite a permissão nas configurações do navegador.' :
                reason === 'NotReadableError' ? 'Microfone em uso por outro aplicativo. Feche-o e tente novamente.' :
                reason === 'NotFoundError' ? 'Nenhum microfone disponível neste dispositivo.' :
                'Não foi possível ativar o microfone. Verifique as permissões e o hardware.';
              showToast(msg, 'error');
            }
          }}
          icon={audioEnabled ? <Mic size={18} /> : <MicOff size={18} />}
          title={audioEnabled ? 'Desativar microfone' : 'Ativar microfone'}
        />
        <ControlButton active={videoEnabled} onClick={toggleVideo} icon={videoEnabled ? <Video size={18} /> : <VideoOff size={18} />} title={videoEnabled ? 'Desat­var câmera' : 'Ativar câmera'} />
        <ControlButton
          active={economyMode}
          onClick={() => {
            setEconomyMode(!economyMode);
            if (!economyMode) showToast('Modo economia ativado: câmera desligada para preservar dados / bateria.', 'info');
            else showToast('Modo economia desativado. Toque na câmera para ligar vídeo novamente.', 'info');
          }}
          icon={<Leaf size={18} />}
          title={economyMode ? 'Desativar modo economia' : 'Modo economia (só áudio)'}
          accent
        />
        <span className="hidden sm:inline"><ControlButton active={screenSharing} onClick={toggleScreenShare} icon={<Monitor size={18} />} title={screenSharing ? 'Parar compartilhamento' : 'Compartilhar tela'} accent /></span>
        <ControlButton active={chatOpen} onClick={() => { setChatOpen((v) => !v); setParticipantsOpen(false); }} icon={<MessageCircle size={18} />} title="Chat" accent badge={unreadChat > 0 ? unreadChat : undefined} />
        <ControlButton active={participantsOpen} onClick={() => { setParticipantsOpen((v) => !v); setChatOpen(false); }} icon={<Users size={18} />} title="Participantes" accent />
        <ControlButton active={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)} icon={<Settings size={18} />} title="Configurações" accent />
        {(isHost || (!!profile?.id && monitorIds.has(profile.id))) && (
          <RecordingControls
            userId={profile?.id ?? ''}
            localStream={localStream}
            localScreenStream={localScreenStream}
            peers={peers}
            scheduledLessonId={scheduledLessonId}
            classId={classId}
            lessonTitle={classTitleRef.current || 'Aula'}
            onStatusChange={broadcastRecordingEvent}
            alreadyRecordingRemotely={isRemoteRecordingActive}
            stopRef={recordingStopRef}
            onStatusUpdate={(s) => { setLiveRecStatus(s); liveRecStatusRef.current = s; }}
          />
        )}
        {isHost && (
          <button
            onClick={() => {
              setConfirmTitle('Silenciar Todos');
              setConfirmMsg('Silenciar o microfone de todos os participantes?');
              setConfirmVariant('warning');
              setConfirmLabel('Silenciar Todos');
              setConfirmAction(() => () => {
                setConfirmOpen(false);
                muteAll();
              });
              setConfirmOpen(true);
            }}
            className="p-3 rounded-2xl bg-amber-600 hover:bg-amber-700 text-white transition-colors touch-target"
            title="Silenciar todos"
          >
            <VolumeX size={18} />
          </button>
        )}
        {isHost && (
          <button
            onClick={() => {
              setConfirmTitle('Encerrar Sala');
              setConfirmMsg('Encerrar a sala para todos os participantes? O relatório será salvo.');
              setConfirmVariant('danger');
              setConfirmLabel('Encerrar');
              setConfirmAction(() => () => {
                setConfirmOpen(false);
                requestCloseRoom();
              });
              setConfirmOpen(true);
            }}
            className="p-3 rounded-2xl bg-red-600 hover:bg-red-700 text-white transition-colors touch-target flex items-center gap-2 px-4"
            title="Encerrar sala"
          >
            <Square size={14} />
            <span className="text-xs font-semibold hidden sm:inline">Encerrar</span>
          </button>
        )}
        {profile?.role === 'monitor' && scheduledLessonId && classId && profile?.id && monitorIds.has(profile.id) && (
          <button
            onClick={() => setEvalModalOpen(true)}
            className="p-3 rounded-2xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-400/40 transition-colors touch-target flex items-center gap-2 px-4"
            title="Avaliar aula (confidencial)"
          >
            <ClipboardCheck size={16} />
            <span className="text-xs font-semibold hidden sm:inline">Avaliar</span>
          </button>
        )}
        {/* Dinâmicas (polls) — staff bound to the class. */}
        {scheduledLessonId && classId && profile?.id && (
          profile.role === 'coordenacao'
          || profile.role === 'professor'
          || (profile.role === 'monitor' && monitorIds.has(profile.id))
        ) && (
          <button
            onClick={() => setPollsDrawerOpen(true)}
            className="p-3 rounded-2xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-400/30 transition-colors touch-target flex items-center gap-2 px-4 relative"
            title="Dinâmicas / Polls"
          >
            <BarChart3 size={16} />
            <span className="text-xs font-semibold hidden sm:inline">Dinâmicas</span>
            {polls.some((p) => p.status === 'open') && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full ring-2 ring-iv-bg animate-pulse" aria-label="Dinâmica em andamento" />
            )}
          </button>
        )}
        <button onClick={handleLeave} className="p-3 rounded-2xl bg-white/10 hover:bg-white/15 text-iv-muted transition-colors touch-target" title="Sair da sala">
          <PhoneOff size={18} />
        </button>
      </div>

      {profile?.role === 'monitor' && scheduledLessonId && classId && profile?.id && (
        <EvaluateLessonModal
          open={evalModalOpen}
          onClose={() => setEvalModalOpen(false)}
          scheduledLessonId={scheduledLessonId}
          classId={classId}
          monitorId={profile.id}
          lessonTitle={classTitleRef.current || undefined}
        />
      )}

      {/* Phase 4 — staff drawer for poll authoring. */}
      {scheduledLessonId && classId && profile?.id && (
        profile.role === 'coordenacao'
        || profile.role === 'professor'
        || (profile.role === 'monitor' && monitorIds.has(profile.id))
      ) && (
        <PollsDrawer
          open={pollsDrawerOpen}
          onClose={() => setPollsDrawerOpen(false)}
          scheduledLessonId={scheduledLessonId}
          classId={classId}
          authorId={profile.id}
          polls={polls}
        />
      )}

      {/* Phase 4 — student auto-prompt when a poll is open. We pick the
          most recently opened poll the student hasn't dismissed yet. */}
      {profile?.role === 'aluno' && profile?.id && classId && (() => {
        const open = polls
          .filter((p) => p.status === 'open' && !dismissedPollIds.has(p.id))
          .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))[0];
        if (!open) return null;
        return (
          <PollResponseModal
            poll={open}
            classId={classId}
            studentId={profile.id}
            onClose={() => setDismissedPollIds((cur) => new Set(cur).add(open.id))}
          />
        );
      })()}

      {/* Settings popover */}
      {settingsOpen && <SettingsPopover onClose={() => setSettingsOpen(false)} onSwitchDevice={switchDevice} />}

      {/* Recording-upload gate: shown while room is waiting for upload to settle */}
      {pendingRoomClose && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass-panel p-6 rounded-2xl max-w-sm w-full mx-4 text-center space-y-4 animate-in fade-in zoom-in-95">
            <Loader2 size={40} className="animate-spin text-amber-400 mx-auto" />
            <h3 className="text-lg font-bold text-iv-text">Aguardando upload da gravação…</h3>
            <p className="text-sm text-iv-muted">
              A sala será encerrada automaticamente assim que o arquivo for enviado ao Google Drive.
            </p>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => confirmAction?.()}
        title={confirmTitle}
        message={confirmMsg}
        confirmLabel={confirmLabel}
        variant={confirmVariant}
      />

      {presenceCheckVisible && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass-panel p-6 rounded-2xl max-w-sm w-full mx-4 text-center space-y-4 animate-in fade-in zoom-in-95">
            <div className="w-14 h-14 rounded-full bg-iv-accent/20 text-iv-accent flex items-center justify-center mx-auto text-2xl font-bold">
              ✓
            </div>
            <h3 className="text-lg font-bold text-iv-text">Verificação de presença</h3>
            <p className="text-sm text-iv-muted">
              Confirme que você ainda está assistindo a aula.
            </p>
            <div className="text-3xl font-mono font-bold text-iv-accent">
              {checkCountdown}s
            </div>
            <p className="text-xs text-iv-muted">
              A presença será invalidada se não responder a tempo.
            </p>
            <button
              onClick={handlePresenceCheckConfirm}
              className="w-full px-6 py-3 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-semibold transition-colors touch-target"
            >
              Estou presente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── PreviewVideo ─────────────────────────────────────────────────────────────

function PreviewVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />;
}

// ── ConnectionBadge ──────────────────────────────────────────────────────────

function ConnectionBadge({ quality }: { quality: ConnectionQuality }) {
  const cfg = {
    excellent: { icon: <Wifi size={13} />, text: 'Excelente', color: 'text-emerald-400' },
    good: { icon: <Wifi size={13} />, text: 'Boa', color: 'text-amber-400' },
    poor: { icon: <WifiOff size={13} />, text: 'Fraca', color: 'text-red-400' },
    disconnected: { icon: <WifiOff size={13} />, text: 'Desconectado', color: 'text-red-500' },
  }[quality];

  return (
    <span className={`flex items-center gap-1 text-xs ${cfg.color}`} title={`Conexão: ${cfg.text}`}>
      {cfg.icon}
    </span>
  );
}

// ── AudioLevelBar ────────────────────────────────────────────────────────────

function AudioLevelBar({ level }: { level: number }) {
  const bars = 5;
  return (
    <div className="flex items-end gap-0.5 h-5">
      {Array.from({ length: bars }).map((_, i) => {
        const threshold = (i + 1) * (100 / bars);
        const active = level >= threshold;
        return (
          <div
            key={i}
            className={`w-1 rounded-full transition-all duration-100 ${active ? 'bg-emerald-400' : 'bg-white/10'}`}
            style={{ height: `${((i + 1) / bars) * 100}%` }}
          />
        );
      })}
    </div>
  );
}

// ── ChatPanel ────────────────────────────────────────────────────────────────

function ChatPanel({
  messages,
  currentUserId,
  onLoadOlder,
  canModerate = false,
  onDeleteMessage,
}: {
  messages: ChatMessage[];
  currentUserId: string;
  onLoadOlder?: (limit?: number) => Promise<number>;
  /** True when the local user can hard-delete any message (coord / monitor). */
  canModerate?: boolean;
  /** Invoked when a moderator (or the message author) confirms deletion. */
  onDeleteMessage?: (messageId: string) => void | Promise<void>;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // Auto-scroll to bottom on NEW outgoing messages, but suppress while the
  // user is paginating older messages (otherwise prepended history yanks
  // them right back to the bottom).
  const lastLenRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > lastLenRef.current && !loadingOlder) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    lastLenRef.current = messages.length;
  }, [messages, loadingOlder]);

  const handleLoadOlder = useCallback(async () => {
    if (!onLoadOlder || loadingOlder || exhausted) return;
    setLoadingOlder(true);
    try {
      const got = await onLoadOlder(100);
      if (got === 0) setExhausted(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [onLoadOlder, loadingOlder, exhausted]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-black/10">
      {onLoadOlder && messages.length > 0 && (
        <div className="flex justify-center">
          {exhausted ? (
            <span className="text-[11px] text-iv-muted/40">Início do histórico</span>
          ) : (
            <button
              type="button"
              onClick={handleLoadOlder}
              disabled={loadingOlder}
              className="text-[11px] px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-iv-muted disabled:opacity-50"
            >
              {loadingOlder ? 'Carregando…' : 'Carregar mensagens antigas'}
            </button>
          )}
        </div>
      )}
      {messages.length === 0 && (
        <div className="h-full flex flex-col items-center justify-center text-iv-muted/40 space-y-3">
          <MessageCircle size={36} className="opacity-40" />
          <p className="text-sm">O chat está vazio.</p>
        </div>
      )}
      {messages.map((msg) => {
        const isOwn = msg.userId === currentUserId;
        const canDelete = !!onDeleteMessage && (canModerate || isOwn);
        const handleDelete = () => {
          if (!onDeleteMessage) return;
          if (typeof window !== 'undefined' && !window.confirm('Remover esta mensagem para todos?')) return;
          void onDeleteMessage(msg.id);
        };
        return (
          <div key={msg.id} className={`group flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
            {!isOwn && <span className="text-[11px] font-medium text-iv-accent/70 mb-1 ml-1">{msg.userName}</span>}
            <div className={`flex items-center gap-1.5 max-w-[85%] ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
              <div className={`px-3.5 py-2.5 rounded-2xl text-sm shadow-sm leading-relaxed ${
                isOwn
                  ? 'bg-iv-accent text-white rounded-tr-sm'
                  : 'bg-white/10 text-iv-text rounded-tl-sm border border-white/5'
              }`}>
                {msg.text}
              </div>
              {canDelete && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1.5 rounded-full text-iv-muted/70 hover:text-red-400 hover:bg-white/5 touch-target"
                  aria-label="Remover mensagem"
                  title="Remover mensagem"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <span className="text-[10px] text-iv-muted/40 mt-1.5 mx-1 font-medium tracking-wide">
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

// ── VideoTile ────────────────────────────────────────────────────────────────

const VideoTile = React.memo(function VideoTile({
  stream,
  userName,
  isLocal,
  audioEnabled,
  videoEnabled,
  isHost,
  isMonitor,
  isSpeaking,
  hostControls,
  isScreenShare,
}: {
  stream: MediaStream | null;
  userName: string;
  isLocal: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  isHost: boolean;
  /** True when this participant is a class monitor of the current room. */
  isMonitor?: boolean;
  isSpeaking: boolean;
  hostControls?: { onMute: () => void; onKick: () => void };
  isScreenShare?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Dedicated <audio> element for REMOTE peers. The <video> tag is always
  // muted to avoid the iOS Safari / Android WebView quirk where playback of
  // a srcObject without video frames (audio-only peers) silently fails or is
  // blocked by the autoplay policy. A separate <audio> element plays the
  // audio track regardless of whether video frames exist.
  const audioRef = useRef<HTMLAudioElement>(null);
  // Tracks whether the browser blocked play() due to autoplay policy.
  // On iOS Safari the gesture-context is NOT propagated through the async
  // ontrack → syncPeers → setState → useEffect chain, so the first play()
  // attempt may fail with NotAllowedError even if the user previously tapped
  // to join. When blocked we register a one-shot interaction listener that
  // retries play() on the very next tap/click.
  const [playBlocked, setPlayBlocked] = useState(false);

  useEffect(() => {
    if (!stream) return;
    // Attach the same MediaStream reference to both elements. The browser
    // shares track decoders between elements, so this is cheap.
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
      // The <video> tag is always muted (audio plays via <audio> for remotes,
      // local has no remote audio to play anyway), so play() should succeed
      // even under strict autoplay policies.
      void videoRef.current.play().catch(() => { /* muted element — safe */ });
    }
    if (!isLocal && audioRef.current && audioRef.current.srcObject !== stream) {
      audioRef.current.srcObject = stream;
      // Audio element is NOT muted — this is where autoplay can be blocked
      // on iOS Safari. We catch NotAllowedError and surface a tap prompt.
      void audioRef.current.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setPlayBlocked(true);
        }
      });
    }
  }, [stream, isLocal]);

  // Retry play() on next user interaction (iOS Safari autoplay fallback).
  useEffect(() => {
    if (!playBlocked || !audioRef.current) return;
    const el = audioRef.current;
    const retry = () => {
      void el.play().then(() => setPlayBlocked(false)).catch(() => {});
    };
    document.addEventListener('click', retry, { once: true });
    document.addEventListener('touchstart', retry, { once: true, passive: true });
    return () => {
      document.removeEventListener('click', retry);
      document.removeEventListener('touchstart', retry);
    };
  }, [playBlocked]);

  // CRITICAL: keep the <video> element mounted at all times so the underlying
  // MediaStream (and therefore the audio track) is never torn down by the
  // browser when the camera is toggled off. We hide it via CSS instead of
  // removing it from the DOM. On mobile especially, unmounting the <video>
  // node was killing the audio along with the camera.
  const showVideo = !!stream && (isScreenShare || videoEnabled);
  return (
    <div className={`relative rounded-2xl overflow-hidden bg-iv-surface border-2 transition-colors duration-200 group ${isSpeaking ? 'border-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.3)]' : 'border-white/5'}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        // Always muted: audio for remote peers plays via the separate <audio>
        // element below. Muting the <video> element avoids iOS Safari /
        // Android WebView autoplay restrictions on the visible tile.
        muted
        aria-hidden={!showVideo}
        className={`w-full h-full ${isScreenShare ? 'object-contain bg-black' : 'object-cover'} ${isLocal && !isScreenShare ? 'scale-x-[-1]' : ''} ${showVideo ? '' : 'invisible absolute inset-0 pointer-events-none'}`}
      />
      {/* Hidden audio sink for remote peers. Required because <video> is muted. */}
      {!isLocal && (
        <audio ref={audioRef} autoPlay playsInline className="hidden" />
      )}
      {!showVideo && (
        <div className="w-full h-full flex items-center justify-center bg-iv-surface">
          <div className="w-16 h-16 rounded-2xl bg-iv-accent/20 text-iv-accent flex items-center justify-center text-xl font-bold">
            {userName.charAt(0)}
          </div>
        </div>
      )}
      {/* iOS Safari autoplay-blocked indicator: tap anywhere to unblock */}
      {playBlocked && !isLocal && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
          <span className="text-xs text-white/80 px-2 py-1 rounded-lg bg-black/50">Toque para ouvir</span>
        </div>
      )}

      {/* Name overlay */}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
        <div className="flex items-center gap-1.5">
          {isHost && <Crown size={10} className="text-amber-400" />}
          {isMonitor && (
            <span
              className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide rounded-md bg-amber-500/30 text-amber-200 border border-amber-400/40"
              title="Monitor da turma"
            >
              Monitor
            </span>
          )}
          <span className="text-xs text-white font-medium truncate">{isLocal ? `${userName} (Você)` : userName}</span>
          {!audioEnabled && <MicOff size={10} className="text-red-400" />}
          {!videoEnabled && <VideoOff size={10} className="text-red-400" />}
        </div>
      </div>

      {/* Host controls overlay */}
      {hostControls && (
        <div className="absolute top-2 right-2 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <button onClick={hostControls.onMute} className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors touch-target" title="Silenciar">
            <VolumeX size={14} />
          </button>
          <button onClick={hostControls.onKick} className="p-2 rounded-lg bg-black/50 text-red-400 hover:bg-black/70 transition-colors touch-target" title="Remover">
            <LogOut size={14} />
          </button>
        </div>
      )}
    </div>
  );
});

// ── RemoteVideoTile (with speaking detection per-stream) ─────────────────────

const RemoteVideoTile = React.memo(function RemoteVideoTile({
  peer,
  showHostControls,
  isMonitor,
  onMute,
  onKick,
}: {
  peer: Peer;
  showHostControls: boolean;
  isMonitor?: boolean;
  onMute: () => void;
  onKick: () => void;
}) {
  const { isSpeaking } = useSpeakingDetection(peer.stream);

  return (
    <VideoTile
      stream={peer.stream}
      userName={peer.userName}
      isLocal={false}
      audioEnabled={peer.audioEnabled}
      videoEnabled={peer.videoEnabled}
      isHost={false}
      isMonitor={isMonitor}
      isSpeaking={isSpeaking}
      isScreenShare={peer.screenSharing}
      hostControls={showHostControls ? { onMute, onKick } : undefined}
    />
  );
});

// ── SettingsPopover ──────────────────────────────────────────────────────────

function SettingsPopover({ onClose, onSwitchDevice }: { onClose: () => void; onSwitchDevice: (kind: 'audio' | 'video', deviceId: string) => Promise<void> }) {
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudio, setSelectedAudio] = useState('');
  const [selectedVideo, setSelectedVideo] = useState('');

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
      setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
    }).catch(() => {});
  }, []);

  return (
    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 w-80 max-w-[calc(100vw-2rem)] glass-panel rounded-2xl p-4 space-y-3 z-50">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-iv-text">Configurações</h3>
        <button onClick={onClose} className="text-iv-muted hover:text-iv-text touch-target flex items-center justify-center">
          <X size={18} />
        </button>
      </div>
      <div>
        <label className="text-xs text-iv-muted mb-1 block">Microfone</label>
        <select
          value={selectedAudio}
          onChange={(e) => { setSelectedAudio(e.target.value); onSwitchDevice('audio', e.target.value); }}
          className="w-full bg-iv-surface border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text"
        >
          {audioDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microfone'}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-iv-muted mb-1 block">Câmera</label>
        <select
          value={selectedVideo}
          onChange={(e) => { setSelectedVideo(e.target.value); onSwitchDevice('video', e.target.value); }}
          className="w-full bg-iv-surface border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text"
        >
          {videoDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || 'Câmera'}</option>
          ))}
        </select>
      </div>
      <p className="text-[10px] text-iv-muted/50">A troca de dispositivo é aplicada imediatamente.</p>
    </div>
  );
}

// ── ControlButton ────────────────────────────────────────────────────────────

function ControlButton({
  active,
  onClick,
  icon,
  title,
  accent,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  accent?: boolean;
  badge?: number;
}) {
  const base = accent
    ? active
      ? 'bg-iv-accent text-white'
      : 'bg-white/10 text-iv-muted hover:bg-white/15'
    : active
      ? 'bg-white/10 text-iv-text hover:bg-white/15'
      : 'bg-red-500/20 text-red-400 hover:bg-red-500/30';

  return (
    <button
      onClick={onClick}
      className={`relative p-3 rounded-2xl transition-colors touch-target ${base}`}
      title={title}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none pointer-events-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

// ── ElapsedClock ─────────────────────────────────────────────────────────────
// Isolated tick so the per-second update only re-renders this <span>, not the
// whole ClassroomView (and its VideoTiles). Pauses while the tab is hidden.

function ElapsedClock({ startedAt }: { startedAt: number | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => force((n) => (n + 1) % 1_000_000);
    const start = () => {
      tick();
      return setInterval(tick, 1000);
    };
    let id: ReturnType<typeof setInterval> | null = null;
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      id = start();
    }
    function onVis() {
      if (document.visibilityState === 'visible') {
        if (!id) id = start();
      } else {
        if (id) { clearInterval(id); id = null; }
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [startedAt]);

  if (startedAt === null) return <>{'--:--'}</>;
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (
    <>
      {h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`}
    </>
  );
}
