import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileBarChart2, Clock, Users, Trash2, ChevronDown, ChevronUp, Search, ArrowDownNarrowWide, ArrowUpNarrowWide, History, ArrowLeftRight, UserCog, Repeat, AlertTriangle, CheckCircle2, XCircle, Loader2, Download, Filter, X, Film, ThumbsUp, ThumbsDown, BookOpen, Calendar, Ban, RefreshCw, ClipboardCheck, Star } from 'lucide-react';
import { listReports, deleteReport } from '../../services/reports.service';
import type { LessonReport, LessonAssignmentHistory, Profile, LessonSwapRequest, Attendance, LessonEvaluation } from '../../types';
import { listByScheduledLesson } from '../../services/attendance.service';
import { reviewSubmission } from '../../services/makeup.service';
import type { MakeupSubmission, MakeupSubmissionStatus } from '../../types';
import type { Lesson } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import type { ScheduledLesson, Class } from '../../types';
import { useReportsData, useEvaluationsQuery } from '../../queries/useReportsQuery';
import { useQueryClient } from '@tanstack/react-query';
import EmptyState from '../ui/EmptyState';
import ConfirmModal from '../ui/ConfirmModal';
import Button from '../ui/Button';
import PageLoader from '../ui/PageLoader';
import PullToRefresh from '../ui/PullToRefresh';
import MakeupStatusBadge from '../ui/MakeupStatusBadge';

const PAGE_SIZE = 20;
// Threshold (minutes) to flag a student as "atrasado" in the report.
// Derived at render time from `attendance.joined_at - scheduled_lesson.started_at`.
// Since `recordAttendanceJoin` preserves the ORIGINAL joined_at across
// reconnects, a student who joined on time and just dropped mid-class will
// NOT be flagged late — only true late arrivals trigger this badge.
const LATE_THRESHOLD_MINUTES = 5;

type ReportsTab = 'aulas' | 'historico' | 'trocas' | 'reposicoes' | 'avaliacoes';

