/**
 * ReposicoesView.tsx
 *
 * Standalone page for the makeup (reposição) workflow.
 *
 * - coordenacao / professor / monitor — management panel:
 *     • FJ at-risk section (students with pending deadlines)
 *     • Full submission list with inline approve / reject
 * - aluno — personal panel:
 *     • Cards for each justified absence that has a recording ready
 *     • Inline player + "Enviar Resumo" button leading to MakeupSummaryModal
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell, BookOpen, Calendar, CheckCircle2, ChevronDown,
  Eye, Film, RefreshCw, Send, SkipForward,
  ThumbsDown, ThumbsUp, XCircle,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';
import {
  listAllSubmissions,
  markWatched,
  reviewSubmission,
} from '../../services/makeup.service';
import { updateAttendance } from '../../services/attendance.service';
import type { MakeupSubmission, MakeupSubmissionStatus } from '../../types';
import type { RecordingMeta } from '../../services/recording.service';
import { listRecordingsForLessons } from '../../services/recording.service';
import MakeupSummaryModal from '../ui/MakeupSummaryModal';
import MakeupStatusBadge from '../ui/MakeupStatusBadge';
import EmptyState from '../ui/EmptyState';
import PageLoader from '../ui/PageLoader';
import PullToRefresh from '../ui/PullToRefresh';

// ── Types ─────────────────────────────────────────────────────────────────────

/** An aluno's FJ/F absence enriched with class info and recordings. */
interface FjEntry {
  attendanceId:       string;
  scheduledLessonId:  string;
  classId:            string;
  className:          string;
  scheduledAt:        string;
  makeupDeadline:     string | null;
  absenceStatus:      'justified' | 'absent';
  recordings:         RecordingMeta[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const IFRAME_BASE = 'https://drive.google.com/file/d';

function formatDate(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString('pt-BR', opts ?? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Convert a UTC ISO string to a value suitable for <input type="datetime-local">. */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeDeadline(iso: string): { text: string; kind: 'overdue' | 'soon' | 'ok' } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) {
    const hours = Math.floor(Math.abs(ms) / 3_600_000);
    const days  = Math.floor(hours / 24);
    return { text: `vencido há ${days >= 1 ? `${days}d` : `${hours}h`}`, kind: 'overdue' };
  }
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return { text: `${hours}h restantes`, kind: 'soon' };
  const days = Math.floor(hours / 24);
  return {
    text: `${days} ${days === 1 ? 'dia' : 'dias'}`,
    kind: ms < 48 * 3_600_000 ? 'soon' : 'ok',
  };
}

const STATUS_COLORS: Record<MakeupSubmissionStatus, string> = {
  pending:   'text-iv-muted',
  submitted: 'text-blue-400',
  approved:  'text-emerald-400',
  rejected:  'text-red-400',
};
const STATUS_LABELS: Record<MakeupSubmissionStatus, string> = {
  pending:   'Pendentes',
  submitted: 'Para revisar',
  approved:  'Aprovados',
  rejected:  'Reprovados',
};

// ── Staff panel ───────────────────────────────────────────────────────────────

interface StaffData {
  subs:          MakeupSubmission[];
  profilesById:  Record<string, { full_name: string; role: string }>;
  scheduled:     { id: string; class_id: string; scheduled_at: string }[];
  classes:       { id: string; name: string }[];
  pendingRows:   { id: string; student_id: string; scheduled_lesson_id: string; makeup_deadline: string | null; status: 'justified' | 'absent'; last_reminder_sent_at?: string | null }[];
}

async function loadStaffData(): Promise<StaffData> {
  const [subsResult, profilesResult, scheduledResult, classesResult, pendingResult] = await Promise.all([
    listAllSubmissions({ limit: 500 }),
    supabase.from('profiles').select('id, full_name, role').limit(1000),
    supabase.from('scheduled_lessons').select('id, class_id, scheduled_at').order('scheduled_at', { ascending: false }).limit(1000),
    supabase.from('classes').select('id, name').order('name').limit(500),
    // FJ rows with deadline + F rows (absent) — both need makeup tracking
    supabase.from('attendance')
      .select('id, student_id, scheduled_lesson_id, makeup_deadline, status')
      .in('status', ['justified', 'absent'])
      .eq('makeup_satisfied', false)
      .order('makeup_deadline', { ascending: true, nullsFirst: false })
      .limit(500),
  ]);

  const profilesById: Record<string, { full_name: string; role: string }> = {};
  (profilesResult.data ?? []).forEach((p: any) => { profilesById[p.id] = { full_name: p.full_name, role: p.role }; });

  return {
    subs:         subsResult,
    profilesById,
    scheduled:    (scheduledResult.data ?? []) as any[],
    classes:      (classesResult.data ?? []) as any[],
    pendingRows:  (pendingResult.data ?? []) as any[],
  };
}

// ── Aluno data ────────────────────────────────────────────────────────────────

async function loadAlunoData(studentId: string): Promise<FjEntry[]> {
  // Load FJ (justified) and F (absent) rows — both get content access
  const { data: attRows, error: attErr } = await supabase
    .from('attendance')
    .select(`
      id, student_id, scheduled_lesson_id, makeup_deadline, status,
      scheduled_lessons(id, class_id, scheduled_at, classes(id, name))
    `)
    .eq('student_id', studentId)
    .in('status', ['justified', 'absent'])
    .order('scheduled_at', { foreignTable: 'scheduled_lessons', ascending: false });

  if (attErr) throw new Error(attErr.message);

  const rows = (attRows ?? []) as any[];
  if (rows.length === 0) return [];

  // Collect ids for recording lookup
  const slIds    = [...new Set(rows.map((r: any) => r.scheduled_lesson_id).filter(Boolean) as string[])];
  const classIds = [...new Set(rows.map((r: any) => r.scheduled_lessons?.class_id).filter(Boolean) as string[])];

  const allRecs = await listRecordingsForLessons({ scheduledLessonIds: slIds, classIds });

  const recsBySl:    Record<string, RecordingMeta[]> = {};
  const recsByClass: Record<string, RecordingMeta[]> = {};
  allRecs.forEach((meta) => {
    if (meta.scheduledLessonId) (recsBySl[meta.scheduledLessonId] ??= []).push(meta);
    if (meta.classId)           (recsByClass[meta.classId] ??= []).push(meta);
  });

  return rows.map((row: any): FjEntry => {
    const sl      = row.scheduled_lessons as any;
    const cls     = sl?.classes as any;
    const slId    = row.scheduled_lesson_id as string;
    const classId = sl?.class_id as string;
    const recordings = recsBySl[slId] ?? recsByClass[classId] ?? [];
    return {
      attendanceId:      row.id as string,
      scheduledLessonId: slId,
      classId:           classId ?? '',
      className:         cls?.name ?? 'Turma',
      scheduledAt:       sl?.scheduled_at ?? '',
      makeupDeadline:    row.makeup_deadline as string | null,
      absenceStatus:     row.status as 'justified' | 'absent',
      recordings,
    };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReposicoesView() {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const role = profile?.role;
  const isStaff = role === 'coordenacao' || role === 'professor' || role === 'monitor';
  const isCoord = role === 'coordenacao';
  const canManageMakeups = role === 'coordenacao' || role === 'monitor';
  const isAluno = role === 'aluno';

  // ── Staff state ──────────────────────────────────────────────────────────
  const [staffData,        setStaffData]        = useState<StaffData | null>(null);
  const [staffTab,         setStaffTab]          = useState<'pendencias' | 'submissoes'>('pendencias');
  const [statusFilter,     setStatusFilter]      = useState<MakeupSubmissionStatus | ''>('');
  const [classFilter,      setClassFilter]       = useState('');
  const [reviewingId,      setReviewingId]       = useState<string | null>(null);
  const [reviewNotes,      setReviewNotes]       = useState('');
  const [extendingId,      setExtendingId]       = useState<string | null>(null);
  const [extendDate,       setExtendDate]        = useState('');
  const [extendedIds,      setExtendedIds]       = useState<Set<string>>(new Set());
  const [dismissingId,     setDismissingId]      = useState<string | null>(null);
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(null);
  const [reminderSentAtById, setReminderSentAtById] = useState<Record<string, number>>({});

  // ── Aluno state ──────────────────────────────────────────────────────────
  const [fjEntries,        setFjEntries]         = useState<FjEntry[]>([]);
  const [subMap,           setSubMap]            = useState<Record<string, MakeupSubmission>>({});
  const [playerOpen,       setPlayerOpen]        = useState<Set<string>>(new Set());
  const [summaryTarget,    setSummaryTarget]      = useState<{ rec: RecordingMeta; sub: MakeupSubmission; deadline: string | null } | null>(null);

  // ── Shared ───────────────────────────────────────────────────────────────
  const [loading,          setLoading]           = useState(true);

  // ── Load ─────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      if (isStaff) {
        const data = await loadStaffData();
        setStaffData(data);
      } else if (isAluno) {
        const entries = await loadAlunoData(profile.id);
        setFjEntries(entries);

        // Load the student's submissions for all recordings in the entries
        const recIds = entries.flatMap((e) => e.recordings.map((r) => r.id));
        if (recIds.length > 0) {
          const subs = await listAllSubmissions({ studentId: profile.id, recordingIds: recIds });
          const map: Record<string, MakeupSubmission> = {};
          subs.forEach((s) => { map[s.recording_id] = s; });
          setSubMap(map);
        }
      }
    } catch (e) {
      showToast('Erro ao carregar reposições.', 'error');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [profile, isStaff, isAluno, showToast]);

  useEffect(() => { void load(); }, [load]);

  // ── Aluno: watch a recording ─────────────────────────────────────────────

  const handleWatch = useCallback(async (rec: RecordingMeta, deadline: string | null) => {
    if (!profile) return;
    setPlayerOpen((prev) => {
      const next = new Set(prev);
      next.add(rec.id);
      return next;
    });
    try {
      const sub = await markWatched(rec.id, profile.id, rec.scheduledLessonId ?? null, rec.classId ?? null);
      setSubMap((prev) => ({ ...prev, [rec.id]: sub }));
    } catch (e) {
      console.error('[handleWatch]', e);
    }
  }, [profile]);

  // ── Staff: review a submission ────────────────────────────────────────────

  const handleReview = useCallback(async (subId: string, status: 'approved' | 'rejected') => {
    if (!profile?.id) return;
    try {
      await reviewSubmission(subId, status, profile.id, reviewNotes || undefined);
      setStaffData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          subs: prev.subs.map((s) =>
            s.id === subId
              ? { ...s, status, reviewer_notes: reviewNotes || null, reviewed_by: profile.id, reviewed_at: new Date().toISOString() }
              : s,
          ),
        };
      });
      setReviewingId(null);
      setReviewNotes('');
      showToast(status === 'approved' ? 'Reposição aprovada.' : 'Reposição reprovada.', 'success');
      // Approval closes the FJ obligation via the makeup_submission_reconcile_attendance
      // trigger (migration 042 §M1); refetch staff data so the "FJ at risk"
      // banner reflects the new server state. Rejections do not change FJ rows
      // but a refetch is cheap and keeps counters honest.
      void load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao revisar.', 'error');
    }
  }, [profile, reviewNotes, showToast, load]);

