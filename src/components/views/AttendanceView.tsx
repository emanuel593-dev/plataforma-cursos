import React, { useEffect, useState, useCallback, useMemo } from "react";
import { ClipboardCheck, Loader2, ChevronDown, ChevronUp, AlertCircle, FileEdit, X, CheckCircle2, MapPin, Lightbulb, RefreshCw, AlertTriangle } from "lucide-react";
import { upsertAttendance, listByScheduledLessonIds, markJustified } from "../../services/attendance.service";
import { supabase } from "../../lib/supabase";
import { listScheduledLessons } from "../../services/schedule.service";
import { listClasses, listEnrollmentsByClass } from "../../services/classes.service";
import { listClassesByMonitor } from "../../services/monitors.service";
import { listModules, listAllLessons } from "../../services/modules.service";
import { listProfilesByRole } from "../../services/profiles.service";
import type { ScheduledLesson, Class, Lesson, Profile, AttendanceStatus, Module, Attendance } from "../../types";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useRealtime } from "../../hooks/useRealtime";
import EmptyState from "../ui/EmptyState";
import PageLoader from "../ui/PageLoader";
import PullToRefresh from "../ui/PullToRefresh";

type Cell = AttendanceStatus | null;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Edit-window check (decisão doc §12 #12): monitores editam chamada até 7
 * dias após a aula; coordenação sempre pode editar.
 */
function canEditLessonAttendance(
  role: Profile['role'] | undefined,
  scheduledAt: string,
): boolean {
  if (role === 'coordenacao') return true;
  if (role !== 'monitor') return false;
  const elapsed = Date.now() - new Date(scheduledAt).getTime();
  return elapsed <= SEVEN_DAYS_MS;
}

function cycleStatus(current: Cell): AttendanceStatus {
  if (current === null) return "present";
  if (current === "absent") return "present";
  if (current === "present") return "justified";
  return "present";
}

function cellLabel(status: Cell): string {
  if (status === "present") return "P";
  if (status === "absent") return "F";
  if (status === "justified") return "FJ";
  return "";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

interface ExpandedData {
  students: Profile[];
  scheduledLessons: ScheduledLesson[];
  matrix: Record<string, Record<string, Cell>>;
  /** Raw attendance records keyed by `${scheduledLessonId}:${studentId}` */
  details: Record<string, Attendance>;
  loading: boolean;
}
const EMPTY: ExpandedData = { students: [], scheduledLessons: [], matrix: {}, details: {}, loading: false };

export default function AttendanceView() {
  const { profile, user } = useAuth();
  const { showToast } = useToast();
  const isMonitor = profile?.role === 'monitor';
  // Coordinators always edit; monitors edit attendance for their assigned
  // classes (the list is junction-filtered above, so no extra per-class
  // check is needed). Professors remain view-only.
  const canEdit = profile?.role === 'coordenacao' || isMonitor;
  const [classes, setClasses] = useState<Class[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledLesson[]>([]);
  const [allLessons, setAllLessons] = useState<Lesson[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedClassId, setExpandedClassId] = useState<string | null>(null);
  const [expandedData, setExpandedData] = useState<ExpandedData>(EMPTY);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [notesModal, setNotesModal] = useState<{ slId: string; studentId: string; current: string } | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [removingFj, setRemovingFj] = useState(false);
  /** Per-lesson "mark all present" in-flight state for monitor's quick action. */
  const [bulkMarking, setBulkMarking] = useState<string | null>(null);
  // Fase 3: estado para reprocessamento de aula
  const [reprocessingLesson, setReprocessingLesson] = useState<string | null>(null);

  // ── Realtime subscription for attendance changes in the expanded class ──────
  // Build a PostgREST `in` filter from the currently-visible scheduled lessons.
  // When the class is collapsed or still loading, `enabled` is false → no channel.
  const realtimeFilter = useMemo(() => {
    if (expandedData.scheduledLessons.length === 0) return undefined;
    const ids = expandedData.scheduledLessons.map((sl) => sl.id).join(',');
    return `scheduled_lesson_id=in.(${ids})`;
  }, [expandedData.scheduledLessons]);

  useRealtime<Attendance & Record<string, unknown>>({
    table: 'attendance',
    filter: realtimeFilter,
    enabled: Boolean(expandedClassId) && !expandedData.loading && expandedData.scheduledLessons.length > 0,
    onPayload(payload) {
      if (payload.eventType === 'DELETE') return;
      const rec = payload.new as Attendance | null;
      if (!rec?.scheduled_lesson_id || !rec?.student_id) return;
      setExpandedData((prev) => {
        // Skip if this row isn't part of the current matrix (shouldn't happen)
        if (!prev.matrix[rec.scheduled_lesson_id]) return prev;
        return {
          ...prev,
          matrix: {
            ...prev.matrix,
            [rec.scheduled_lesson_id]: {
              ...prev.matrix[rec.scheduled_lesson_id],
              [rec.student_id]: rec.status,
            },
          },
          details: {
            ...prev.details,
            [`${rec.scheduled_lesson_id}:${rec.student_id}`]: rec,
          },
        };
      });
    },
  });

  /** Show the monitor onboarding hint once (dismissable). */
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return !window.localStorage.getItem('iv:onboarding:attendance-presencial');
    } catch {
      return false;
    }
  });

  useEffect(() => {
    async function init() {
      try {
        const [cls, mods, sch, les, studs] = await Promise.all([
          isMonitor && user ? listClassesByMonitor(user.id) : listClasses(),
          listModules(),
          listScheduledLessons(),
          listAllLessons(),
          listProfilesByRole("aluno"),
        ]);
        setClasses(cls);
        setModules(mods);
        setScheduled(sch);
        setAllLessons(les);
        setStudents(studs);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  function moduleForClass(cls: Class): Module | undefined {
    return modules.find((m) => m.id === cls.module_id);
  }

  async function loadClassData(classId: string) {
    setExpandedData({ ...EMPTY, loading: true });
    try {
      const enrollments = await listEnrollmentsByClass(classId);
      const classStudents = enrollments
        .map((e) => students.find((s) => s.id === e.student_id))
        .filter((s): s is Profile => Boolean(s))
        .sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR"));

      // Only include scheduled lessons that have a valid, known lesson_id.
      // Entries with lesson_id=null or pointing to a deleted lesson are skipped
      // to prevent "Nª Aula" ghost columns.
      const classScheduled = scheduled
        .filter((s) => s.class_id === classId && s.lesson_id && allLessons.some((l) => l.id === s.lesson_id))
        .sort((a, b) => {
          const la = allLessons.find((l) => l.id === a.lesson_id);
          const lb = allLessons.find((l) => l.id === b.lesson_id);
          return (la?.order_index ?? 999) - (lb?.order_index ?? 999);
        });

      const slIds = classScheduled.map((s) => s.id);
      const records = await listByScheduledLessonIds(slIds);

      const matrix: Record<string, Record<string, Cell>> = {};
      const details: Record<string, Attendance> = {};
      for (const sl of classScheduled) {
        matrix[sl.id] = {};
        for (const st of classStudents) matrix[sl.id][st.id] = null;
      }
      for (const rec of records) {
        if (matrix[rec.scheduled_lesson_id]) {
          matrix[rec.scheduled_lesson_id][rec.student_id] = rec.status;
          details[`${rec.scheduled_lesson_id}:${rec.student_id}`] = rec;
        }
      }

      setExpandedData({ students: classStudents, scheduledLessons: classScheduled, matrix, details, loading: false });
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Erro ao carregar dados da turma.', 'error');
      // Reset to empty so the spinner doesn’t linger
      setExpandedData(EMPTY);
    }
  }

  /**
   * Fase 3 — Reprocessar automaticamente todas as presenças de uma aula.
   * Força o reprocessamento da presença de uma aula inteira, útil após o backfill.
   *
   * Disponível apenas para coordenação.
   */
  async function reprocessLesson(slId: string) {
    if (profile?.role !== 'coordenacao') return;
    setReprocessingLesson(slId);
    try {
      // Usa a RPC que faz o update (no-op) em duration_seconds ativando os triggers
      const { error } = await supabase.rpc('attendance_reprocess_lesson', {
        p_lesson_id: slId,
      });

      if (error) throw new Error(error.message);

      // Recarrega os dados para refletir os novos status
      showToast('Presenças reprocessadas com sucesso.', 'success');
      if (expandedClassId) await loadClassData(expandedClassId);
    } catch (e: any) {
      // Fallback: caso a migration 052 não tenha sido rodada ainda
      showToast(
        'Falha no reprocessamento automático. Verifique as migrations no Supabase.',
        'error',
      );
    } finally {
      setReprocessingLesson(null);
    }
  }

  /**
   * Fase 3 — Detecta registros anômalos em uma aula:
   * alunos com status=absent mas com duration_seconds >= 50% do esperado
   * (indicativo de BUG #2 não corrigido ou trigger com effective_seconds errado).
   */
  function hasAnomalousRecord(slId: string): boolean {
    const sl = expandedData.scheduledLessons.find((s) => s.id === slId);
    if (!sl) return false;
    // Usa duration_minutes como referência se não há started_at/ended_at
    const expectedSeconds = (sl.duration_minutes ?? 0) * 60;
    if (expectedSeconds <= 0) return false;

    return expandedData.students.some((st) => {
      const status = expandedData.matrix[slId]?.[st.id];
      if (status !== 'absent') return false;
      const detail = expandedData.details[`${slId}:${st.id}`];
      if (!detail?.duration_seconds) return false;
      // Ausente mas ficou >= 50% do tempo → anômalo
      return detail.duration_seconds >= expectedSeconds * 0.5;
    });
  }

  async function toggleClass(cls: Class) {
    if (expandedClassId === cls.id) {
      setExpandedClassId(null);
      setExpandedData(EMPTY);
      return;
    }
    setExpandedClassId(cls.id);
    await loadClassData(cls.id);
  }

  /**
   * Quick action for monitor/coord: mark every enrolled student as "present"
   * for a given scheduled lesson. Skips students that already have any status
   * recorded (so we never overwrite an FJ or an explicit F). Used primarily
   * by the presencial monitor workflow.
   */
  async function markAllPresent(slId: string) {
    if (!profile || !canEdit) return;
    // Janela 7 dias (doc §12 #12).
    const sl = expandedData.scheduledLessons.find((s) => s.id === slId);
    if (sl && !canEditLessonAttendance(profile.role, sl.scheduled_at)) {
      showToast('Aula com mais de 7 dias — apenas coordenação pode editar.', 'error');
      return;
    }
    setBulkMarking(slId);
    // Capture current matrix for diffing/rollback.
    const currentRow = expandedData.matrix[slId] ?? {};
    const toMark = expandedData.students.filter((st) => (currentRow[st.id] ?? null) === null);
    if (toMark.length === 0) {
      showToast('Nenhum aluno em branco nessa aula.', 'info');
      setBulkMarking(null);
      return;
    }
    // Optimistic update first so the UI feels instant.
    setExpandedData((prev) => {
      const nextRow = { ...(prev.matrix[slId] ?? {}) };
      for (const st of toMark) nextRow[st.id] = 'present';
      return { ...prev, matrix: { ...prev.matrix, [slId]: nextRow } };
    });
    let errored = 0;
    for (const st of toMark) {
      try {
        await upsertAttendance(slId, st.id, {
          status: 'present',
          marked_by: profile.id,
          manually_overridden: true,
          notes: null,
        });
      } catch (err) {
        errored++;
        console.error('markAllPresent', err);
      }
    }
    setBulkMarking(null);
    if (errored === 0) {
      showToast(`${toMark.length} aluno(s) marcado(s) como presente.`, 'success');
    } else if (errored < toMark.length) {
      showToast(`Marcação parcial: ${toMark.length - errored}/${toMark.length} salvos.`, 'warning');
      // Best-effort reload so cells match the server.
      if (expandedClassId) await loadClassData(expandedClassId);
    } else {
      showToast('Erro ao marcar presenças em lote.', 'error');
      if (expandedClassId) await loadClassData(expandedClassId);
    }
  }

  function dismissOnboarding() {
    setShowOnboarding(false);
    try {
      window.localStorage.setItem('iv:onboarding:attendance-presencial', '1');
    } catch {
      /* localStorage may be unavailable in private mode \u2014 dismiss in-memory only */
    }
  }

  const saveNotes = useCallback(async (slId: string, studentId: string, notes: string) => {
    if (!profile) return;
    // Decisão doc §5.8: justificativa obrigatória em FJ. Bloqueamos save
    // se o textarea estiver vazio (apenas espaços também conta como vazio).
    if (!notes.trim()) {
      showToast('Informe o motivo da falta justificada.', 'error');
      return;
    }
    setSavingNotes(true);
    try {
      await upsertAttendance(slId, studentId, { notes, marked_by: profile.id });
      // Update details map optimistically
      setExpandedData((prev) => {
        const key = `${slId}:${studentId}`;
        return {
          ...prev,
          details: {
            ...prev.details,
            [key]: { ...(prev.details[key] ?? {}), notes } as typeof prev.details[string],
          },
        };
      });
      setNotesModal(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar justificativa.', 'error');
    } finally {
      setSavingNotes(false);
    }
  }, [profile, showToast]);

  /**
   * Remove o status 'justified' de uma célula, retornando-a para 'absent'.
   * Acionado pelo botão "Remover FJ" dentro do modal de notas.
   * Usa manually_overridden=true para que o trigger server-side preserve a
   * decisão sem recomputar automaticamente.
   */
  async function handleRemoveFj(slId: string, studentId: string) {
    if (!profile || !canEdit) return;
    const sl = expandedData.scheduledLessons.find((s) => s.id === slId);
    if (sl && !canEditLessonAttendance(profile.role, sl.scheduled_at)) {
      showToast('Aula com mais de 7 dias — apenas coordenação pode editar.', 'error');
      return;
    }
    setRemovingFj(true);
    try {
      // Otimista: fecha o modal antes do await para resposta imediata
      setNotesModal(null);
      setExpandedData((prev) => ({
        ...prev,
        matrix: {
          ...prev.matrix,
          [slId]: { ...prev.matrix[slId], [studentId]: 'absent' },
        },
      }));
      await upsertAttendance(slId, studentId, {
        status: 'absent',
        marked_by: profile.id,
        manually_overridden: true,
        notes: null,
      });
      showToast('FJ removida. Aluno marcado como falta.', 'success');
    } catch (err) {
      console.error('handleRemoveFj', err);
      showToast(err instanceof Error ? err.message : 'Erro ao remover FJ.', 'error');
      // Reverter
      setExpandedData((prev) => ({
        ...prev,
        matrix: {
          ...prev.matrix,
          [slId]: { ...prev.matrix[slId], [studentId]: 'justified' },
        },
      }));
    } finally {
      setRemovingFj(false);
    }
  }

  async function handleCellClick(studentId: string, slId: string) {
    if (!profile) return;
    if (!canEdit) return; // professors: view-only
    // Janela 7 dias (doc §12 #12): monitor não edita aulas antigas.
    const sl = expandedData.scheduledLessons.find((s) => s.id === slId);
    if (sl && !canEditLessonAttendance(profile.role, sl.scheduled_at)) {
      showToast('Aula com mais de 7 dias — apenas coordenação pode editar.', 'error');
      return;
    }
    const cellKey = `${studentId}-${slId}`;
    // Store previous value for rollback (M15)
    const previousValue = expandedData.matrix[slId]?.[studentId] ?? null;

    // FJ cell: open notes modal instead of cycling
    if (previousValue === 'justified') {
      const detail = expandedData.details[`${slId}:${studentId}`];
      setNotesDraft(detail?.notes ?? '');
      setNotesModal({ slId, studentId, current: detail?.notes ?? '' });
      return;
    }

    const next = cycleStatus(previousValue);
    // Apply optimistic update immediately
    setExpandedData((prev) => ({
      ...prev,
      matrix: {
        ...prev.matrix,
        [slId]: { ...prev.matrix[slId], [studentId]: next },
      },
    }));
    setSavingCell(cellKey);
    try {
      if (next === 'justified') {
        // Use markJustified so the makeup deadline (next-lesson - 24h) is computed
        // and frozen on the row. Without this, the FJ → reposição enforcement
        // pipeline (cron + UI badges) is inert. Pass a stable requestId so
        // that retry on network timeout doesn't double-write.
        const saved = await markJustified(slId, studentId, profile.id, undefined, crypto.randomUUID());
        if (!saved.makeup_deadline) {
          // Either there is no "next lesson" yet (last in calendar) or the lookup
          // failed. The FJ is recorded but the student has no enforced deadline.
          showToast('FJ registrada, mas sem prazo: verifique se a turma tem aulas futuras agendadas.', 'info');
        }
        // Best-effort push to student — fire and forget, never block the UI
        supabase.auth.getSession().then(({ data }) => {
          const token = data.session?.access_token;
          if (!token) return;
          fetch('/.netlify/functions/push-fj-assigned', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ attendanceId: saved.id }),
          }).catch(() => {});
        });
      } else {
        // Manual override: marca a flag para o trigger server-side preservar a
        // decisão, e limpa qualquer nota automática antiga (BUG D da auditoria).
        await upsertAttendance(slId, studentId, {
          status: next,
          marked_by: profile.id,
          manually_overridden: true,
          notes: null,
        });
      }
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Erro ao salvar presença.', 'error');
      // Revert optimistic update on failure
      setExpandedData((prev) => ({
        ...prev,
        matrix: {
          ...prev.matrix,
          [slId]: { ...prev.matrix[slId], [studentId]: previousValue },
        },
      }));
    } finally {
      setSavingCell(null);
    }
  }

  if (loading) {
    return <PageLoader variant="list" rows={4} />;
  }

  async function refresh() {
    setLoading(true);
    try {
      const [cls, mods, sch, les, studs] = await Promise.all([
        isMonitor && user ? listClassesByMonitor(user.id) : listClasses(),
        listModules(),
        listScheduledLessons(),
        listAllLessons(),
        listProfilesByRole("aluno"),
      ]);
      setClasses(cls);
      setModules(mods);
      setScheduled(sch);
      setAllLessons(les);
      setStudents(studs);
      if (expandedClassId) await loadClassData(expandedClassId);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
    <PullToRefresh onRefresh={refresh}>
    <div className="space-y-4">
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-iv-text">Presenças</h2>
        <p className="text-xs sm:text-sm text-iv-muted mt-0.5">Clique em uma turma para abrir a chamada</p>
      </div>

      {classes.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={32} />}
          title="Nenhuma turma"
          description="Crie turmas para gerenciar presenças."
        />
      ) : (
        <div className="space-y-3">
          {classes.map((cls) => {
            const mod = moduleForClass(cls);
            const isExpanded = expandedClassId === cls.id;
            const accentColor = mod?.color ?? "#7c3aed";

            return (
              <div key={cls.id} className="glass-panel overflow-hidden">
                {/* Class header row */}
                <button
                  onClick={() => toggleClass(cls)}
                  className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:bg-white/5 transition-colors"
                >
                  <div
                    className="w-1 self-stretch rounded-full shrink-0"
                    style={{ backgroundColor: accentColor }}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="font-bold text-iv-text block truncate">{cls.name}</span>
                    {mod && (
                      <span className="text-xs font-medium mt-0.5 block" style={{ color: accentColor }}>
                        {mod.name}
                      </span>
                    )}
                    {(() => {
                      const m = cls.modality ?? 'online';
                      const cfg = {
                        online:     { label: '🟢 Online',     cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' },
                        presencial: { label: '🏛️ Presencial', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/20' },
                        hibrida:    { label: '🔀 Híbrida',    cls: 'bg-purple-500/15 text-purple-300 border-purple-500/20' },
                      }[m];
                      return (
                        <span className={`inline-flex items-center gap-1 mt-1 text-[10px] px-1.5 py-0.5 rounded border ${cfg.cls}`}>
                          {cfg.label}
                          {cls.location && (
                            <>
                              <MapPin size={9} className="ml-1 opacity-70" />
                              <span className="truncate max-w-[10rem]">{cls.location}</span>
                            </>
                          )}
                        </span>
                      );
                    })()}
                  </div>
                  <span className="text-iv-muted shrink-0">
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </span>
                </button>

                {/* Expanded attendance sheet */}
                {isExpanded && (
                  <div className="border-t border-white/8">
                    {expandedData.loading ? (
                      <div className="flex justify-center py-10">
                        <Loader2 size={22} className="animate-spin text-iv-accent" />
                      </div>
                    ) : expandedData.scheduledLessons.length === 0 ? (
                      <p className="text-sm text-iv-muted/60 text-center py-8">
                        Nenhuma aula agendada para esta turma.
                      </p>
                    ) : expandedData.students.length === 0 ? (
                      <p className="text-sm text-iv-muted/60 text-center py-8">
                        Nenhum aluno matriculado.
                      </p>
                    ) : (
                      <>
                        {/* Onboarding hint (monitor first-run, dismissable) */}
                        {showOnboarding && isMonitor && cls.modality !== 'online' && (
                          <div className="m-3 sm:m-4 p-3 rounded-xl bg-iv-accent/10 border border-iv-accent/25 flex items-start gap-2.5">
                            <Lightbulb size={16} className="text-iv-accent shrink-0 mt-0.5" />
                            <div className="flex-1 text-xs text-iv-text leading-relaxed">
                              <strong className="font-semibold">Dica:</strong> use “Marcar todos P” para preencher a chamada em segundos e ajuste apenas os ausentes. FJ abre campo de justificativa.
                            </div>
                            <button
                              onClick={dismissOnboarding}
                              className="text-iv-muted hover:text-iv-text shrink-0 touch-target -m-1 p-1"
                              aria-label="Dispensar dica"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        )}

                        {/* Quick actions: bulk-mark per scheduled lesson */}
                        {canEdit && expandedData.scheduledLessons.length > 0 && (
                          <div className="px-3 sm:px-4 py-2.5 border-b border-white/5 bg-white/[0.015]">
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <span className="text-[11px] font-semibold text-iv-muted uppercase tracking-wider">Ações rápidas</span>
                              <span className="text-[10px] text-iv-muted/50">Marca P em alunos sem registro</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {expandedData.scheduledLessons.map((sl, i) => {
                                const lesson = allLessons.find((l) => l.id === sl.lesson_id);
                                const label = lesson ? `A${lesson.order_index}` : `${i + 1}ª`;
                                const isBusy = bulkMarking === sl.id;
                                const isReprocessing = reprocessingLesson === sl.id;
                                const row = expandedData.matrix[sl.id] ?? {};
                                const pending = expandedData.students.filter((st) => (row[st.id] ?? null) === null).length;
                                const lockedByWindow = !canEditLessonAttendance(profile?.role, sl.scheduled_at);
                                const disabled = isBusy || pending === 0 || lockedByWindow;
                                // Fase 3: detectar anomalia nesta aula
                                const anomalous = hasAnomalousRecord(sl.id);
                                return (
                                  <div key={sl.id} className="flex flex-col gap-1">
                                    <button
                                      onClick={() => markAllPresent(sl.id)}
                                      disabled={disabled}
                                      title={
                                        lockedByWindow
                                          ? 'Aula com mais de 7 dias — apenas coordenação pode editar.'
                                          : pending > 0
                                            ? `Marcar ${pending} aluno(s) como presente em ${fmtDate(sl.scheduled_at)}`
                                            : 'Sem alunos em branco'
                                      }
                                      className={[
                                        'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors touch-target',
                                        disabled
                                          ? 'bg-white/3 text-iv-muted/40 border-white/8 cursor-not-allowed'
                                          : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25 hover:bg-emerald-500/20',
                                      ].join(' ')}
                                    >
                                      {isBusy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                                      <span>Todos P · {label}</span>
                                      <span className="text-[9px] opacity-60">{fmtDate(sl.scheduled_at)}</span>
                                      {pending > 0 && !isBusy && (
                                        <span className="ml-0.5 px-1 rounded bg-emerald-500/20 text-emerald-200 text-[9px]">{pending}</span>
                                      )}
                                    </button>

                                    {/* Fase 3: Botão Reprocessar (apenas coordenação) + badge de anomalia */}
                                    {profile?.role === 'coordenacao' && (
                                      <div className="flex items-center gap-1">
                                        <button
                                          onClick={() => reprocessLesson(sl.id)}
                                          disabled={isReprocessing}
                                          title={`Reprocessar presenças automáticas de ${label} com base no tempo de permanência atual`}
                                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium border transition-colors bg-white/3 text-iv-muted/60 border-white/8 hover:bg-blue-500/10 hover:text-blue-300 hover:border-blue-500/20 disabled:opacity-40"
                                        >
                                          {isReprocessing
                                            ? <Loader2 size={9} className="animate-spin" />
                                            : <RefreshCw size={9} />
                                          }
                                          <span>Reprocessar · {label}</span>
                                        </button>
                                        {anomalous && !isReprocessing && (
                                          <span
                                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-500/15 text-orange-400 border border-orange-500/20"
                                            title="Há alunos marcados como ausentes mas com tempo de permanência elevado — clique em Reprocessar"
                                          >
                                            <AlertTriangle size={8} />
                                            Anomalia
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}


                        {/* ── MOBILE: continuous list with iOS-style row dividers ── */}
                        <div className="md:hidden">
                          {expandedData.students.map((student) => {
                            const rowCells = expandedData.scheduledLessons.map(
                              (sl) => expandedData.matrix[sl.id]?.[student.id] ?? null,
                            );
                            const present = rowCells.filter((c) => c === "present").length;
                            const absent = rowCells.filter((c) => c === "absent").length;
                            const justified = rowCells.filter((c) => c === "justified").length;
                            const total = rowCells.filter((c) => c !== null).length;
                            const pct = total > 0 ? Math.round((present / total) * 100) : null;
                            const freqStatus = absent >= 3 ? "reprovado" : absent >= 2 ? "pendente" : null;

                            return (
                              <div key={student.id} className="px-4 py-3 space-y-2 border-b border-white/5 last:border-0">
                                {/* Student header */}
                                <div className="flex items-center justify-between gap-2 min-w-0">
                                  <span className="text-sm font-semibold text-iv-text truncate flex-1 min-w-0">{student.full_name}</span>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {freqStatus === "reprovado" && (
                                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 uppercase">Repr.</span>
                                    )}
                                    {freqStatus === "pendente" && (
                                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 uppercase">Atenc.</span>
                                    )}
                                    {pct !== null && (
                                      <span className={`text-sm font-bold ${pct >= 75 ? "text-emerald-400" : pct >= 50 ? "text-amber-400" : "text-red-400"}`}>
                                        {pct}%
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Frequency mini-bar */}
                                {total > 0 && (
                                  <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-white/5">
                                    {present > 0 && <div className="bg-emerald-500/70 rounded-full" style={{ flex: present }} />}
                                    {absent > 0 && <div className="bg-red-500/70 rounded-full" style={{ flex: absent }} />}
                                    {justified > 0 && <div className="bg-amber-500/70 rounded-full" style={{ flex: justified }} />}
                                  </div>
                                )}

                                {/* Lesson buttons with date */}
                                <div className="flex flex-wrap gap-1.5 pt-0.5">
                                  {expandedData.scheduledLessons.map((sl, i) => {
                                    const cellKey = `${student.id}-${sl.id}`;
                                    const status = expandedData.matrix[sl.id]?.[student.id] ?? null;
                                    const isSaving = savingCell === cellKey;
                                    const detail = expandedData.details[`${sl.id}:${student.id}`];
                                    const isFjSatisfied = status === "justified" && detail?.makeup_satisfied === true;
                                    const lesson = allLessons.find((l) => l.id === sl.lesson_id);
                                    const label = lesson ? `A${lesson.order_index}` : `${i + 1}`;
                                    const dateShort = fmtDate(sl.scheduled_at);
                                    return (
                                      <button
                                        key={sl.id}
                                        onClick={() => handleCellClick(student.id, sl.id)}
                                        disabled={isSaving || !canEdit}
                                        title={canEdit ? dateShort : `${dateShort} (somente leitura)`}
                                        className={[
                                          "flex flex-col items-center justify-center min-w-[3rem] h-11 px-1.5 rounded-lg text-xs font-bold border",
                                          canEdit ? "transition-colors" : "cursor-default",
                                          status === "present"
                                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                                            : status === "absent"
                                            ? "bg-red-500/15 text-red-400 border-red-500/30"
                                            : isFjSatisfied
                                            ? "bg-teal-500/15 text-teal-400 border-teal-500/30"
                                            : status === "justified"
                                            ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                                            : "bg-white/5 text-iv-muted/40 border-white/10",
                                        ].join(" ")}
                                      >
                                        {isSaving ? (
                                          <Loader2 size={10} className="animate-spin" />
                                        ) : (
                                          <>
                                            <span className="text-[9px] opacity-60 leading-none">{label}</span>
                                            <span className="leading-none mt-0.5">
                                              {isFjSatisfied ? "FJ✓" : (cellLabel(status) || "–")}
                                            </span>
                                            <span className="text-[8px] opacity-40 leading-none mt-0.5">{dateShort}</span>
                                          </>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>

                                {/* Summary row */}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-iv-muted/60 pt-0.5 border-t border-white/5">
                                  <span><span className="font-bold text-emerald-400">P</span> {present}</span>
                                  <span><span className="font-bold text-red-400">F</span> {absent}</span>
                                  <span><span className="font-bold text-amber-400">FJ</span> {justified}</span>
                                  {expandedData.scheduledLessons.some((sl) => expandedData.details[`${sl.id}:${student.id}`]?.makeup_satisfied) && (
                                    <span className="text-teal-400/80">FJ✓ reposição ok</span>
                                  )}
                                  {canEdit && <span className="sm:ml-auto text-[10px]">Toque para alternar</span>}
                                </div>
                              </div>
                            );
                          })}
                          {canEdit && (
                            <div className="flex items-center gap-4 px-4 py-2 text-[11px] text-iv-muted/50">
                              <span>Toque para alternar status</span>
                            </div>
                          )}
                        </div>

                        {/* ── DESKTOP: matrix table ────────────────── */}
                        <div className="hidden md:block overflow-x-auto relative">
                          {/* Scroll hint for very wide tables */}
                          <div className="lg:hidden pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-iv-card/90 to-transparent z-10" />
                        <table className="w-full border-collapse">
                          <thead>
                            {/* Row 1: lesson number headers */}
                            <tr className="border-b border-white/5">
                              <th
                                rowSpan={2}
                                className="sticky left-0 z-10 bg-iv-bg text-left px-5 py-3 text-xs font-bold text-iv-muted uppercase tracking-wider whitespace-nowrap min-w-[200px] align-bottom border-r border-white/5"
                              >
                                Alunos
                              </th>
                              {expandedData.scheduledLessons.map((sl, i) => {
                                const lesson = allLessons.find((l) => l.id === sl.lesson_id);
                                return (
                                  <th
                                    key={sl.id}
                                    className="px-3 pt-3 pb-0.5 text-sm font-bold text-center whitespace-nowrap"
                                    style={{ color: accentColor }}
                                  >
                                    {lesson ? `Aula ${lesson.order_index}` : `${i + 1}ª Aula`}
                                  </th>
                                );
                              })}
                              <th className="px-2 pt-3 pb-0.5 text-xs font-bold text-emerald-400/80 text-center whitespace-nowrap">P</th>
                              <th className="px-2 pt-3 pb-0.5 text-xs font-bold text-red-400/80 text-center whitespace-nowrap">F</th>
                              <th className="px-2 pt-3 pb-0.5 text-xs font-bold text-amber-400/80 text-center whitespace-nowrap">FJ</th>
                              <th className="px-2 pt-3 pb-0.5 text-xs font-bold text-iv-muted text-center whitespace-nowrap">Freq.</th>
                            </tr>
                            {/* Row 2: dates */}
                            <tr className="border-b border-white/10">
                              {expandedData.scheduledLessons.map((sl) => (
                                <th
                                  key={sl.id}
                                  className="px-3 pb-2 text-[11px] font-normal text-iv-muted/50 text-center whitespace-nowrap"
                                >
                                  {fmtDate(sl.scheduled_at)}
                                </th>
                              ))}
                              <th colSpan={4} />
                            </tr>
                          </thead>

                          <tbody>
                            {expandedData.students.map((student) => {
                              const rowCells = expandedData.scheduledLessons.map(
                                (sl) => expandedData.matrix[sl.id]?.[student.id] ?? null,
                              );
                              const present = rowCells.filter((c) => c === "present").length;
                              const absent = rowCells.filter((c) => c === "absent").length;
                              const justified = rowCells.filter((c) => c === "justified").length;
                              const total = rowCells.filter((c) => c !== null).length;
                              const pct = total > 0 ? Math.round((present / total) * 100) : null;
                              // FJ does NOT count as falta
                              const freqStatus = absent >= 3 ? "reprovado" : absent >= 2 ? "pendente" : null;

                              return (
                                <tr
                                  key={student.id}
                                  className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors"
                                >
                                  {/* Student name — sticky */}
                                  <td className="sticky left-0 z-10 bg-iv-bg px-5 py-3 whitespace-nowrap border-r border-white/5">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-semibold text-iv-text">
                                        {student.full_name}
                                      </span>
                                      {freqStatus === "reprovado" && (
                                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 uppercase tracking-wide shrink-0">
                                          Reprovado
                                        </span>
                                      )}
                                      {freqStatus === "pendente" && (
                                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 uppercase tracking-wide shrink-0">
                                          Pendente
                                        </span>
                                      )}
                                    </div>
                                  </td>

                                  {/* Attendance cells */}
                                  {expandedData.scheduledLessons.map((sl) => {
                                    const cellKey = `${student.id}-${sl.id}`;
                                    const status = expandedData.matrix[sl.id]?.[student.id] ?? null;
                                    const detail = expandedData.details[`${sl.id}:${student.id}`];
                                    const isSaving = savingCell === cellKey;
                                    const label = cellLabel(status);
                                    const isAutoTracked = detail?.joined_at != null;
                                    const isManualOverride = detail?.manually_overridden === true;

                                    // Build rich tooltip
                                    const tooltipParts: string[] = [];
                                    if (status === null) tooltipParts.push(canEdit ? "Clique para marcar presença" : "Sem registro");
                                    else if (status === "present") tooltipParts.push("Presente");
                                    else if (status === "absent") tooltipParts.push("Falta");
                                    else tooltipParts.push(detail?.makeup_satisfied ? "Falta justificada ✓ reposição satisfeita" : "Falta justificada");

                                    if (detail?.duration_seconds != null) {
                                      const mins = Math.floor(detail.duration_seconds / 60);
                                      const secs = detail.duration_seconds % 60;
                                      tooltipParts.push(`Permanência: ${mins}min ${secs}s`);
                                    }
                                    if (detail && detail.total_checks > 0) {
                                      const checksLabel = `Verificações: ${detail.verified_checks}/${detail.total_checks}`;
                                      // Fase 2: alertar se total_checks > 3 (resquício BUG #1 em dados históricos)
                                      tooltipParts.push(detail.total_checks > 3
                                        ? `⚠️ ${checksLabel} (histórico anômalo — > 3)`
                                        : checksLabel);
                                    }
                                    if (isAutoTracked) tooltipParts.push("⚡ Registro automático");
                                    if (isManualOverride) tooltipParts.push("✏️ Alterado manualmente");
                                    if (detail?.notes) tooltipParts.push(detail.notes);
                                    if (status !== null && canEdit) tooltipParts.push("Clique para alterar");

                                    return (
                                      <td key={sl.id} className="px-2 py-3 text-center">
                                        {isSaving ? (
                                          <Loader2
                                            size={12}
                                            className="animate-spin text-iv-accent mx-auto"
                                          />
                                        ) : (
                                          <button
                                            onClick={() => handleCellClick(student.id, sl.id)}
                                            disabled={!canEdit}
                                            title={tooltipParts.join("\n")}
                                            className={[
                                              "relative min-w-[2.5rem] h-7 rounded px-1 text-sm font-bold",
                                              canEdit ? "transition-colors" : "cursor-default",
                                              status === "present"
                                                ? canEdit ? "text-emerald-400 hover:bg-emerald-500/10" : "text-emerald-400"
                                                : status === "absent"
                                                ? canEdit ? "text-red-400 hover:bg-red-500/10" : "text-red-400"
                                                : status === "justified" && detail?.makeup_satisfied
                                                ? canEdit ? "text-teal-400 hover:bg-teal-500/10" : "text-teal-400"
                                                : status === "justified"
                                                ? canEdit ? "text-amber-400 hover:bg-amber-500/10" : "text-amber-400"
                                                : canEdit ? "text-iv-muted/20 hover:text-iv-muted/50 hover:bg-white/5" : "text-iv-muted/20",
                                            ].join(" ")}
                                          >
                                            {status === "justified" && detail?.makeup_satisfied ? "FJ✓" : (label || <span className="text-xs font-normal">–</span>)}
                                            {/* Ponto azul = registro automático; ponto branco = override manual */}
                                            {isManualOverride && status !== null && (
                                              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-white/60" title="Alterado manualmente" />
                                            )}
                                            {isAutoTracked && !isManualOverride && status !== null && (
                                              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-iv-accent" title="Registro automático" />
                                            )}
                                          </button>
                                        )}
                                      </td>
                                    );
                                  })}


                                  {/* Per-student totals */}
                                  <td className="px-2 py-3 text-center text-sm font-bold text-emerald-400">
                                    {present > 0 ? present : (
                                      <span className="text-iv-muted/20 font-normal text-xs">–</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-3 text-center text-sm font-bold text-red-400">
                                    {absent > 0 ? absent : (
                                      <span className="text-iv-muted/20 font-normal text-xs">–</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-3 text-center text-sm font-bold text-amber-400">
                                    {justified > 0 ? justified : (
                                      <span className="text-iv-muted/20 font-normal text-xs">–</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-3 text-center text-sm font-semibold">
                                    {pct !== null ? (
                                      <span
                                        className={
                                          pct >= 75
                                            ? "text-emerald-400"
                                            : pct >= 50
                                            ? "text-amber-400"
                                            : "text-red-400"
                                        }
                                      >
                                        {pct}%
                                      </span>
                                    ) : (
                                      <span className="text-iv-muted/20 text-xs">–</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>

                          {/* Footer: presences per lesson */}
                          <tfoot>
                            <tr className="border-t border-white/10 bg-white/[0.015]">
                              <td className="sticky left-0 z-10 bg-iv-bg/80 px-5 py-2.5 text-xs font-semibold text-iv-muted whitespace-nowrap border-r border-white/5">
                                Presenças / aula
                              </td>
                              {expandedData.scheduledLessons.map((sl) => {
                                const cnt = expandedData.students.filter(
                                  (s) => expandedData.matrix[sl.id]?.[s.id] === "present",
                                ).length;
                                return (
                                  <td key={sl.id} className="px-2 py-2.5 text-center">
                                    <span className="text-xs font-bold text-emerald-400">{cnt}</span>
                                  </td>
                                );
                              })}
                              <td colSpan={4} />
                            </tr>
                          </tfoot>
                        </table>

                        {/* Legend */}
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-2.5 border-t border-white/5 text-[11px] text-iv-muted/50">
                          <span>
                            <span className="font-bold text-emerald-400">P</span> = Presente
                          </span>
                          <span>
                            <span className="font-bold text-red-400">F</span> = Falta
                          </span>
                          <span>
                            <span className="font-bold text-amber-400">FJ</span> = Falta Justificada
                          </span>
                          {canEdit && (
                            <span className="hidden sm:inline ml-auto">
                              · Clique na célula para alternar
                            </span>
                          )}
                          {!canEdit && (
                            <span className="hidden sm:inline ml-auto text-amber-400/70">
                              · Somente leitura (apenas coordenação pode alterar)
                            </span>
                          )}
                        </div>
                      </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
    </PullToRefresh>

    {/* ── FJ Notes Modal ────────────────────────────────────────────────── */}
    {notesModal && (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        <button
          type="button"
          aria-label="Fechar"
          onClick={() => setNotesModal(null)}
          className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        />
        <div
          className="relative w-full sm:max-w-md bg-iv-card border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Justificativa de falta"
        >
          <div className="flex justify-center pt-2.5 sm:hidden">
            <span className="w-10 h-1 rounded-full bg-white/20" aria-hidden="true" />
          </div>
          <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-white/8">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
              <FileEdit size={17} className="text-amber-400" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-iv-text">Justificativa da Falta</p>
              <p className="text-xs text-iv-muted mt-0.5">Registre o motivo da ausência justificada</p>
            </div>
            <button
              onClick={() => setNotesModal(null)}
              className="p-1.5 rounded-lg text-iv-muted hover:text-iv-text hover:bg-white/5 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <div className="px-5 py-4 space-y-4">
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Ex.: atestado médico, viagem, problema familiar…"
              rows={4}
              autoFocus
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-iv-text placeholder:text-iv-muted/40 resize-none focus:outline-none focus:ring-1 focus:ring-amber-400"
            />

            <div className="flex gap-3 justify-between">
              {/* FIX BUG #3b: usa handleRemoveFj que inclui manually_overridden=true,
                  guarda de janela 7 dias, rollback otimista e estado de loading */}
              <button
                onClick={() => notesModal && handleRemoveFj(notesModal.slId, notesModal.studentId)}
                disabled={removingFj}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs text-red-400 hover:bg-red-500/10 transition-colors border border-red-500/20 disabled:opacity-40"
              >
                {removingFj ? <Loader2 size={11} className="animate-spin" /> : null}
                Remover FJ
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setNotesModal(null)}
                  className="px-4 py-2 rounded-xl text-sm text-iv-muted hover:text-iv-text hover:bg-white/5 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => saveNotes(notesModal.slId, notesModal.studentId, notesDraft)}
                  disabled={savingNotes || !notesDraft.trim()}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-white text-sm font-medium transition-colors disabled:opacity-40"
                >
                  {savingNotes ? <Loader2 size={14} className="animate-spin" /> : null}
                  Salvar
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
  </>
  );
}