export default function ReportsView() {
  const { profile } = useAuth();
  const isCoord = profile?.role === 'coordenacao';
  const [activeTab, setActiveTab] = useState<ReportsTab>('aulas');

  // ── React Query — replaces load() + 11 useState + useEffect([]) ──────────
  const queryClient = useQueryClient();
  const {
    reports, scheduled, classes, lessonsById,
    profilesById, history, swaps, makeupSubs,
    justifiedRows, loading, refetch,
  } = useReportsData();

  // Evaluations: fetched only when the coord opens that tab
  const evalQuery = useEvaluationsQuery(isCoord && activeTab === 'avaliacoes');
  const evaluations = evalQuery.data ?? [];
  const loadingEvaluations = evalQuery.isLoading;

  const [evalProfFilter, setEvalProfFilter] = useState<string>('');
  const [evalClassFilter, setEvalClassFilter] = useState<string>('');
  // FJ rows with a future deadline — used by the "em risco" panel
  // Lessons map — used to show lesson topic on submission cards
  const [makeupFilter, setMakeupFilter] = useState<MakeupSubmissionStatus | ''>('');
  const [makeupClassFilter, setMakeupClassFilter] = useState('');
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  // Per-report attendance cache: report.id -> Attendance[]. Populated lazily
  // when the user expands a report card to avoid N+1 fetches on initial load.
  const [attendancesByReport, setAttendancesByReport] = useState<Record<string, Attendance[]>>({});
  const [loadingAttendance, setLoadingAttendance] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // Deep-link target: ?aula=<scheduled_lesson_id> auto-expands the matching
  // report and scrolls it into view (used by "Visualizar Relatório" buttons
  // in class details / calendar).
  const [searchParams, setSearchParams] = useSearchParams();
  const focusLessonId = searchParams.get('aula');
  const focusedRef = useRef<HTMLDivElement | null>(null);
  const didFocusRef = useRef(false);

  // Filters & pagination
  const [search, setSearch] = useState('');
  const [sortDesc, setSortDesc] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Pagination for the Reposições list (independent from the aulas list).
  const [makeupVisibleCount, setMakeupVisibleCount] = useState(PAGE_SIZE);
  // Advanced filters — persisted in URL so a link reproduces the same view.
  const [filterClassId, setFilterClassId] = useState<string>(searchParams.get('turma') ?? '');
  const [filterProfId, setFilterProfId] = useState<string>(searchParams.get('prof') ?? '');
  const [filterDateFrom, setFilterDateFrom] = useState<string>(searchParams.get('de') ?? '');
  const [filterDateTo, setFilterDateTo] = useState<string>(searchParams.get('ate') ?? '');
  const [filterProblemsOnly, setFilterProblemsOnly] = useState<boolean>(searchParams.get('problemas') === '1');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);

  // Auto-expand + scroll to the report referenced by ?aula=<lesson_id>.
  // Runs once after reports load, then clears the query param so refresh
  // doesn't re-trigger the scroll.
  useEffect(() => {
    if (didFocusRef.current || !focusLessonId || reports.length === 0) return;
    const target = reports.find((r) => r.scheduled_lesson_id === focusLessonId);
    if (!target) return;
    didFocusRef.current = true;
    setActiveTab('aulas');
    setExpanded(target.id);
    void ensureAttendanceLoaded(target);
    // Wait one frame for the DOM to render the expanded card.
    requestAnimationFrame(() => {
      focusedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // Clean URL so reload doesn't re-scroll.
    const next = new URLSearchParams(searchParams);
    next.delete('aula');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLessonId, reports, searchParams, setSearchParams]);

  function getClassName(report: LessonReport): string {
    if (!report.scheduled_lesson_id) return '—';
    const sl = scheduled.find((s) => s.id === report.scheduled_lesson_id);
    if (!sl) return '—';
    return classes.find((c) => c.id === sl.class_id)?.name ?? '—';
  }

  // Evaluations lazy-loading is now handled by useEvaluationsQuery above.
  // (Kept as comment for traceability)

  // Fetch attendance rows for a report on demand (when its card is expanded).
  // No-op if already cached or already in flight.
  async function ensureAttendanceLoaded(report: LessonReport) {
    if (!report.scheduled_lesson_id) return;
    if (attendancesByReport[report.id] || loadingAttendance[report.id]) return;
    setLoadingAttendance((prev) => ({ ...prev, [report.id]: true }));
    try {
      const rows = await listByScheduledLesson(report.scheduled_lesson_id);
      setAttendancesByReport((prev) => ({ ...prev, [report.id]: rows }));
    } catch (err) {
      console.error('[ReportsView] Failed to load attendance:', err);
      setAttendancesByReport((prev) => ({ ...prev, [report.id]: [] }));
    } finally {
      setLoadingAttendance((prev) => {
        const next = { ...prev };
        delete next[report.id];
        return next;
      });
    }
  }

  function handleToggleExpand(report: LessonReport) {
    const willOpen = expanded !== report.id;
    setExpanded(willOpen ? report.id : null);
    if (willOpen) void ensureAttendanceLoaded(report);
  }

  function formatHm(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatSeconds(sec: number | null | undefined): string {
    if (sec === null || sec === undefined || sec <= 0) return '—';
    const totalMin = Math.round(sec / 60);
    if (totalMin < 60) return `${totalMin}min`;
    return `${Math.floor(totalMin / 60)}h ${totalMin % 60}min`;
  }

  // CSV export of the per-student attendance table for a single report.
  // Columns chosen to match what coordination typically forwards to the
  // school secretariat: identifier, times, computed late delta, status, notes.
  function escapeCsv(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // Wrap in quotes if contains comma, quote, newline or semicolon.
    if (/[,";\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function exportReportCsv(report: LessonReport) {
    const sl = report.scheduled_lesson_id
      ? scheduled.find((s) => s.id === report.scheduled_lesson_id)
      : null;
    const lessonStartedAtMs = sl?.started_at ? Date.parse(sl.started_at) : NaN;
    const className = getClassName(report);
    const attendances = attendancesByReport[report.id] ?? [];

    // Build merged roster (same logic as the rendered table)
    const seen = new Set<string>();
    type Row = { studentId: string; name: string; email: string; attendance: Attendance | null };
    const rows: Row[] = [];
    for (const a of attendances) {
      const prof = profilesById[a.student_id];
      const name = prof?.full_name
        ?? report.participants.find((p) => p.userId === a.student_id)?.userName
        ?? `Aluno ${a.student_id.slice(0, 6)}…`;
      rows.push({ studentId: a.student_id, name, email: prof?.email ?? '', attendance: a });
      seen.add(a.student_id);
    }
    for (const p of report.participants) {
      if (seen.has(p.userId)) continue;
      const prof = profilesById[p.userId];
      rows.push({ studentId: p.userId, name: prof?.full_name ?? p.userName, email: prof?.email ?? '', attendance: null });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    const header = [
      'Aluno', 'Email', 'Entrou', 'Saiu', 'Permaneceu (min)',
      'Status', 'Verificações', 'Atraso (min)', 'Observação',
    ];
    const lines: string[] = [header.map(escapeCsv).join(',')];

    for (const r of rows) {
      const a = r.attendance;
      let lateMin = 0;
      if (Number.isFinite(lessonStartedAtMs) && a?.joined_at) {
        const delta = (Date.parse(a.joined_at) - lessonStartedAtMs) / 60000;
        if (delta >= LATE_THRESHOLD_MINUTES) lateMin = Math.round(delta);
      }
      const statusLabel = a?.status === 'present' ? 'Presente'
        : a?.status === 'absent' ? 'Ausente'
        : a?.status === 'justified' ? 'Justificada'
        : profilesById[r.studentId]?.role === 'monitor' ? 'Conectado'
        : 'Sem registro';
      const checks = a && a.total_checks > 0 ? `${a.verified_checks}/${a.total_checks}` : '';
      const durationMin = a?.duration_seconds && a.duration_seconds > 0
        ? Math.round(a.duration_seconds / 60)
        : '';
      lines.push([
        r.name, r.email, formatHm(a?.joined_at), formatHm(a?.left_at),
        durationMin, statusLabel, checks, lateMin || '', a?.notes ?? '',
      ].map(escapeCsv).join(','));
    }

    // Header rows with lesson metadata BEFORE the table
    const meta = [
      `# Relatório: ${report.title}`,
      `# Turma: ${className}`,
      `# Professor: ${report.professor_name}`,
      `# Data: ${new Date(report.started_at).toLocaleString('pt-BR')}`,
      `# Duração: ${report.duration_minutes} min`,
      '',
    ].join('\n');
    // BOM \uFEFF garante que Excel pt-BR abra acentos corretamente
    const csv = '\uFEFF' + meta + '\n' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeTitle = (report.title || 'aula').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    const dateStr = new Date(report.started_at).toISOString().slice(0, 10);
    link.href = url;
    link.download = `relatorio_${dateStr}_${safeTitle}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function formatDuration(minutes: number): string {
    if (minutes < 60) return `${minutes}min`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
  }

  async function handleDelete(id: string) {
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      await deleteReport(id);
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    });
    setConfirmOpen(true);
  }

  const totalLessons = reports.length;
  const totalParticipants = reports.reduce((sum, r) => sum + r.participants.length, 0);
  const avgDuration = reports.length > 0
    ? Math.round(reports.reduce((sum, r) => sum + r.duration_minutes, 0) / reports.length)
    : 0;
  const tabItems: Array<{ id: ReportsTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'aulas', label: 'Aulas', icon: <FileBarChart2 size={14} /> },
    { id: 'historico', label: 'Historico', icon: <History size={14} />, badge: history.length || undefined },
    ...(isCoord ? [{ id: 'trocas' as const, label: 'Trocas', icon: <Repeat size={14} />, badge: swaps.filter((s) => s.status === 'pending').length || undefined }] : []),
    ...(isCoord ? [{ id: 'reposicoes' as const, label: 'Reposições', icon: <Film size={14} />, badge: makeupSubs.filter((s) => s.status === 'submitted').length || undefined }] : []),
    ...(isCoord ? [{ id: 'avaliacoes' as const, label: 'Avaliações', icon: <ClipboardCheck size={14} />, badge: evaluations.length || undefined }] : []),
  ];

  // Filtered + sorted list
  const filteredReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromMs = filterDateFrom ? Date.parse(filterDateFrom + 'T00:00:00') : NaN;
    const toMs = filterDateTo ? Date.parse(filterDateTo + 'T23:59:59') : NaN;

    const filtered = reports.filter((r) => {
      // Text search
      if (q) {
        const className = getClassName(r).toLowerCase();
        const matches = (r.title ?? '').toLowerCase().includes(q)
          || (r.professor_name ?? '').toLowerCase().includes(q)
          || className.includes(q);
        if (!matches) return false;
      }
      // Class filter (resolved via scheduled_lessons)
      if (filterClassId) {
        const sl = r.scheduled_lesson_id
          ? scheduled.find((s) => s.id === r.scheduled_lesson_id)
          : null;
        if (!sl || sl.class_id !== filterClassId) return false;
      }
      // Professor filter
      if (filterProfId && r.professor_id !== filterProfId) return false;
      // Date range
      const ts = Date.parse(r.started_at);
      if (Number.isFinite(fromMs) && ts < fromMs) return false;
      if (Number.isFinite(toMs) && ts > toMs) return false;
      // Problems-only: requires attendance loaded for the report. Reports
      // without loaded attendance are kept (we cannot judge) to avoid
      // hiding rows the coordinator hasn't expanded yet.
      if (filterProblemsOnly) {
        const atts = attendancesByReport[r.id];
        if (atts && atts.length > 0) {
          const hasProblem = atts.some((a) =>
            a.status === 'absent'
            || (a.total_checks > 0 && a.verified_checks === 0)
            || (a.notes && a.notes.length > 0)
          );
          if (!hasProblem) return false;
        }
      }
      return true;
    });
    filtered.sort((a, b) => {
      const ta = new Date(a.started_at).getTime();
      const tb = new Date(b.started_at).getTime();
      return sortDesc ? tb - ta : ta - tb;
    });
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports, search, sortDesc, scheduled, classes, filterClassId, filterProfId, filterDateFrom, filterDateTo, filterProblemsOnly, attendancesByReport]);

  const visibleReports = filteredReports.slice(0, visibleCount);
  const remaining = Math.max(filteredReports.length - visibleReports.length, 0);

  // Reset pagination when filter/sort changes
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, sortDesc, filterClassId, filterProfId, filterDateFrom, filterDateTo, filterProblemsOnly]);
  // Reset makeup pagination when filters change.
  useEffect(() => { setMakeupVisibleCount(PAGE_SIZE); }, [makeupFilter, makeupClassFilter]);

  // Sync filters into URL (replace) so the page is shareable.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDelete = (key: string, val: string | boolean) => {
      const str = typeof val === 'boolean' ? (val ? '1' : '') : val;
      if (str) next.set(key, str); else next.delete(key);
    };
    setOrDelete('turma', filterClassId);
    setOrDelete('prof', filterProfId);
    setOrDelete('de', filterDateFrom);
    setOrDelete('ate', filterDateTo);
    setOrDelete('problemas', filterProblemsOnly);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterClassId, filterProfId, filterDateFrom, filterDateTo, filterProblemsOnly]);

  function clearAllFilters() {
    setFilterClassId('');
    setFilterProfId('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setFilterProblemsOnly(false);
    setSearch('');
  }

  const activeFilterCount = (filterClassId ? 1 : 0)
    + (filterProfId ? 1 : 0)
    + (filterDateFrom ? 1 : 0)
    + (filterDateTo ? 1 : 0)
    + (filterProblemsOnly ? 1 : 0);

  return (
    <PullToRefresh onRefresh={async () => { refetch(); }}>
    <div className="space-y-4 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
      <div className="glass-panel p-3 sm:p-4 space-y-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-iv-text leading-tight">Relatorios de Aulas</h2>
          <p className="text-xs sm:text-sm text-iv-muted mt-0.5">Historico de aulas realizadas e mudancas de professor</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Aulas</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{totalLessons}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Participantes</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{totalParticipants}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Duracao</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{avgDuration ? formatDuration(avgDuration) : '—'}</p>
          </div>
        </div>
      </div>

      <div className="glass-panel p-3 sm:p-4 space-y-3">
        <div className="sm:hidden">
          <label className="text-[11px] uppercase tracking-wide text-iv-muted">Secao</label>
          <select
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value as ReportsTab)}
            className="mt-1.5 w-full rounded-xl bg-iv-bg border border-white/10 text-iv-text text-sm px-3 py-2.5 focus:outline-none focus:border-iv-accent/50"
          >
            {tabItems.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="hidden sm:flex flex-wrap items-center gap-2">
          {tabItems.map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`inline-flex max-w-full items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors native-pressable border ${
                  active
                    ? 'text-iv-accent border-iv-accent/40 bg-iv-accent/10'
                    : 'text-iv-muted border-white/10 bg-white/[0.02] hover:text-iv-text hover:border-white/20'
                }`}
              >
                {t.icon} {t.label}
                {t.badge && t.badge > 0 && (
                  <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded-full ${t.id === 'trocas' ? 'bg-amber-500/15 text-amber-300' : 'bg-iv-accent/15 text-iv-accent'}`}>
                    {t.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'historico' ? (
        loading ? (
          <PageLoader variant="list" rows={3} />
        ) : history.length === 0 ? (
          <EmptyState
            icon={<History size={32} />}
            title="Nenhuma alteração registrada"
            description="Substituições, cancelamentos e reagendamentos aparecem aqui automaticamente."
          />
        ) : (
          <div className="space-y-2">
            {history.map((h) => {
              const sl = scheduled.find((s) => s.id === h.scheduled_lesson_id);
              const cl = sl ? classes.find((c) => c.id === sl.class_id) : null;
              const prevName  = h.previous_professor_id ? (profilesById[h.previous_professor_id]?.full_name ?? '\u2014') : null;
              const newName   = h.new_professor_id      ? (profilesById[h.new_professor_id]?.full_name  ?? '\u2014') : null;
              const changedBy = h.changed_by ? (profilesById[h.changed_by]?.full_name ?? '\u2014') : 'Sistema';
              type Kind = 'substitution' | 'swap' | 'cancellation' | 'reinstatement' | 'reschedule';
              const kind = (h.kind ?? 'substitution') as Kind;
              const kindMeta: Record<Kind, { label: string; color: string; icon: React.ReactNode }> = {
                substitution:  { label: 'Substituição',  color: 'bg-amber-500/15 text-amber-300 border-amber-500/25',      icon: <UserCog size={10} /> },
                swap:          { label: 'Troca',         color: 'bg-blue-500/15 text-blue-300 border-blue-500/25',          icon: <ArrowLeftRight size={10} /> },
                cancellation:  { label: 'Cancelamento',  color: 'bg-red-500/15 text-red-300 border-red-500/25',             icon: <Ban size={10} /> },
                reinstatement: { label: 'Reativação',    color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25', icon: <RefreshCw size={10} /> },
                reschedule:    { label: 'Reagendamento', color: 'bg-purple-500/15 text-purple-300 border-purple-500/25',    icon: <Calendar size={10} /> },
              };
              const meta = kindMeta[kind] ?? kindMeta.substitution;
              return (
                <div key={h.id} className="glass-panel p-3 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${meta.color}`}>
                      {meta.icon}
                      {meta.label}
                    </span>
                    <span className="text-xs text-iv-muted">
                      {new Date(h.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {(kind === 'substitution' || kind === 'swap') && (
                    <p className="text-sm text-iv-text">
                      <span className="text-iv-muted">{prevName ?? '(sem professor)'}</span>
                      <span className="mx-1.5 text-iv-muted/60">→</span>
                      <span className="font-medium">{newName ?? '(sem professor)'}</span>
                    </p>
                  )}
                  {(kind === 'cancellation' || kind === 'reinstatement' || kind === 'reschedule') && h.reason && (
                    <p className="text-sm text-iv-text font-medium">{h.reason}</p>
                  )}
                  <p className="text-[11px] text-iv-muted">
                    {cl?.name ?? 'Turma desconhecida'}
                    {sl ? ` · ${new Date(sl.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                    <span className="opacity-60"> · por {changedBy}</span>
                  </p>
                </div>
              );
            })}
          </div>
        )
      ) : activeTab === 'trocas' ? (
        loading ? (
          <PageLoader variant="list" rows={3} />
        ) : swaps.length === 0 ? (
          <EmptyState
            icon={<Repeat size={32} />}
            title="Nenhuma troca registrada"
            description="Quando professores solicitarem trocas de aulas, todas aparecerão aqui."
          />
        ) : (
          <div className="space-y-2">
            {(() => {
              const filtered = [...swaps].sort((a, b) => b.created_at.localeCompare(a.created_at));
              const pendingCount = filtered.filter((s) => s.status === 'pending').length;
              const acceptedCount = filtered.filter((s) => s.status === 'accepted').length;
              const rejectedCount = filtered.filter((s) => s.status === 'rejected').length;
              const cancelledCount = filtered.filter((s) => s.status === 'cancelled' || s.status === 'expired').length;
              return (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    <div className="glass-panel p-3">
                      <p className="text-[10px] text-iv-muted uppercase tracking-wide">Pendentes</p>
                      <p className="text-lg font-bold text-amber-300">{pendingCount}</p>
                    </div>
                    <div className="glass-panel p-3">
                      <p className="text-[10px] text-iv-muted uppercase tracking-wide">Aceitas</p>
                      <p className="text-lg font-bold text-emerald-400">{acceptedCount}</p>
                    </div>
                    <div className="glass-panel p-3">
                      <p className="text-[10px] text-iv-muted uppercase tracking-wide">Recusadas</p>
                      <p className="text-lg font-bold text-red-400">{rejectedCount}</p>
                    </div>
                    <div className="glass-panel p-3">
                      <p className="text-[10px] text-iv-muted uppercase tracking-wide">Canceladas</p>
                      <p className="text-lg font-bold text-iv-muted">{cancelledCount}</p>
                    </div>
                  </div>
                  {filtered.map((s) => {
                    const sl = scheduled.find((x) => x.id === s.scheduled_lesson_id);
                    const cl = sl ? classes.find((c) => c.id === sl.class_id) : null;
                    const requesterName = profilesById[s.requester_id]?.full_name ?? '—';
                    const targetName = profilesById[s.target_id]?.full_name ?? '—';
                    const offeredSl = s.offered_lesson_id ? scheduled.find((x) => x.id === s.offered_lesson_id) : null;
                    const offeredCls = offeredSl ? classes.find((c) => c.id === offeredSl.class_id) : null;
                    const statusBadge: Record<typeof s.status, string> = {
                      pending: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
                      accepted: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
                      rejected: 'bg-red-500/15 text-red-400 border-red-500/25',
                      cancelled: 'bg-iv-muted/10 text-iv-muted border-white/10',
                      expired: 'bg-iv-muted/10 text-iv-muted border-white/10',
                    };
                    const statusLabel: Record<typeof s.status, string> = {
                      pending: 'Pendente',
                      accepted: 'Aceita',
                      rejected: 'Recusada',
                      cancelled: 'Cancelada',
                      expired: 'Expirada',
                    };
                    return (
                      <div key={s.id} className="glass-panel p-3 space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${statusBadge[s.status]}`}>
                            {statusLabel[s.status]}
                          </span>
                          <span className="text-xs text-iv-muted">
                            {new Date(s.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {s.responded_at && (
                            <span className="text-[10px] text-iv-muted opacity-70">
                              · respondida {new Date(s.responded_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-iv-text">
                          <span className="font-medium">{requesterName}</span>
                          <span className="mx-1.5 text-iv-muted/60">→</span>
                          <span className="font-medium">{targetName}</span>
                        </p>
                        <p className="text-[11px] text-iv-muted">
                          {cl?.name ?? 'Turma'}
                          {sl ? ` · ${new Date(sl.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                        </p>
                        {offeredSl && (
                          <p className="text-[11px] text-iv-muted">
                            <span className="opacity-70">Em troca: </span>
                            {offeredCls?.name ?? 'Turma'} · {new Date(offeredSl.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </p>
                        )}
                        {s.message && <p className="text-[11px] text-iv-muted italic">“{s.message}”</p>}
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        )
      ) : activeTab === 'reposicoes' ? (
        /* ── Reposições panel ─────────────────────────────────────────── */
        loading ? (
          <PageLoader variant="list" rows={3} />
        ) : (
          <div className="space-y-3">
            {/* Refresh hint moved to the TOP so coord sees it before scrolling. */}
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/25 text-[11px] text-blue-300">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              Esta lista não atualiza em tempo real. Puxe a tela para baixo para sincronizar com novas submissões.
            </div>

            {/* ── Em risco: alunos com FJ + prazo se aproximando ─────────── */}
            {(() => {
              // Build the "em risco" list:
              //  - all FJ rows with a deadline
              //  - that DON'T already have an accepted submission (submitted | approved)
              //  - sorted by deadline ascending (most urgent first)
              const acceptedKeys = new Set(
                makeupSubs
                  .filter((s) => s.status === 'submitted' || s.status === 'approved')
                  .map((s) => `${s.scheduled_lesson_id}|${s.student_id}`),
              );
              const pending = justifiedRows
                .filter((a) => a.makeup_deadline)
                .filter((a) => !acceptedKeys.has(`${a.scheduled_lesson_id}|${a.student_id}`));

              const now = Date.now();
              const overdue   = pending.filter((a) => new Date(a.makeup_deadline!).getTime() <  now);
              const next48h   = pending.filter((a) => {
                const t = new Date(a.makeup_deadline!).getTime();
                return t >= now && t < now + 48 * 3_600_000;
              });
              const future    = pending.filter((a) => new Date(a.makeup_deadline!).getTime() >= now + 48 * 3_600_000);

              if (pending.length === 0) return null;

              const renderItem = (a: Attendance, kind: 'overdue' | 'soon' | 'future') => {
                const studentName = profilesById[a.student_id]?.full_name ?? a.student_id.slice(0, 8) + '…';
                const sl = scheduled.find((x) => x.id === a.scheduled_lesson_id);
                const cl = sl ? classes.find((c) => c.id === sl.class_id) : null;
                const ms = new Date(a.makeup_deadline!).getTime() - now;
                const hours = Math.floor(Math.abs(ms) / 3_600_000);
                const days  = Math.floor(hours / 24);
                const rel   = ms < 0
                  ? `vencido há ${days >= 1 ? `${days}d` : `${hours}h`}`
                  : hours < 24
                    ? `${hours}h restantes`
                    : `${days} ${days === 1 ? 'dia' : 'dias'}`;
                const palette = kind === 'overdue'
                  ? 'border-red-500/40 bg-red-500/15'
                  : kind === 'soon'
                    ? 'border-amber-500/40 bg-amber-500/15'
                    : 'border-blue-500/30 bg-blue-500/10';
                const labelColor = kind === 'overdue' ? 'text-red-300' : kind === 'soon' ? 'text-amber-300' : 'text-blue-300';
                return (
                  <div key={a.id} className={`p-2.5 rounded-lg border ${palette} flex items-center gap-2 flex-wrap`}>
                    <span className="text-sm font-medium text-iv-text">{studentName}</span>
                    {cl && <span className="text-xs text-iv-muted">· {cl.name}</span>}
                    {sl && (
                      <span className="text-xs text-iv-muted">
                        · aula de {new Date(sl.scheduled_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                      </span>
                    )}
                    <span className={`ml-auto text-xs font-semibold ${labelColor}`}>{rel}</span>
                  </div>
                );
              };

              return (
                <div className="glass-panel p-4 border border-white/10 space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-amber-400" />
                    <h3 className="text-sm font-semibold text-iv-text">FJ em acompanhamento</h3>
                    <span className="text-xs text-iv-muted">
                      {pending.length} {pending.length === 1 ? 'aluno pendente' : 'alunos pendentes'}
                    </span>
                  </div>

                  {overdue.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] uppercase tracking-wide text-red-400/80 font-semibold">
                        Vencidos ({overdue.length}) — viram falta no próximo ciclo diário
                      </p>
                      {overdue.map((a) => renderItem(a, 'overdue'))}
                    </div>
                  )}

                  {next48h.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] uppercase tracking-wide text-amber-400/80 font-semibold">
                        Vencem em até 48h ({next48h.length})
                      </p>
                      {next48h.map((a) => renderItem(a, 'soon'))}
                    </div>
                  )}

                  {future.length > 0 && (
                    <details className="group">
                      <summary className="text-[11px] uppercase tracking-wide text-blue-400/80 font-semibold cursor-pointer select-none">
                        Demais pendentes ({future.length})
                      </summary>
                      <div className="space-y-1.5 mt-2">
                        {future.slice(0, 20).map((a) => renderItem(a, 'future'))}
                        {future.length > 20 && (
                          <p className="text-[11px] text-iv-muted italic px-1">
                            + {future.length - 20} {future.length - 20 === 1 ? 'aluno' : 'alunos'} com prazos mais distantes (use os filtros abaixo para refinar)
                          </p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              );
            })()}

            {/* Refresh hint — makeup_submissions não tem realtime; coord precisa puxar para atualizar */}
            {/* (banner movido para o topo da aba) */}

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={makeupClassFilter}
                onChange={(e) => setMakeupClassFilter(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
              >
                <option value="">Todas as turmas</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select
                value={makeupFilter}
                onChange={(e) => setMakeupFilter(e.target.value as MakeupSubmissionStatus | '')}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
              >
                <option value="">Todos os status</option>
                <option value="pending">Pendente</option>
                <option value="submitted">Aguardando revisão</option>
                <option value="approved">Aprovado</option>
                <option value="rejected">Reprovado</option>
              </select>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['pending', 'submitted', 'approved', 'rejected'] as const).map((s) => {
                const count = makeupSubs.filter((x) => x.status === s).length;
                const colors: Record<string, string> = {
                  pending:   'text-iv-muted',
                  submitted: 'text-blue-400',
                  approved:  'text-emerald-400',
                  rejected:  'text-red-400',
                };
                const labels: Record<string, string> = {
                  pending:   'Pendentes',
                  submitted: 'Para revisar',
                  approved:  'Aprovados',
                  rejected:  'Reprovados',
                };
                return (
                  <div key={s} className="glass-panel p-3 text-center">
                    <p className="text-[10px] text-iv-muted uppercase tracking-wide">{labels[s]}</p>
                    <p className={`text-lg font-bold ${colors[s]}`}>{count}</p>
                  </div>
                );
              })}
            </div>

            {/* List */}
            {(() => {
              const filtered = makeupSubs.filter((s) => {
                if (makeupFilter && s.status !== makeupFilter) return false;
                if (makeupClassFilter && s.class_id !== makeupClassFilter) return false;
                return true;
              });
              if (filtered.length === 0)
                return (
                  <EmptyState
                    icon={<Film size={32} />}
                    title="Nenhuma reposição"
                    description="Reposições enviadas pelos alunos aparecerão aqui."
                  />
                );
              const visibleSubs = filtered.slice(0, makeupVisibleCount);
              const remaining   = filtered.length - visibleSubs.length;
              return (
                <>
                  {visibleSubs.map((sub) => {
                const studentName = profilesById[sub.student_id]?.full_name ?? sub.student_id.slice(0, 8) + '…';
                const cls = sub.class_id ? classes.find((c) => c.id === sub.class_id) : null;
                const slForSub = sub.scheduled_lesson_id ? scheduled.find((s) => s.id === sub.scheduled_lesson_id) : null;
                const lessonForSub = slForSub?.lesson_id ? lessonsById[slForSub.lesson_id] : null;
                const isReviewing = reviewingId === sub.id;
                return (
                  <div key={sub.id} className="glass-panel p-4 space-y-2.5 border border-white/8">
                    {lessonForSub && (
                      <div className="flex items-center gap-1.5 pb-0.5 border-b border-white/5">
                        <BookOpen size={11} className="text-iv-accent shrink-0" />
                        <p className="text-xs font-semibold text-iv-accent truncate">{lessonForSub.title}</p>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <MakeupStatusBadge status={sub.status} watched={!!sub.watched_at} variant="pill" />
                        <span className="text-sm font-semibold text-iv-text">{studentName}</span>
                        {cls && <span className="text-xs text-iv-muted">{cls.name}</span>}
                      </div>
                      <div className="flex gap-1.5 text-[11px] text-iv-muted">
                        {sub.watched_at && <span>Assistiu: {new Date(sub.watched_at).toLocaleString('pt-BR', { day:'2-digit', month:'short' })}</span>}
                        {sub.submitted_at && <span>· Enviou: {new Date(sub.submitted_at).toLocaleString('pt-BR', { day:'2-digit', month:'short' })}</span>}
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

                    {/* Coord actions */}
                    {isCoord && sub.status === 'submitted' && !isReviewing && (
                      <div className="flex gap-2 mt-4 pt-4 border-t border-white/5">
                        <button
                          onClick={() => { setReviewingId(sub.id); setReviewNotes(''); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-iv-muted transition-colors border border-white/10"
                        >
                          Revisar
                        </button>
                      </div>
                    )}

                    {isReviewing && (
                      <div className="space-y-2 pt-1">
                        <textarea
                          value={reviewNotes}
                          onChange={(e) => setReviewNotes(e.target.value)}
                          placeholder="Feedback para o aluno (opcional)…"
                          rows={2}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text placeholder:text-iv-muted/40 resize-none focus:outline-none focus:ring-1 focus:ring-iv-accent"
                        />
                        <div className="flex flex-wrap gap-2 justify-end">
                          <button
                            onClick={() => setReviewingId(null)}
                            className="px-3 py-1.5 rounded-lg text-xs text-iv-muted hover:bg-white/5 transition-colors"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={async () => {
                              if (!profile?.id) return;
                              try {
                                await reviewSubmission(sub.id, 'rejected', profile.id, reviewNotes || undefined);
                                void queryClient.invalidateQueries({ queryKey: ['makeup-subs'] });
                                setReviewingId(null);
                              } catch (e) { console.error(e); }
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs transition-colors border border-red-500/20"
                          >
                            <ThumbsDown size={12} /> Reprovar
                          </button>
                          <button
                            onClick={async () => {
                              if (!profile?.id) return;
                              try {
                                await reviewSubmission(sub.id, 'approved', profile.id, reviewNotes || undefined);
                                void queryClient.invalidateQueries({ queryKey: ['makeup-subs'] });
                                setReviewingId(null);
                              } catch (e) { console.error(e); }
                            }}
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
              {remaining > 0 && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={() => setMakeupVisibleCount((n) => n + PAGE_SIZE)}
                    className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm text-iv-text transition-colors"
                  >
                    Carregar mais ({remaining} restantes)
                  </button>
                </div>
              )}
                </>
              );
            })()}
          </div>
        )
      ) : activeTab === 'avaliacoes' ? (
        <EvaluationsPanel
          loading={loadingEvaluations}
          evaluations={evaluations}
          scheduled={scheduled}
          classes={classes}
          profilesById={profilesById}
          profFilter={evalProfFilter}
          setProfFilter={setEvalProfFilter}
          classFilter={evalClassFilter}
          setClassFilter={setEvalClassFilter}
        />
      ) : (
      <>
      {loading ? (
        <PageLoader variant="list" rows={3} />
      ) : reports.length === 0 ? (
        <EmptyState
          icon={<FileBarChart2 size={32} />}
          title="Nenhuma aula registrada"
          description="Os relatórios aparecem aqui quando o anfitrião encerra a sala."
        />
      ) : (
        <>
          {/* Search + sort controls */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-iv-muted pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por aula, professor ou turma..."
                className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-3 py-2.5 text-sm text-iv-text placeholder:text-iv-muted/60 focus:outline-none focus:border-iv-accent/50"
                aria-label="Buscar relatórios"
                inputMode="search"
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Filter size={14} />}
              onClick={() => setFiltersOpen((v) => !v)}
              className="justify-center relative"
            >
              Filtros
              {activeFilterCount > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-iv-accent text-iv-bg text-[10px] font-bold">
                  {activeFilterCount}
                </span>
              )}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={sortDesc ? <ArrowDownNarrowWide size={14} /> : <ArrowUpNarrowWide size={14} />}
              onClick={() => setSortDesc((v) => !v)}
              className="justify-center"
            >
              {sortDesc ? 'Mais recentes' : 'Mais antigos'}
            </Button>
          </div>

          {/* Collapsible filter panel */}
          {filtersOpen && (
            <div className="glass-panel rounded-xl p-3 sm:p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-iv-muted uppercase tracking-wider mb-1">Turma</label>
                  <select
                    value={filterClassId}
                    onChange={(e) => setFilterClassId(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
                  >
                    <option value="">Todas</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-iv-muted uppercase tracking-wider mb-1">Professor</label>
                  <select
                    value={filterProfId}
                    onChange={(e) => setFilterProfId(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
                  >
                    <option value="">Todos</option>
                    {Object.values(profilesById)
                      .filter((p) => p.role === 'professor')
                      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'pt-BR'))
                      .map((p) => (
                        <option key={p.id} value={p.id}>{p.full_name}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-iv-muted uppercase tracking-wider mb-1">De</label>
                  <input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-iv-muted uppercase tracking-wider mb-1">Até</label>
                  <input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <label className="flex items-center gap-2 text-xs text-iv-text cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={filterProblemsOnly}
                    onChange={(e) => setFilterProblemsOnly(e.target.checked)}
                    className="w-4 h-4 rounded border-white/20 bg-white/5 text-iv-accent focus:ring-iv-accent/40"
                  />
                  <AlertTriangle size={12} className="text-amber-400" />
                  <span>Só aulas com ausências automáticas ou observações</span>
                  <span className="text-iv-muted/60 text-[10px]">(requer expandir card antes)</span>
                </label>
                {activeFilterCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<X size={12} />}
                    onClick={clearAllFilters}
                    className="!text-iv-muted hover:!text-iv-text"
                  >
                    Limpar filtros
                  </Button>
                )}
              </div>
            </div>
          )}

          {filteredReports.length === 0 ? (
            <EmptyState
              icon={<Search size={32} />}
              title="Nenhum resultado"
              description="Ajuste os termos de busca para encontrar relatórios."
            />
          ) : (
            <>
              <p className="text-xs text-iv-muted">
                Mostrando {visibleReports.length} de {filteredReports.length} {filteredReports.length === 1 ? 'relatório' : 'relatórios'}
              </p>
              <div className="space-y-3">
                {visibleReports.map((report) => {
            const isOpen = expanded === report.id;
            const isFocused = focusLessonId === report.scheduled_lesson_id;
            const start = new Date(report.started_at);
            const end = new Date(report.ended_at);

            return (
              <div
                key={report.id}
                ref={isFocused ? focusedRef : undefined}
                className={`glass-panel overflow-hidden ${isFocused ? 'ring-2 ring-iv-accent/60' : ''}`}
              >
                {/* Header row */}
                <button
                  onClick={() => handleToggleExpand(report)}
                  className="w-full flex items-center gap-4 p-4 text-left hover:bg-white/5 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-2">
                       <h3 className="text-base font-medium text-iv-accent">{report.title || 'Aula sem título'}</h3>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-iv-text">
                        {start.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </span>
                      <span className="text-xs text-iv-muted">
                        {start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} –{' '}
                        {end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-iv-accent/15 text-iv-accent border border-iv-accent/20">
                        {formatDuration(report.duration_minutes)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-iv-muted">
                      <span>Turma: <span className="text-iv-text">{getClassName(report)}</span></span>
                      <span>Professor: <span className="text-iv-text">{report.professor_name}</span></span>
                      <span className="flex items-center gap-1"><Users size={11} /> {report.participants.length}</span>
                    </div>
                  </div>
                  {isOpen ? <ChevronUp size={16} className="text-iv-muted shrink-0" /> : <ChevronDown size={16} className="text-iv-muted shrink-0" />}
                </button>

                {/* Expanded participants */}
                {isOpen && (() => {
                  const sl = report.scheduled_lesson_id
                    ? scheduled.find((s) => s.id === report.scheduled_lesson_id)
                    : null;
                  const lessonStartedAtMs = sl?.started_at ? Date.parse(sl.started_at) : NaN;
                  const attendances = attendancesByReport[report.id];
                  const isLoadingAtt = !!loadingAttendance[report.id];
                  // Build merged roster: union of attendance rows + participant
                  // snapshot. Attendance rows take precedence (richer data);
                  // participants snapshot fills in students who appeared in the
                  // room but never got an attendance row written (edge case).
                  type Row = {
                    studentId: string;
                    name: string;
                    attendance: Attendance | null;
                    inSnapshot: boolean;
                  };
                  const rows: Row[] = [];
                  const seen = new Set<string>();
                  if (attendances) {
                    for (const a of attendances) {
                      const name = profilesById[a.student_id]?.full_name
                        ?? report.participants.find((p) => p.userId === a.student_id)?.userName
                        ?? `Aluno ${a.student_id.slice(0, 6)}…`;
                      rows.push({
                        studentId: a.student_id,
                        name,
                        attendance: a,
                        inSnapshot: report.participants.some((p) => p.userId === a.student_id),
                      });
                      seen.add(a.student_id);
                    }
                  }
                  for (const p of report.participants) {
                    if (seen.has(p.userId)) continue;
                    rows.push({
                      studentId: p.userId,
                      name: profilesById[p.userId]?.full_name ?? p.userName,
                      attendance: null,
                      inSnapshot: true,
                    });
                  }
                  rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

                  // Aggregate counters for the header strip
                  const countPresent = rows.filter((r) => r.attendance?.status === 'present').length;
                  const countAbsent = rows.filter((r) => r.attendance?.status === 'absent').length;
                  const countJustified = rows.filter((r) => r.attendance?.status === 'justified').length;
                  const countLate = rows.filter((r) => {
                    if (!Number.isFinite(lessonStartedAtMs) || !r.attendance?.joined_at) return false;
                    const lateMin = (Date.parse(r.attendance.joined_at) - lessonStartedAtMs) / 60000;
                    return lateMin >= LATE_THRESHOLD_MINUTES;
                  }).length;

                  return (
                  <div className="border-t border-white/5 px-4 pb-4 pt-3 space-y-3 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-xs font-semibold text-iv-muted uppercase tracking-wider">
                        Participantes ({rows.length})
                      </p>
                      <div className="flex items-center gap-2 flex-wrap text-[11px]">
                        {countPresent > 0 && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
                            <CheckCircle2 size={11} /> {countPresent} presente{countPresent !== 1 ? 's' : ''}
                          </span>
                        )}
                        {countAbsent > 0 && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/20">
                            <XCircle size={11} /> {countAbsent} ausente{countAbsent !== 1 ? 's' : ''}
                          </span>
                        )}
                        {countJustified > 0 && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/20">
                            {countJustified} justificada{countJustified !== 1 ? 's' : ''}
                          </span>
                        )}
                        {countLate > 0 && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
                            <Clock size={11} /> {countLate} atrasado{countLate !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    {isLoadingAtt && (
                      <div className="flex items-center gap-2 text-xs text-iv-muted">
                        <Loader2 size={12} className="animate-spin" /> Carregando detalhes de presença…
                      </div>
                    )}

                    {!isLoadingAtt && rows.length === 0 && (
                      <p className="text-xs text-iv-muted/60">Nenhum participante registrado.</p>
                    )}

                    {!isLoadingAtt && rows.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs table-fixed sm:table-auto">
                          <thead>
                            <tr className="text-left text-iv-muted border-b border-white/5">
                              <th className="py-1.5 pr-2 font-medium">Aluno</th>
                              <th className="py-1.5 px-2 font-medium whitespace-nowrap">Entrou</th>
                              <th className="py-1.5 px-2 font-medium whitespace-nowrap hidden sm:table-cell">Saiu</th>
                              <th className="py-1.5 px-2 font-medium whitespace-nowrap">Permaneceu</th>
                              <th className="py-1.5 px-2 font-medium">Status</th>
                              <th className="py-1.5 px-2 font-medium hidden md:table-cell">Verificações</th>
                              <th className="py-1.5 pl-2 font-medium hidden md:table-cell">Observação</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => {
                              const a = r.attendance;
                              // Late = first joined_at AFTER lesson started by
                              // more than the threshold. `joined_at` is preserved
                              // as the FIRST entry (recordAttendanceJoin keeps
                              // existing value), so reconnects don't trigger this.
                              let lateMin = 0;
                              if (Number.isFinite(lessonStartedAtMs) && a?.joined_at) {
                                const delta = (Date.parse(a.joined_at) - lessonStartedAtMs) / 60000;
                                if (delta >= LATE_THRESHOLD_MINUTES) lateMin = Math.round(delta);
                              }
                              // Monitors don't get attendance rows written (they're not students),
                              // so a monitor in the participants snapshot shows as "Conectado".
                              const isMonitor = profilesById[r.studentId]?.role === 'monitor';
                              const isConnectedMonitor = isMonitor && r.inSnapshot && !a;
                              const statusBadgeClass = a?.status === 'present'
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
                                : a?.status === 'absent'
                                  ? 'bg-red-500/15 text-red-300 border-red-500/20'
                                  : a?.status === 'justified'
                                    ? 'bg-blue-500/15 text-blue-300 border-blue-500/20'
                                    : isConnectedMonitor
                                      ? 'bg-teal-500/15 text-teal-300 border-teal-500/20'
                                      : 'bg-white/5 text-iv-muted border-white/10';
                              const statusLabel = a?.status === 'present'
                                ? 'Presente'
                                : a?.status === 'absent'
                                  ? 'Ausente'
                                  : a?.status === 'justified'
                                    ? 'Justificada'
                                    : isConnectedMonitor
                                      ? 'Conectado'
                                      : 'Sem registro';
                              const checksLabel = a && a.total_checks > 0
                                ? `${a.verified_checks}/${a.total_checks}`
                                : '—';
                              return (
                                <tr key={r.studentId} className="border-b border-white/5 last:border-0 align-top">
                                  <td className="py-2 pr-2 min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="w-6 h-6 rounded-full bg-iv-accent/20 text-iv-accent text-[10px] font-bold flex items-center justify-center shrink-0">
                                        {r.name.charAt(0).toUpperCase()}
                                      </span>
                                      <span className="text-iv-text truncate min-w-0">{r.name}</span>
                                    </div>
                                    {/* Mobile-only secondary info: Saiu / Verificações / Observação stacked under name */}
                                    <div className="sm:hidden mt-1 ml-8 flex flex-col gap-0.5 text-[10px] text-iv-muted">
                                      {a?.left_at && (
                                        <span>Saiu: {formatHm(a.left_at)}</span>
                                      )}
                                      {a && a.total_checks > 0 && (
                                        <span>Verificações: {checksLabel}</span>
                                      )}
                                      {a?.notes && (
                                        <span className="flex items-start gap-1 text-amber-300/80">
                                          <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                                          <span className="leading-snug">{a.notes}</span>
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-2 px-2 text-iv-muted whitespace-nowrap">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span>{formatHm(a?.joined_at)}</span>
                                      {lateMin > 0 && (
                                        <span
                                          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20"
                                          title={`Entrou ${lateMin} min após o início formal da aula.`}
                                        >
                                          <Clock size={9} /> +{lateMin}min
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-2 px-2 text-iv-muted whitespace-nowrap hidden sm:table-cell">{formatHm(a?.left_at)}</td>
                                  <td className="py-2 px-2 text-iv-text whitespace-nowrap">{formatSeconds(a?.duration_seconds ?? null)}</td>
                                  <td className="py-2 px-2 whitespace-nowrap">
                                    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${statusBadgeClass}`}>
                                      {statusLabel}
                                    </span>
                                  </td>
                                  <td className="py-2 px-2 text-iv-muted whitespace-nowrap hidden md:table-cell">{checksLabel}</td>
                                  <td className="py-2 pl-2 text-iv-muted hidden md:table-cell">
                                    {a?.notes ? (
                                      <span className="flex items-start gap-1">
                                        <AlertTriangle size={11} className="text-amber-400 shrink-0 mt-0.5" />
                                        <span className="text-[11px] leading-snug">{a.notes}</span>
                                      </span>
                                    ) : (
                                      <span className="text-iv-muted/50">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Download size={14} />}
                        onClick={() => exportReportCsv(report)}
                        haptic="success"
                      >
                        Exportar CSV
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Trash2 size={14} />}
                        onClick={() => handleDelete(report.id)}
                        haptic="error"
                        className="!text-red-400 hover:!text-red-300"
                      >
                        Excluir relatório
                      </Button>
                    </div>
                  </div>
                  );
                })()}
              </div>
            );
          })}
              </div>
              {remaining > 0 && (
                <div className="pt-2">
                  <Button
                    variant="secondary"
                    fullWidth
                    onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  >
                    Carregar mais ({remaining} restantes)
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => confirmAction?.()}
        title="Excluir Relatório"
        message="Excluir este relatório? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />
      </>
      )}
    </div>
    </PullToRefresh>
  );
}

// ── EvaluationsPanel (coord-only) ────────────────────────────────────────────
//
// Renders the confidential post-lesson evaluations (lesson_evaluations) in
// two parts: aggregated mean scores per evaluated professor (computed from
// the joined scheduled_lesson → professor_id) and a chronological list of
// individual entries. Filters by professor and class are applied client-side
// — RLS already restricts the dataset to coordenação on the server.

interface EvaluationsPanelProps {
  loading: boolean;
  evaluations: LessonEvaluation[];
  scheduled: ScheduledLesson[];
  classes: Class[];
  profilesById: Record<string, Profile>;
  profFilter: string;
  setProfFilter: (v: string) => void;
  classFilter: string;
  setClassFilter: (v: string) => void;
}

function EvaluationsPanel({
  loading, evaluations, scheduled, classes, profilesById,
  profFilter, setProfFilter, classFilter, setClassFilter,
}: EvaluationsPanelProps) {
  // Resolve professor for each evaluation via the scheduled lesson it
  // references. Memoized lookup keeps the table cheap when filters change.
  const enriched = useMemo(() => evaluations.map((ev) => {
    const sl = scheduled.find((s) => s.id === ev.scheduled_lesson_id);
    const cls = classes.find((c) => c.id === ev.class_id);
    const prof = sl?.professor_id ? profilesById[sl.professor_id] : null;
    const monitor = profilesById[ev.monitor_id];
    return { ev, sl, cls, prof, monitor };
  }), [evaluations, scheduled, classes, profilesById]);

  const filtered = useMemo(() => enriched.filter(({ ev, prof }) => {
    if (profFilter && prof?.id !== profFilter) return false;
    if (classFilter && ev.class_id !== classFilter) return false;
    return true;
  }), [enriched, profFilter, classFilter]);

  // Aggregate by professor → averages of the three scores + count.
  const aggregates = useMemo(() => {
    const map = new Map<string, { profName: string; count: number; content: number; dynamics: number; engagement: number }>();
    for (const { ev, prof } of filtered) {
      const key = prof?.id ?? '__unknown__';
      const cur = map.get(key) ?? { profName: prof?.full_name ?? '— sem professor —', count: 0, content: 0, dynamics: 0, engagement: 0 };
      cur.count += 1;
      cur.content    += ev.content_score;
      cur.dynamics   += ev.dynamics_score;
      cur.engagement += ev.engagement_score;
      map.set(key, cur);
    }
    return Array.from(map.values())
      .map((r) => ({
        ...r,
        avgContent:    r.content / r.count,
        avgDynamics:   r.dynamics / r.count,
        avgEngagement: r.engagement / r.count,
        avgOverall:    (r.content + r.dynamics + r.engagement) / (r.count * 3),
      }))
      .sort((a, b) => b.avgOverall - a.avgOverall);
  }, [filtered]);

  // Unique professors / classes referenced by any evaluation — used for the
  // filter dropdowns so we never offer an option that returns no rows.
  const profOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const { prof } of enriched) {
      if (prof) set.set(prof.id, prof.full_name);
    }
    return Array.from(set.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [enriched]);

  const classOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const { ev, cls } of enriched) {
      if (cls) set.set(ev.class_id, cls.name);
    }
    return Array.from(set.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [enriched]);

  if (loading) return <PageLoader variant="list" rows={3} />;

  if (evaluations.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardCheck size={32} />}
        title="Nenhuma avaliação enviada"
        description="As avaliações confidenciais dos monitores aparecerão aqui."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={profFilter}
          onChange={(e) => setProfFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
          aria-label="Filtrar por professor"
        >
          <option value="">Todos os professores</option>
          {profOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-iv-text focus:outline-none focus:border-iv-accent/50"
          aria-label="Filtrar por turma"
        >
          <option value="">Todas as turmas</option>
          {classOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {(profFilter || classFilter) && (
          <button
            onClick={() => { setProfFilter(''); setClassFilter(''); }}
            className="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-iv-muted flex items-center gap-1"
          >
            <X size={12} /> Limpar
          </button>
        )}
      </div>

      {/* Aggregated table per professor */}
      {aggregates.length > 0 && (
        <div className="glass-panel p-4 space-y-3">
          <h3 className="text-sm font-semibold text-iv-text flex items-center gap-2">
            <Star size={14} className="text-amber-400" /> Médias por professor
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-iv-muted">
                <tr className="text-left border-b border-white/5">
                  <th className="py-2 pr-3">Professor</th>
                  <th className="py-2 px-2 text-center">Aulas</th>
                  <th className="py-2 px-2 text-center">Conteúdo</th>
                  <th className="py-2 px-2 text-center">Dinâmicas</th>
                  <th className="py-2 px-2 text-center">Engaj.</th>
                  <th className="py-2 px-2 text-center">Geral</th>
                </tr>
              </thead>
              <tbody>
                {aggregates.map((r) => (
                  <tr key={r.profName} className="border-b border-white/5 last:border-b-0">
                    <td className="py-2 pr-3 text-iv-text font-medium">{r.profName}</td>
                    <td className="py-2 px-2 text-center text-iv-muted">{r.count}</td>
                    <td className="py-2 px-2 text-center text-iv-text">{r.avgContent.toFixed(1)}</td>
                    <td className="py-2 px-2 text-center text-iv-text">{r.avgDynamics.toFixed(1)}</td>
                    <td className="py-2 px-2 text-center text-iv-text">{r.avgEngagement.toFixed(1)}</td>
                    <td className="py-2 px-2 text-center font-semibold text-amber-300">{r.avgOverall.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Individual entries */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <p className="text-sm text-iv-muted text-center py-8">Nenhuma avaliação para os filtros selecionados.</p>
        ) : filtered.map(({ ev, sl, cls, prof, monitor }) => (
          <div key={ev.id} className="glass-panel p-4 space-y-2 border border-white/8">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-iv-text truncate">
                  {prof?.full_name ?? '— professor não identificado —'}
                </p>
                <p className="text-xs text-iv-muted truncate">
                  {cls?.name ?? '—'} {sl?.scheduled_at ? `· ${new Date(sl.scheduled_at).toLocaleString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 text-[11px] text-amber-300/80">
                <ClipboardCheck size={11} /> {monitor?.full_name ?? 'monitor'}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <ScoreChip label="Conteúdo" value={ev.content_score} />
              <ScoreChip label="Dinâmicas" value={ev.dynamics_score} />
              <ScoreChip label="Engaj." value={ev.engagement_score} />
              <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-iv-muted">
                Duração: {ev.duration_assessment}
              </span>
            </div>
            {ev.notes && (
              <div className="text-xs text-iv-muted/90 bg-white/[0.02] rounded-lg px-3 py-2 border border-white/5 leading-relaxed">
                <span className="text-iv-muted font-semibold">Observações: </span>{ev.notes}
              </div>
            )}
            {ev.suggestions && (
              <div className="text-xs text-iv-muted/90 bg-white/[0.02] rounded-lg px-3 py-2 border border-white/5 leading-relaxed">
                <span className="text-iv-muted font-semibold">Sugestões: </span>{ev.suggestions}
              </div>
            )}
            <p className="text-[10px] text-iv-muted/60">
              Enviada em {new Date(ev.created_at).toLocaleString('pt-BR')}
              {ev.updated_at !== ev.created_at && ` · editada em ${new Date(ev.updated_at).toLocaleString('pt-BR')}`}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreChip({ label, value }: { label: string; value: number }) {
  const tone = value >= 4 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
    : value >= 3 ? 'bg-amber-500/15 text-amber-300 border-amber-500/20'
    : 'bg-red-500/15 text-red-300 border-red-500/20';
  return (
    <span className={`px-2 py-0.5 rounded-full border ${tone} flex items-center gap-1`}>
      {label} <strong>{value}</strong>/5
    </span>
  );
}