  // ── Staff: extend FJ deadline ────────────────────────────────────────────

  const handleExtendDeadline = useCallback(async (attendanceId: string) => {
    if (!extendDate) return;
    try {
      await updateAttendance(attendanceId, { makeup_deadline: new Date(extendDate).toISOString() });
      setExtendingId(null);
      setExtendDate('');
      setExtendedIds((prev) => {
        const next = new Set(prev);
        next.add(attendanceId);
        return next;
      });
      showToast('Prazo estendido.', 'success');
      void load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao estender prazo.', 'error');
    }
  }, [extendDate, showToast, load]);

  // ── Staff: dismiss (resolved / skipped) ──────────────────────────────────
  const handleDismiss = useCallback(async (a: StaffData['pendingRows'][0], mode: 'resolved' | 'skipped') => {
    try {
      await updateAttendance(a.id, { makeup_satisfied: true });
      
      await supabase
        .from('makeup_submissions')
        .delete()
        .eq('student_id', a.student_id)
        .eq('scheduled_lesson_id', a.scheduled_lesson_id)
        .eq('status', 'pending');

      setDismissingId(null);
      showToast(mode === 'resolved' ? 'Reposição marcada como resolvida.' : 'Reposição pulada.', 'success');
      void load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao dispensar.', 'error');
    }
  }, [showToast, load]);

  // ── Staff: send makeup reminder push ─────────────────────────────────────

  const handleSendReminder = useCallback(async (
    a: StaffData['pendingRows'][0],
  ) => {
    setSendingReminderId(a.id);
    try {
      const existingReminderMs = a.last_reminder_sent_at ? new Date(a.last_reminder_sent_at).getTime() : null;
      const localReminderMs = reminderSentAtById[a.id] ?? null;
      const lastReminderMs = existingReminderMs ?? localReminderMs;
      const nextAllowedMs = lastReminderMs ? lastReminderMs + 6 * 60 * 60 * 1000 : null;
      if (nextAllowedMs && nextAllowedMs > Date.now()) {
        const hours = Math.ceil((nextAllowedMs - Date.now()) / (60 * 60 * 1000));
        showToast(`Lembrete já enviado. Tente novamente em ${hours}h.`, 'info');
        return;
      }

      const sd = staffData;
      if (!sd) return;
      const { profilesById, scheduled, classes } = sd;
      const name  = profilesById[a.student_id]?.full_name ?? 'aluno';
      const sl    = scheduled.find((s) => s.id === a.scheduled_lesson_id);
      const cl    = sl ? classes.find((c) => c.id === sl.class_id) : null;
      const dlMs  = a.makeup_deadline
        ? new Date(a.makeup_deadline).getTime()
        : sl ? new Date(sl.scheduled_at).getTime() + 7 * 24 * 60 * 60 * 1000 : null;
      const daysLeft = dlMs !== null ? Math.ceil((dlMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;
      const prazoText = daysLeft === null ? ''
        : daysLeft <= 0  ? ' O prazo já está vencido!'
        : daysLeft === 1 ? ' O prazo expira amanhã!'
        : ` O prazo expira em ${daysLeft} dias.`;
      const lessonDate = sl
        ? new Date(sl.scheduled_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
        : '';
      const turma = cl?.name ? ` (${cl.name})` : '';
      const body  = `Olá, ${name}! Não esqueça de realizar sua reposição da aula de ${lessonDate}${turma}.${prazoText}`;

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Sessão expirada.');

      const res = await fetch('/api/push/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userIds: [a.student_id],
          title:   '⏰ Lembrete de Reposição',
          body,
          tag:     `makeup-reminder-${a.id}`,
          kind:    'makeup-reminder',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error((err.error as string) ?? `HTTP ${res.status}`);
      }

      setReminderSentAtById((prev) => ({ ...prev, [a.id]: Date.now() }));
      try {
        await updateAttendance(a.id, { last_reminder_sent_at: new Date().toISOString() });
      } catch (e) {
        if (!(e instanceof Error) || !/last_reminder_sent_at/.test(e.message)) {
          throw e;
        }
      }
      showToast('Lembrete enviado ao aluno.', 'success');
      void load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao enviar lembrete.', 'error');
    } finally {
      setSendingReminderId(null);
    }
  }, [staffData, showToast, load]);

  if (loading) return <PageLoader />;

  // ── Aluno render ──────────────────────────────────────────────────────────

  if (isAluno) {
    const allReady = fjEntries.filter((e) => e.recordings.length > 0);
    const noRecs   = fjEntries.filter((e) => e.recordings.length === 0);

    return (
      <PullToRefresh onRefresh={load}>
        <div className="space-y-5 pb-20 min-w-0 max-w-full overflow-x-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Film size={22} className="text-iv-accent" />
              <h1 className="text-xl font-semibold text-white">Minhas Reposições</h1>
            </div>
            <button onClick={load} className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors" title="Atualizar">
              <RefreshCw size={16} />
            </button>
          </div>

          {fjEntries.length === 0 ? (
            <EmptyState
              icon={<Film size={28} />}
              title="Nenhuma reposição pendente"
              description="Quando você tiver uma falta (F ou FJ), a gravação da aula aparecerá aqui para você assistir e enviar o resumo."
            />
          ) : (
            <>
              {allReady.map((entry) => {
                const dl = entry.makeupDeadline;
                const dlInfo = dl ? relativeDeadline(dl) : null;

                return (
                  <div key={entry.attendanceId} className="glass-panel p-4 border border-white/8 space-y-3">
                    {/* Class / lesson header */}
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-sm font-semibold text-iv-text">{entry.className}</p>
                        <p className="text-xs text-iv-muted mt-0.5">
                          Aula de {formatDate(entry.scheduledAt, { day: '2-digit', month: 'short', year: 'numeric' })}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                          entry.absenceStatus === 'justified'
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-red-500/15 text-red-400'
                        }`}>
                          {entry.absenceStatus === 'justified' ? 'FJ' : 'F'}
                        </span>
                        {dlInfo ? (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            dlInfo.kind === 'overdue' ? 'bg-red-500/15 text-red-400'
                            : dlInfo.kind === 'soon' ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-blue-500/15 text-blue-400'
                          }`}>
                            {dlInfo.text}
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-iv-muted/60">
                            sem prazo
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Recordings for this FJ */}
                    {entry.recordings.map((rec) => {
                      const sub   = subMap[rec.id];
                      const watching = playerOpen.has(rec.id);
                      const expired  = dl ? new Date(dl).getTime() < Date.now() : false;
                      const canSubmit = !!sub
                        && sub.status !== 'approved'
                        && sub.status !== 'submitted'
                        && !expired;

                      return (
                        <div key={rec.id} className="space-y-2.5 pt-1 border-t border-white/5 first:border-t-0 first:pt-0">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0">
                              <Film size={14} className="text-iv-accent shrink-0" />
                              <p className="text-sm text-iv-text truncate">
                                {rec.title.replace(/\.(webm|mp4|mkv|ogg|avi)$/i, '')}
                              </p>
                              {rec.source === 'external' && (
                                <span className="text-[10px] bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded-full font-medium shrink-0">
                                  Externa
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap shrink-0">
                              {sub && <MakeupStatusBadge status={sub.status} watched={!!sub.watched_at} />}
                              {!watching && (
                                <button
                                  onClick={() => handleWatch(rec, dl)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-iv-accent hover:bg-iv-accent-hover text-white text-xs font-medium transition-colors"
                                >
                                  <Eye size={12} /> Assistir
                                </button>
                              )}
                              {watching && canSubmit && (
                                <button
                                  onClick={() => sub && setSummaryTarget({ rec, sub, deadline: dl })}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                                >
                                  <Send size={12} /> Enviar Resumo
                                </button>
                              )}
                            </div>
                          </div>

                          {watching && rec.gdriveFileId && (
                            <div className="rounded-xl overflow-hidden border border-white/10 bg-black aspect-video max-h-[38vh] sm:max-h-none">
                              <iframe
                                src={`${IFRAME_BASE}/${rec.gdriveFileId}/preview`}
                                title={rec.title}
                                allow="autoplay"
                                allowFullScreen
                                className="w-full h-full"
                              />
                            </div>
                          )}

                          {sub?.status === 'rejected' && sub.reviewer_notes && (
                            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300">
                              <span className="font-semibold">Feedback: </span>{sub.reviewer_notes}
                            </div>
                          )}

                          {sub?.status === 'submitted' && (
                            <p className="text-xs text-blue-400">Resumo enviado — aguardando revisão da coordenação.</p>
                          )}
                          {sub?.status === 'approved' && (
                            <p className="text-xs text-emerald-400 flex items-center gap-1">
                              <CheckCircle2 size={12} /> Reposição aprovada.
                            </p>
                          )}
                          {expired && !sub?.status && (
                            <p className="text-xs text-red-400 flex items-center gap-1">
                              <XCircle size={12} /> Prazo encerrado — não é mais possível enviar o resumo.
                            </p>
                          )}
                          {entry.absenceStatus === 'absent' && !sub?.status && (
                            <p className="text-xs text-iv-muted/60">
                              Falta registrada (F) — assista e envie o resumo para acessar o conteúdo. Isso não remove a falta do registro.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* FJ/F without recordings */}
              {noRecs.length > 0 && (
                <details className="group">
                  <summary className="text-xs text-iv-muted cursor-pointer select-none flex items-center gap-1.5 py-1 hover:text-iv-text transition-colors">
                    <ChevronDown size={13} className="group-open:rotate-180 transition-transform" />
                    {noRecs.length} falta{noRecs.length !== 1 ? 's' : ''} sem gravação disponível
                  </summary>
                  <div className="mt-2 space-y-2">
                    {noRecs.map((e) => (
                      <div key={e.attendanceId} className="flex items-center justify-between gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/8 opacity-60">
                        <div>
                          <p className="text-xs font-medium text-iv-text">{e.className}</p>
                          <p className="text-[11px] text-iv-muted">
                            {formatDate(e.scheduledAt, { day: '2-digit', month: 'short', year: 'numeric' })}
                          </p>
                        </div>
                        <span className="text-[11px] text-iv-muted italic">Gravação não disponível</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          {/* Summary modal */}
          {summaryTarget && (
            <MakeupSummaryModal
              submissionId={summaryTarget.sub.id}
              recordingTitle={summaryTarget.rec.title}
              deadline={summaryTarget.deadline}
              isResubmission={summaryTarget.sub.status === 'rejected'}
              initialText={summaryTarget.sub.status === 'rejected' ? summaryTarget.sub.summary : null}
              reviewerNotes={summaryTarget.sub.status === 'rejected' ? summaryTarget.sub.reviewer_notes : null}
              onClose={() => setSummaryTarget(null)}
              onSubmitted={() => {
                setSummaryTarget(null);
                void load();
              }}
            />
          )}
        </div>
      </PullToRefresh>
    );
  }

  // ── Staff render ──────────────────────────────────────────────────────────
  if (!isStaff || !staffData) {
    return <PageLoader />;
  }

  const { subs, profilesById, scheduled, classes, pendingRows } = staffData;

  const filteredSubs = subs.filter((s) => {
    if (statusFilter && s.status !== statusFilter) return false;
    if (classFilter  && s.class_id !== classFilter) return false;
    return true;
  });

  function effectiveDeadline(a: typeof pendingRows[0]): number {
    if (a.makeup_deadline) return new Date(a.makeup_deadline).getTime();
    const sl = scheduled.find((s) => s.id === a.scheduled_lesson_id);
    if (!sl) return Infinity;
    return new Date(sl.scheduled_at).getTime() + 7 * 24 * 60 * 60 * 1000;
  }

  // Build set of (lesson_id|student_id) with approved submissions to exclude from at-risk
  const approvedKeys = new Set<string>();
  subs
    .filter((s) => s.status === 'approved')
    .forEach((s) => {
      approvedKeys.add(`${s.scheduled_lesson_id}|${s.student_id}`);
    });

  const atRisk = pendingRows.filter((a) =>
    !approvedKeys.has(`${a.scheduled_lesson_id}|${a.student_id}`) &&
    profilesById[a.student_id]?.role === 'aluno',
  );


  const now     = Date.now();
  const overdue = atRisk.filter((a) => effectiveDeadline(a) <  now);
  const soon48  = atRisk.filter((a) => { const t = effectiveDeadline(a); return t >= now && t < now + 48 * 3_600_000; });
  const future  = atRisk.filter((a) => effectiveDeadline(a) >= now + 48 * 3_600_000);

  // All pending rows (F + FJ), deadline computed when not explicitly set
  const totalPending = atRisk.length;
  const toReview = subs.filter((s) => s.status === 'submitted').length;
  const approved = subs.filter((s) => s.status === 'approved').length;

  function PendingRow({ a, border, bg }: { a: typeof pendingRows[0]; border: string; bg: string }) {
    const sl       = scheduled.find((s) => s.id === a.scheduled_lesson_id);
    const cl       = sl ? classes.find((c) => c.id === sl.class_id) : null;
    const sub      = subs.find((s) => s.scheduled_lesson_id === a.scheduled_lesson_id && s.student_id === a.student_id);
    // Use explicit deadline or compute +7d from lesson date
    const virtualDl     = !a.makeup_deadline && sl
      ? new Date(new Date(sl.scheduled_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const effectiveDlStr = a.makeup_deadline ?? virtualDl;
    const dlInfo         = effectiveDlStr ? relativeDeadline(effectiveDlStr) : null;
    const isVirtualDl    = !a.makeup_deadline && !!virtualDl;
    const existingReminderMs = a.last_reminder_sent_at ? new Date(a.last_reminder_sent_at).getTime() : null;
    const localReminderMs = reminderSentAtById[a.id] ?? null;
    const lastReminderMs = existingReminderMs ?? localReminderMs;
    const isReminderBlocked = lastReminderMs ? lastReminderMs + 6 * 60 * 60 * 1000 > Date.now() : false;
    const reminderRemainingHours = isReminderBlocked
      ? Math.ceil((lastReminderMs! + 6 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000))
      : 0;
    const isExtendedDeadline = extendedIds.has(a.id);
    const isReviewingThis = reviewingId === sub?.id;
    return (
      <div className={`p-3 rounded-xl border ${border} ${bg} space-y-2`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ${a.status === 'justified' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
              {a.status === 'justified' ? 'FJ' : 'F'}
            </span>
            <span className="text-sm font-medium text-iv-text truncate">{profilesById[a.student_id]?.full_name ?? a.student_id.slice(0, 8) + '…'}</span>
            {isExtendedDeadline && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">Prazo estendido</span>
            )}
            {cl && <span className="text-xs text-iv-muted shrink-0">· {cl.name}</span>}
            {sl && <span className="text-xs text-iv-muted shrink-0">· {formatDate(sl.scheduled_at, { day: '2-digit', month: 'short' })}</span>}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {dlInfo ? (
              <span
                title={isVirtualDl ? 'Prazo calculado (+7 dias da aula)' : undefined}
                className={`text-xs font-semibold ${
                  isVirtualDl
                    ? dlInfo.kind === 'overdue' ? 'text-red-300/60' : dlInfo.kind === 'soon' ? 'text-amber-300/60' : 'text-white/35'
                    : dlInfo.kind === 'overdue' ? 'text-red-300' : dlInfo.kind === 'soon' ? 'text-amber-300' : 'text-blue-300'
                }`}
              >
                {isVirtualDl ? '~' : ''}{dlInfo.text}
              </span>
            ) : (
              <span className="text-xs text-iv-muted/50">sem prazo</span>
            )}
            {isReminderBlocked && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
                Lembrete bloqueado ({reminderRemainingHours}h)
              </span>
            )}
            {sub && (
              <MakeupStatusBadge status={sub.status} watched={!!sub.watched_at} variant="pill" />
            )}
          </div>
        </div>
        {isCoord && sub?.status === 'submitted' && !isReviewingThis && (
          <button
            onClick={() => { setReviewingId(sub.id); setReviewNotes(''); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-iv-muted transition-colors border border-white/10"
          >
            <BookOpen size={12} /> Revisar resumo
          </button>
        )}

        {/* Coord-only: extend deadline / dismiss — shown when NOT reviewing */}
        {isCoord && !isReviewingThis && (() => {
          const isExtendingThis = extendingId === a.id;
          const isDismissingThis = dismissingId === a.id;
          if (isExtendingThis) return (
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              <input
                type="datetime-local"
                value={extendDate}
                min={toDatetimeLocal(new Date().toISOString())}
                onChange={(e) => setExtendDate(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-iv-text focus:outline-none focus:ring-1 focus:ring-iv-accent"
              />
              <button
                onClick={() => handleExtendDeadline(a.id)}
                disabled={!extendDate}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-xs border border-blue-500/20 disabled:opacity-40 transition-colors"
              >
                <Calendar size={12} /> Salvar prazo
              </button>
              <button
                onClick={() => { setExtendingId(null); setExtendDate(''); }}
                className="px-2.5 py-1.5 rounded-lg text-xs text-iv-muted hover:bg-white/5 transition-colors"
              >
                Cancelar
              </button>
            </div>
          );
          if (isDismissingThis) return (
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              <span className="text-xs text-iv-muted">Dispensar como:</span>
              <button
                onClick={() => handleDismiss(a, 'resolved')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs border border-emerald-500/20 transition-colors"
              >
                <CheckCircle2 size={12} /> Resolvido
              </button>
              <button
                onClick={() => handleDismiss(a, 'skipped')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-iv-muted text-xs border border-white/10 transition-colors"
              >
                <SkipForward size={12} /> Pulado
              </button>
              <button
                onClick={() => setDismissingId(null)}
                className="px-2.5 py-1.5 rounded-lg text-xs text-iv-muted hover:bg-white/5 transition-colors"
              >
                Cancelar
              </button>
            </div>
          );
          return (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <button
                onClick={() => {
                  const d = a.makeup_deadline
                    ? new Date(a.makeup_deadline)
                    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                  setExtendingId(a.id);
                  setExtendDate(toDatetimeLocal(d.toISOString()));
                  setDismissingId(null);
                  setReviewingId(null);
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-iv-muted border border-white/10 transition-colors"
              >
                <Calendar size={12} /> Estender prazo
              </button>
              <button
                onClick={() => { setDismissingId(a.id); setExtendingId(null); setExtendDate(''); setReviewingId(null); }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-iv-muted border border-white/10 transition-colors"
              >
                <SkipForward size={12} /> Dispensar
              </button>
              <button
                onClick={() => handleSendReminder(a)}
                disabled={sendingReminderId === a.id || isReminderBlocked}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-iv-muted border border-white/10 disabled:opacity-40 transition-colors"
              >
                <Bell size={12} /> {sendingReminderId === a.id ? 'Enviando…' : isReminderBlocked ? 'Aguarde' : 'Enviar lembrete'}
              </button>
            </div>
          );
        })()}
        {isCoord && isReviewingThis && sub && (
          <div className="space-y-2 pt-1">
            {sub.summary && (
              <p className="text-xs text-iv-muted/80 leading-relaxed line-clamp-3 bg-white/[0.02] rounded-lg px-3 py-2 border border-white/5">
                {sub.summary}
              </p>
            )}
            <textarea
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              placeholder="Feedback para o aluno (opcional)…"
              rows={2}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text placeholder:text-iv-muted/40 resize-none focus:outline-none focus:ring-1 focus:ring-iv-accent"
            />
            <div className="flex flex-wrap gap-2 justify-end">
              <button onClick={() => setReviewingId(null)} className="px-3 py-1.5 rounded-lg text-xs text-iv-muted hover:bg-white/5 transition-colors">
                Cancelar
              </button>
              <button
                onClick={() => handleReview(sub.id, 'rejected')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs transition-colors border border-red-500/20"
              >
                <ThumbsDown size={12} /> Reprovar
              </button>
              <button
                onClick={() => handleReview(sub.id, 'approved')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs transition-colors border border-emerald-500/20"
              >
                <ThumbsUp size={12} /> Aprovar
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={load}>
      <div className="space-y-5 pb-20 min-w-0 max-w-full overflow-x-hidden">
        {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Film size={22} className="text-iv-accent" />
          <h1 className="text-xl font-semibold text-white">Reposições</h1>
        </div>
        <button onClick={load} className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors" title="Atualizar">
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${totalPending > 0 ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'bg-white/5 text-iv-muted border-white/10'}`}>
          {totalPending} pendente{totalPending !== 1 ? 's' : ''}
        </span>
        {toReview > 0 && (
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30">
            {toReview} para revisar
          </span>
        )}
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          {approved} aprovado{approved !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-white/5 rounded-xl border border-white/8 w-fit">
        {(['pendencias', 'submissoes'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setStaffTab(tab)}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              staffTab === tab
                ? 'bg-iv-accent/20 text-iv-accent border border-iv-accent/30'
                : 'text-iv-muted hover:text-iv-text'
            }`}
          >
            {tab === 'pendencias' ? `Pendências${totalPending > 0 ? ` (${totalPending})` : ''}` : `Submissões${toReview > 0 ? ` (${toReview})` : ''}`}
          </button>
        ))}
      </div>

      {/* ── PENDÊNCIAS tab ── */}
      {staffTab === 'pendencias' && (
        <div className="space-y-4">
          {atRisk.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={28} />}
              title="Nenhuma pendência"
              description="Todos os alunos com faltas já satisfizeram o requisito de reposição."
            />
          ) : (
            <>
              {/* Overdue */}
              {overdue.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-red-400/80 font-semibold">Prazo vencido ({overdue.length})</p>
                  {overdue.map((a) => (
                    <PendingRow key={a.id} a={a} border="border-red-500/40" bg="bg-red-500/10" />
                  ))}
                </div>
              )}

              {/* Soon */}
              {soon48.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-amber-400/80 font-semibold">Vencem em até 48h ({soon48.length})</p>
                  {soon48.map((a) => (
                    <PendingRow key={a.id} a={a} border="border-amber-500/40" bg="bg-amber-500/10" />
                  ))}
                </div>
              )}

              {/* Future / within deadline */}
              {future.length > 0 && (
                <details className="group" open>
                  <summary className="text-[11px] uppercase tracking-wide text-blue-400/80 font-semibold cursor-pointer select-none">
                    Dentro do prazo ({future.length})
                  </summary>
                  <div className="space-y-2 mt-2">
                    {future.slice(0, 30).map((a) => (
                      <PendingRow key={a.id} a={a} border="border-blue-500/30" bg="bg-blue-500/10" />
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      )}

      {/* ── SUBMISSÕES tab ── */}
      {staffTab === 'submissoes' && (
        <div className="space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(['pending', 'submitted', 'approved', 'rejected'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter((prev) => prev === s ? '' : s)}
                className={`glass-panel p-3 text-center rounded-xl border transition-colors ${
                  statusFilter === s ? 'border-iv-accent/50 bg-iv-accent/10' : 'border-white/8 hover:bg-white/[0.07]'
                }`}
              >
                <p className="text-[10px] text-iv-muted uppercase tracking-wide">{STATUS_LABELS[s]}</p>
                <p className={`text-lg font-bold ${STATUS_COLORS[s]}`}>
                  {subs.filter((x) => x.status === s).length}
                </p>
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="w-full sm:w-auto bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
            >
              <option value="">Todas as turmas</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {(statusFilter || classFilter) && (
              <button
                onClick={() => { setStatusFilter(''); setClassFilter(''); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-iv-muted transition-colors border border-white/10"
              >
                <XCircle size={13} /> Limpar filtros
              </button>
            )}
          </div>

          {/* Submissions list */}
          {filteredSubs.length === 0 ? (
            <EmptyState
              icon={<Film size={28} />}
              title="Nenhuma reposição"
              description={statusFilter || classFilter ? 'Nenhuma reposição corresponde aos filtros selecionados.' : 'Reposições enviadas pelos alunos aparecerão aqui.'}
            />
          ) : (
            <div className="space-y-3">
              {filteredSubs.map((sub) => {
                const studentName = profilesById[sub.student_id]?.full_name ?? sub.student_id.slice(0, 8) + '…';
                const cls  = sub.class_id  ? classes.find((c) => c.id === sub.class_id)           : null;
                const isReviewing = reviewingId === sub.id;

                return (
                  <div key={sub.id} className="glass-panel p-4 space-y-2.5 border border-white/8">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <MakeupStatusBadge status={sub.status} watched={!!sub.watched_at} variant="pill" />
                        <span className="text-sm font-semibold text-iv-text">{studentName}</span>
                        {cls && <span className="text-xs text-iv-muted">{cls.name}</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-iv-muted">
                        {sub.watched_at   && <span>Assistiu: {formatDate(sub.watched_at,   { day: '2-digit', month: 'short' })}</span>}
                        {sub.submitted_at && <span>Enviou: {formatDate(sub.submitted_at, { day: '2-digit', month: 'short' })}</span>}
                      </div>
                    </div>

                    {sub.summary && (
                      <div className="text-xs text-iv-muted/80 leading-relaxed max-h-28 overflow-y-auto overscroll-contain bg-white/[0.02] rounded-lg px-3 py-2 border border-white/5">
                        {sub.summary}
                      </div>
                    )}

                    {sub.reviewer_notes && (
                      <p className="text-xs text-iv-muted/70 italic">
                        <span className="not-italic text-iv-muted font-semibold">Feedback: </span>
                        {sub.reviewer_notes}
                      </p>
                    )}

                    {canManageMakeups && sub.status === 'submitted' && !isReviewing && (
                      <button
                        onClick={() => { setReviewingId(sub.id); setReviewNotes(''); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-iv-muted transition-colors border border-white/10"
                      >
                        <BookOpen size={12} /> Revisar
                      </button>
                    )}

                    {canManageMakeups && isReviewing && (
                      <div className="space-y-2 pt-1">
                        <textarea
                          value={reviewNotes}
                          onChange={(e) => setReviewNotes(e.target.value)}
                          placeholder="Feedback para o aluno (opcional)…"
                          rows={2}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text placeholder:text-iv-muted/40 resize-none focus:outline-none focus:ring-1 focus:ring-iv-accent"
                        />
                        <div className="flex flex-wrap gap-2 justify-end">
                          <button onClick={() => setReviewingId(null)} className="px-3 py-1.5 rounded-lg text-xs text-iv-muted hover:bg-white/5 transition-colors">
                            Cancelar
                          </button>
                          <button
                            onClick={() => handleReview(sub.id, 'rejected')}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs transition-colors border border-red-500/20"
                          >
                            <ThumbsDown size={12} /> Reprovar
                          </button>
                          <button
                            onClick={() => handleReview(sub.id, 'approved')}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs transition-colors border border-emerald-500/20"
                          >
                            <ThumbsUp size={12} /> Aprovar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
    </PullToRefresh>
  );
}
