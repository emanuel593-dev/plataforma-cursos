import React, { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar, Play, Square, XCircle, Clock, Video, Pencil, Trash2, Lock, Loader2,
  ArrowLeftRight, User as UserIcon, Check, X, UserCog,
} from 'lucide-react';
import {
  listScheduledLessons, updateScheduledLesson, deleteScheduledLesson,
  startLesson, endLesson, cancelLesson,
} from '../../services/schedule.service';
import { listClasses, listProfessorsByClasses } from '../../services/classes.service';
import { listClassesByMonitor } from '../../services/monitors.service';
import { listAllLessons, listLessonsByModule } from '../../services/modules.service';
import { listProfilesByRole } from '../../services/profiles.service';
import {
  createSwapRequest, listMyPendingSwaps, rejectSwap, cancelSwap,
} from '../../services/swaps.service';
import {
  directSubstitute, swapSubstitute,
} from '../../services/substitution.service';
import { emitSwapRequested, emitSwapRejected } from '../../services/events.service';
import { cacheGet, cacheSet } from '../../services/cache.service';
import type { ScheduledLesson, Class, Lesson, Profile, LessonSwapRequest } from '../../types';
import { effectiveLessonModality } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { LESSON_STATUS_LABELS, LESSON_STATUS_COLORS } from '../../lib/constants';
import {
  formatTime, toBrazilISO, nowBrazilDateInputValue, toBrazilTimeParts, dateKeyInBrazil,
} from '../../lib/utils';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import StatusBadge from '../ui/StatusBadge';
import EmptyState from '../ui/EmptyState';
import PullToRefresh from '../ui/PullToRefresh';
import PageLoader from '../ui/PageLoader';
import Button from '../ui/Button';
import { Field, TextInput, Select } from '../ui/FormField';

export default function CalendarView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [scheduled, setScheduled] = useState<ScheduledLesson[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [professors, setProfessors] = useState<Profile[]>([]);
  const [classProfMap, setClassProfMap] = useState<Record<string, string[]>>({});
  const [mySwaps, setMySwaps] = useState<LessonSwapRequest[]>([]);
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [loading, setLoading] = useState(true);

  const [editModal, setEditModal] = useState(false);
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);
  const [formClassId, setFormClassId] = useState('');
  const [formLessonId, setFormLessonId] = useState('');
  const [formProfessorId, setFormProfessorId] = useState<string>('');
  const [formDate, setFormDate] = useState('');
  const [formTime, setFormTime] = useState('19:00');
  const [formDuration, setFormDuration] = useState(60);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState<() => void>(() => {});
  const [confirmLabel, setConfirmLabel] = useState<string>('Confirmar');
  const [confirmVariant, setConfirmVariant] = useState<'danger' | 'warning'>('danger');
  const [filteredLessons, setFilteredLessons] = useState<Lesson[]>([]);
  const [dateTimeError, setDateTimeError] = useState('');

  // Swap request modal state
  const [swapModal, setSwapModal] = useState<{ lesson: ScheduledLesson } | null>(null);
  const [swapTargetId, setSwapTargetId] = useState('');
  const [swapMessage, setSwapMessage] = useState('');
  const [swapSubmitting, setSwapSubmitting] = useState(false);

  async function getAvailableLessons(classId: string, keepLessonId?: string | null): Promise<Lesson[]> {
    const cls = classes.find((c) => c.id === classId);
    if (!cls) return [];
    const ls = await listLessonsByModule(cls.module_id);
    const usedIds = scheduled
      .filter((s) => s.class_id === classId && s.lesson_id && s.lesson_id !== keepLessonId)
      .map((s) => s.lesson_id!);
    return ls.filter((l) => !usedIds.includes(l.id));
  }

  // When class changes, load only lessons from its module — excluding already-scheduled ones
  async function handleClassChange(classId: string) {
    setFormClassId(classId);
    setFormLessonId('');
    setFilteredLessons(await getAvailableLessons(classId, editingLessonId ? formLessonId : null));
  }

  // Validate date+time is in the future (Brazil official timezone)
  function validateDateTime(date: string, time: string): boolean {
    if (!date || !time) { setDateTimeError(''); return false; }
    const scheduledAtMs = new Date(toBrazilISO(date, time)).getTime();
    if (scheduledAtMs <= Date.now()) {
      setDateTimeError('Data/hora já passou. Escolha um horário futuro.');
      return false;
    }
    setDateTimeError('');
    return true;
  }

  function handleDateChange(date: string) {
    setFormDate(date);
    validateDateTime(date, formTime);
  }

  function handleTimeChange(time: string) {
    setFormTime(time);
    validateDateTime(formDate, time);
  }

  const todayStr = nowBrazilDateInputValue();
  const isDateTimeValid = formDate && formTime && new Date(toBrazilISO(formDate, formTime)).getTime() > Date.now();

  async function load() {
    try {
      // Stale-while-revalidate: hydrate from cache first for instant paint, then refresh.
      const cached = await cacheGet<ScheduledLesson[]>('schedule:all');
      if (cached && cached.length > 0) {
        setScheduled(cached.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()));
        setLoading(false);
      }
      const [sch, cls, les, profs] = await Promise.all([
        listScheduledLessons(),
        profile?.role === 'monitor' && profile?.id
          ? listClassesByMonitor(profile.id)
          : listClasses(),
        listAllLessons(),
        listProfilesByRole('professor'),
      ]);
      const sorted = sch.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
      setScheduled(sorted);
      void cacheSet('schedule:all', sorted, 5 * 60_000);
      setClasses(cls);
      setLessons(les);
      setProfessors(profs);
      const cpMap = await listProfessorsByClasses(cls.map((c) => c.id));
      setClassProfMap(cpMap);
      if (profile?.id) {
        try { setMySwaps(await listMyPendingSwaps(profile.id)); } catch { /* swap table may not be ready yet */ }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Keep persisted cache in sync with in-memory state so subsequent mutations
  // (edit/delete/start/end/cancel/swap) are reflected on next cold load.
  useEffect(() => {
    if (loading || scheduled.length === 0) return;
    void cacheSet('schedule:all', scheduled, 5 * 60_000);
  }, [scheduled, loading]);

  const classMap = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c])), [classes]);
  const lessonMap = useMemo(() => Object.fromEntries(lessons.map((l) => [l.id, l])), [lessons]);
  const profMap = useMemo(() => Object.fromEntries(professors.map((p) => [p.id, p])), [professors]);

  function classById(id: string) { return classMap[id]; }
  function lessonById(id: string | null) { return id ? lessonMap[id] : undefined; }

  /** Returns the effective professor ids for a scheduled lesson:
   *  the per-lesson assignee (if set) else all class professors via junction. */
  function effectiveProfessorIds(sl: ScheduledLesson): string[] {
    if (sl.professor_id) return [sl.professor_id];
    return classProfMap[sl.class_id] ?? [];
  }

  function professorLabel(sl: ScheduledLesson): { text: string; assigned: boolean } {
    const ids = effectiveProfessorIds(sl);
    if (ids.length === 0) return { text: 'Sem professor', assigned: false };
    const names = ids.map((id) => profMap[id]?.full_name ?? '').filter(Boolean);
    if (names.length === 0) return { text: '—', assigned: !!sl.professor_id };
    if (names.length === 1) return { text: names[0], assigned: !!sl.professor_id };
    if (names.length === 2) return { text: names.join(' · '), assigned: false };
    return { text: `${names[0]} +${names.length - 1}`, assigned: false };
  }



  async function openEdit(sl: ScheduledLesson) {
    setEditingLessonId(sl.id);
    setFormClassId(sl.class_id);
    setFormLessonId(sl.lesson_id ?? '');
    setFormProfessorId(sl.professor_id ?? '');
    const br = toBrazilTimeParts(sl.scheduled_at);
    setFormDate(br.date);
    setFormTime(br.time);
    setFormDuration(sl.duration_minutes);
    setDateTimeError('');
    setFilteredLessons(await getAvailableLessons(sl.class_id, sl.lesson_id));
    setEditModal(true);
  }



  async function handleEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingLessonId) return;

    const scheduledAt = new Date(toBrazilISO(formDate, formTime));
    if (scheduledAt.getTime() <= Date.now()) {
      showToast('Data/hora já passou. Escolha um horário futuro.', 'warning');
      return;
    }

    if (formLessonId) {
      const duplicate = scheduled.some(
        (s) => s.id !== editingLessonId && s.class_id === formClassId && s.lesson_id === formLessonId,
      );
      if (duplicate) {
        showToast('Esta aula já foi agendada para esta turma. Escolha uma aula diferente.', 'warning');
        return;
      }
    }

    setSaving(true);
    try {
      const previousProfId = scheduled.find((s) => s.id === editingLessonId)?.professor_id ?? null;
      const newProfId = formProfessorId || null;
      await updateScheduledLesson(editingLessonId, {
        lesson_id: formLessonId || null,
        scheduled_at: scheduledAt.toISOString(),
        duration_minutes: formDuration,
        professor_id: newProfId,
      });
      // Substitution side-effects (no-op if prof unchanged or newProfId is null)
      if (newProfId) {
        await directSubstitute({
          lessonId: editingLessonId,
          previousProfessorId: previousProfId,
          newProfessorId: newProfId,
          actorId: profile?.id ?? null,
          classId: formClassId,
          scheduledAt: scheduledAt.toISOString(),
          className: classMap[formClassId]?.name,
          whenLabel: `${formDate} às ${formTime}`,
        });
      }
      setScheduled((prev) =>
        prev.map((s) =>
          s.id === editingLessonId
            ? { ...s, lesson_id: formLessonId || null, scheduled_at: scheduledAt.toISOString(), duration_minutes: formDuration, professor_id: newProfId }
            : s,
        ).sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()),
      );
      setEditModal(false);
      setEditingLessonId(null);
      const substituted = previousProfId && previousProfId !== newProfId;
      showToast(substituted ? 'Substituição registrada no histórico.' : 'Agendamento atualizado.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao editar agendamento.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setConfirmTitle('Excluir Aula Agendada');
    setConfirmMsg('Excluir esta aula agendada? Alunos matriculados perderão este registro no histórico de presenças.');
    setConfirmLabel('Excluir aula');
    setConfirmVariant('danger');
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      setDeletingId(id);
      try {
        await deleteScheduledLesson(id);
        setScheduled((prev) => prev.filter((s) => s.id !== id));
        showToast('Aula excluída.', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao excluir agendamento.', 'error');
      } finally {
        setDeletingId(null);
      }
    });
    setConfirmOpen(true);
  }

  async function handleStart(id: string) {
    const lesson = scheduled.find((s) => s.id === id);
    const lessonTitle = lesson ? (lessonById(lesson.lesson_id)?.title ?? 'Aula sem título') : 'Aula';
    const slModality = lesson ? effectiveLessonModality(lesson, classById(lesson.class_id) ?? null) : 'online';
    const isPresencial = slModality === 'presencial';
    setConfirmTitle(isPresencial ? 'Iniciar aula presencial?' : 'Abrir sala da aula?');
    setConfirmMsg(
      isPresencial
        ? `A aula "${lessonTitle}" será marcada como em andamento. A presença deve ser registrada manualmente pela coordenação ou monitor da turma na tela de presenças.`
        : `A sala de "${lessonTitle}" será liberada para os alunos entrarem. ` +
          `Dentro da sala, clique em "Iniciar aula" para começar a contar o tempo de presença.`,
    );
    setConfirmLabel(isPresencial ? 'Iniciar aula' : 'Abrir sala');
    setConfirmVariant('warning');
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      try {
        const roomId = await startLesson(id);
        setScheduled((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, status: 'in_progress' as const, room_id: roomId }
              : s,
          ),
        );
        showToast('Sala aberta. Clique em "Iniciar aula" dentro da sala para começar a contar o tempo.', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao iniciar aula.', 'error');
      }
    });
    setConfirmOpen(true);
  }
  async function handleEnd(id: string) {
    try {
      await endLesson(id);
      setScheduled((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, status: 'completed' as const, ended_at: new Date().toISOString() }
            : s,
        ),
      );
      showToast('Aula encerrada.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao encerrar aula.', 'error');
    }
  }
  async function handleCancel(id: string) {
    setConfirmTitle('Cancelar Aula');
    setConfirmMsg('Cancelar esta aula? O status mudará para "Cancelada" e ela não será mais exibida como ativa.');
    setConfirmLabel('Cancelar aula');
    setConfirmVariant('warning');
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      try {
        await cancelLesson(id);
        setScheduled((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, status: 'cancelled' as const } : s,
          ),
        );
        showToast('Aula cancelada.', 'info');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao cancelar aula.', 'error');
      }
    });
    setConfirmOpen(true);
  }

  const filteredScheduled = useMemo(
    () => ((showOnlyMine && profile?.id)
      ? scheduled.filter((s) => effectiveProfessorIds(s).includes(profile.id))
      : scheduled),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduled, showOnlyMine, profile?.id, classProfMap],
  );

  const totalShown = filteredScheduled.length;
  const todayKey = nowBrazilDateInputValue();

  const canManage = profile?.role === 'coordenacao';
  const canControlLesson = profile?.role === 'coordenacao' || profile?.role === 'professor';
  const isProfessor = profile?.role === 'professor';

  // Pending swaps where I'm the target — inbox to accept/reject.
  const incomingSwaps = useMemo(
    () => mySwaps.filter((s) => s.status === 'pending' && s.target_id === profile?.id),
    [mySwaps, profile?.id],
  );

  /** Open swap-request modal for one of my own assigned lessons. */
  function openSwap(sl: ScheduledLesson) {
    setSwapModal({ lesson: sl });
    setSwapTargetId('');
    setSwapMessage('');
  }

  /** Submit a new swap request (peer-to-peer). */
  async function handleSubmitSwap(e: FormEvent) {
    e.preventDefault();
    if (!swapModal || !profile?.id || !swapTargetId) return;
    setSwapSubmitting(true);
    try {
      const created = await createSwapRequest({
        scheduled_lesson_id: swapModal.lesson.id,
        requester_id: profile.id,
        target_id: swapTargetId,
        message: swapMessage.trim() || null,
      });
      setMySwaps((prev) => [created, ...prev]);
      setSwapModal(null);
      // Best-effort push + audit to the target professor.
      await emitSwapRequested({ swap: created, requesterName: profile.full_name });
      showToast('Solicitação de troca enviada.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao enviar solicitação.', 'error');
    } finally {
      setSwapSubmitting(false);
    }
  }

  async function handleAcceptSwap(swap: LessonSwapRequest) {
    try {
      const requesterName = profMap[swap.requester_id]?.full_name ?? 'colega';
      const sl = scheduled.find((x) => x.id === swap.scheduled_lesson_id);
      const when = sl ? new Date(sl.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      const { primaryLesson, offeredLesson } = await swapSubstitute({
        swap,
        responderName: profile?.full_name,
        whenLabel: when || undefined,
      });
      setMySwaps((prev) => prev.map((s) => s.id === swap.id ? { ...s, status: 'accepted' as const, responded_at: new Date().toISOString() } : s));
      if (primaryLesson) {
        setScheduled((prev) => prev.map((s) => s.id === primaryLesson.id ? primaryLesson : s));
      }
      if (offeredLesson) {
        setScheduled((prev) => prev.map((s) => s.id === offeredLesson.id ? offeredLesson : s));
      }
      showToast(`Troca aceita. Você assumirá a aula de ${requesterName}${when ? ` em ${when}` : ''}.`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao aceitar troca.', 'error');
    }
  }

  async function handleRejectSwap(swap: LessonSwapRequest) {
    try {
      await rejectSwap(swap.id);
      setMySwaps((prev) => prev.map((s) => s.id === swap.id ? { ...s, status: 'rejected' as const, responded_at: new Date().toISOString() } : s));
      const requesterName = profMap[swap.requester_id]?.full_name ?? 'colega';
      await emitSwapRejected({ swap, responderName: profile?.full_name });
      showToast(`Solicitação de ${requesterName} recusada.`, 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao recusar troca.', 'error');
    }
  }

  async function handleCancelSwap(swap: LessonSwapRequest) {
    try {
      await cancelSwap(swap.id);
      setMySwaps((prev) => prev.filter((s) => s.id !== swap.id));
      showToast('Solicitação cancelada.', 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao cancelar solicitação.', 'error');
    }
  }

  const todayLessons = useMemo(
    () => filteredScheduled.filter((s) => dateKeyInBrazil(s.scheduled_at) === todayKey),
    [filteredScheduled, todayKey],
  );

  const upcomingLessons = useMemo(
    () => filteredScheduled.filter((s) => dateKeyInBrazil(s.scheduled_at) > todayKey),
    [filteredScheduled, todayKey],
  );

  const recentLessons = useMemo(
    () => filteredScheduled.filter((s) => dateKeyInBrazil(s.scheduled_at) < todayKey),
    [filteredScheduled, todayKey],
  );

  function groupByDay(items: ScheduledLesson[]) {
    return items.reduce<Record<string, ScheduledLesson[]>>((acc, sl) => {
      const day = dateKeyInBrazil(sl.scheduled_at);
      if (!acc[day]) acc[day] = [];
      acc[day].push(sl);
      return acc;
    }, {});
  }

  const upcomingGrouped = useMemo(() => groupByDay(upcomingLessons), [upcomingLessons]);
  const upcomingDays = useMemo(() => Object.keys(upcomingGrouped).sort(), [upcomingGrouped]);

  const recentGrouped = useMemo(() => groupByDay(recentLessons), [recentLessons]);
  const recentDays = useMemo(() => Object.keys(recentGrouped).sort().reverse().slice(0, 5), [recentGrouped]);

  function fullDayLabel(key: string) {
    if (key === todayKey) return 'Hoje';
    const d = new Date(`${key}T12:00:00`);
    return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  }

  function renderLessonCard(sl: ScheduledLesson) {
    const cl = classById(sl.class_id);
    const les = lessonById(sl.lesson_id);
    const isLive = sl.status === 'in_progress';
    const slModality = effectiveLessonModality(sl, cl ?? null);
    const isPresencial = slModality === 'presencial';
    return (
      <div
        key={sl.id}
        className={`glass-panel w-full min-w-0 overflow-hidden ${isLive ? 'border-iv-accent/40 ring-1 ring-iv-accent/20' : ''}`}
      >
        <div className="p-3 space-y-2">
          <div className="flex items-start gap-3 min-w-0">
            <div className={`flex flex-col items-center justify-center rounded-xl px-2 py-2 shrink-0 w-14 border ${
              isLive ? 'bg-iv-accent/15 border-iv-accent/40 text-iv-accent' : 'bg-white/5 border-white/8 text-iv-text'
            }`}>
              <span className="text-sm font-mono font-bold leading-none">{formatTime(sl.scheduled_at)}</span>
              <span className="text-[10px] opacity-70 mt-1 leading-none">{sl.duration_minutes}min</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-iv-text leading-snug break-words">{les?.title ?? 'Aula livre'}</p>
              <p className="text-xs text-iv-muted leading-snug break-words mt-0.5">{cl?.name ?? 'Turma'}</p>
            </div>
            {isLive && sl.room_id && !isPresencial && (
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Video size={14} />}
                onClick={() => navigate(`/sala/${sl.room_id}?aula=${sl.id}`)}
                className="shrink-0"
              >
                Entrar
              </Button>
            )}
            {isPresencial && (
              <span
                className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/20"
                title="Aula presencial — sem sala virtual"
              >
                🏛️ Presencial
              </span>
            )}
            {!isPresencial && slModality === 'hibrida' && (
              <span
                className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md bg-purple-500/15 text-purple-300 border border-purple-500/20"
                title="Aula híbrida — com sala virtual e local físico"
              >
                🔀 Híbrida
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label={LESSON_STATUS_LABELS[sl.status]} colorClass={LESSON_STATUS_COLORS[sl.status]} />
            {(() => {
              const lbl = professorLabel(sl);
              if (!lbl.text) return null;
              return (
                <span
                  className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border max-w-full min-w-0 ${
                    lbl.assigned
                      ? 'bg-iv-accent/10 text-iv-accent border-iv-accent/20'
                      : 'bg-white/5 text-iv-muted border-white/10'
                  }`}
                  title={lbl.assigned ? 'Professor designado para esta aula' : 'Professores da turma'}
                >
                  <UserIcon size={10} className="shrink-0" />
                  <span className="truncate">{lbl.text}</span>
                </span>
              );
            })()}
            {isLive && (
              <span className="inline-flex items-center gap-1 text-[10px] text-iv-accent font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-iv-accent animate-pulse" />
                AO VIVO
              </span>
            )}
          </div>
        </div>

        {canControlLesson && (sl.status === 'scheduled' || sl.status === 'in_progress') && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-2 border-t border-white/5 min-w-0">
            {sl.status === 'scheduled' && (
              <Button size="sm" variant="success" leftIcon={<Play size={14} />} onClick={() => handleStart(sl.id)} haptic="success">
                Iniciar
              </Button>
            )}
            {sl.status === 'in_progress' && (
              <Button size="sm" variant="secondary" leftIcon={<Square size={14} />} onClick={() => handleEnd(sl.id)}>
                Encerrar
              </Button>
            )}
            <div className="ml-auto flex max-w-full items-center gap-0.5 sm:max-w-none">
              {isProfessor && sl.status === 'scheduled' && sl.professor_id === profile?.id && (
                <Button size="icon" variant="ghost" onClick={() => openSwap(sl)} aria-label="Solicitar troca" title="Solicitar troca">
                  <ArrowLeftRight size={14} />
                </Button>
              )}
              {canManage && sl.status === 'scheduled' && (
                <Button size="icon" variant="ghost" onClick={() => openEdit(sl)} aria-label="Editar">
                  <Pencil size={14} />
                </Button>
              )}
              {(sl.status === 'scheduled' || sl.status === 'in_progress') && (
                <Button size="icon" variant="ghost" onClick={() => handleCancel(sl.id)} aria-label="Cancelar">
                  <XCircle size={14} />
                </Button>
              )}
              {canManage && sl.status === 'scheduled' && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleDelete(sl.id)}
                  loading={deletingId === sl.id}
                  aria-label="Excluir"
                  haptic="error"
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return <PageLoader variant="list" rows={4} />;
  }

  return (
    <PullToRefresh onRefresh={load}>
      <div className="space-y-4 min-w-0 max-w-full overflow-x-hidden">
        {/* Top header */}
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl sm:text-2xl font-bold text-iv-text">Calendário</h2>
          <span className="text-xs text-iv-muted">{totalShown} {totalShown === 1 ? 'aula' : 'aulas'}{showOnlyMine ? ' · minhas' : ''}</span>
        </div>

        {/* Pending swap inbox (only when there's incoming activity) */}
        {incomingSwaps.length > 0 && (
          <div className="glass-panel border-iv-accent/40 ring-1 ring-iv-accent/20 p-3 space-y-2">
            <div className="flex items-center gap-2 text-iv-accent text-sm font-semibold">
              <ArrowLeftRight size={16} />
              {incomingSwaps.length} solicitação(ões) de troca aguardando
            </div>
            <div className="space-y-1.5">
              {incomingSwaps.map((swap) => {
                const sl = scheduled.find((s) => s.id === swap.scheduled_lesson_id);
                const cl = sl ? classMap[sl.class_id] : null;
                const requester = profMap[swap.requester_id]?.full_name ?? 'Professor';
                return (
                  <div key={swap.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-xl bg-white/5 border border-white/8">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-iv-text truncate">
                        <span className="font-medium">{requester}</span>
                        {' → '}{cl?.name ?? 'Turma'} · {sl ? formatTime(sl.scheduled_at) : ''}
                      </p>
                      {swap.message && <p className="text-[11px] text-iv-muted truncate">“{swap.message}”</p>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="success" leftIcon={<Check size={12} />} onClick={() => {
                        const requesterName = profMap[swap.requester_id]?.full_name ?? 'colega';
                        const slx = scheduled.find((x) => x.id === swap.scheduled_lesson_id);
                        const when = slx ? new Date(slx.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
                        setConfirmTitle('Aceitar troca de aula');
                        setConfirmMsg(`Você assumirá a aula de ${requesterName}${when ? ` em ${when}` : ''}. Deseja confirmar?`);
                        setConfirmLabel('Aceitar troca');
                        setConfirmVariant('warning');
                        setConfirmAction(() => () => { setConfirmOpen(false); handleAcceptSwap(swap); });
                        setConfirmOpen(true);
                      }}>Aceitar</Button>
                      <Button size="sm" variant="ghost" leftIcon={<X size={12} />} onClick={() => handleRejectSwap(swap)}>Recusar</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Planning note only: no external calendar integration is implemented yet. */}
        <div className="glass-panel p-3 border border-white/10 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-iv-muted">Planejamento</p>
          <p className="text-xs text-iv-text/90">Integração com Google Calendar (API) mapeada para fase futura.</p>
          <p className="text-[11px] text-iv-muted">Escopo previsto: sync unidirecional de aulas e geração de lembretes. Sem implementação nesta versão.</p>
        </div>

        {/* "Minhas aulas" filter — only useful for professors. */}
        {isProfessor && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowOnlyMine((v) => !v)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors native-pressable ${
                showOnlyMine
                  ? 'bg-iv-accent text-white border-iv-accent'
                  : 'bg-white/5 text-iv-muted border-white/10 hover:border-white/20'
              }`}
              aria-pressed={showOnlyMine}
            >
              {showOnlyMine ? '✓ Minhas aulas' : 'Filtrar: Minhas aulas'}
            </button>
          </div>
        )}

        {/* Mobile-first agenda: remove horizontal day strip and focus on actionable timeline. */}
        <div className="grid grid-cols-3 gap-2">
          <div className="glass-panel p-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Hoje</p>
            <p className="text-base font-bold text-iv-text mt-0.5">{todayLessons.length}</p>
          </div>
          <div className="glass-panel p-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Próximas</p>
            <p className="text-base font-bold text-iv-text mt-0.5">{upcomingLessons.length}</p>
          </div>
          <div className="glass-panel p-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Recentes</p>
            <p className="text-base font-bold text-iv-text mt-0.5">{recentLessons.length}</p>
          </div>
        </div>

        {totalShown === 0 ? (
          <EmptyState icon={<Calendar size={32} />} title="Nenhuma aula agendada" description="Quando aulas forem agendadas, elas aparecerão aqui." />
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-widest text-iv-accent">Hoje</span>
                <div className="h-px flex-1 bg-white/8" />
                <span className="text-[10px] text-iv-muted">{todayLessons.length}</span>
              </div>
              {todayLessons.length > 0 ? (
                <div className="space-y-2 min-w-0">
                  {todayLessons.map((sl) => renderLessonCard(sl))}
                </div>
              ) : (
                <div className="glass-panel p-3 text-xs text-iv-muted">Nenhuma aula para hoje.</div>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-widest text-iv-muted">Próximas aulas</span>
                <div className="h-px flex-1 bg-white/8" />
                <span className="text-[10px] text-iv-muted">{upcomingLessons.length}</span>
              </div>
              {upcomingDays.length > 0 ? (
                upcomingDays.map((day) => (
                  <div key={day} className="space-y-2">
                    <div className="text-[11px] text-iv-muted uppercase tracking-wide">{fullDayLabel(day)}</div>
                    <div className="space-y-2 min-w-0">
                      {upcomingGrouped[day].map((sl) => renderLessonCard(sl))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="glass-panel p-3 text-xs text-iv-muted">Nenhuma aula futura no momento.</div>
              )}
            </section>

            {recentDays.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-iv-muted">Recentes</span>
                  <div className="h-px flex-1 bg-white/8" />
                  <span className="text-[10px] text-iv-muted">últimos {recentDays.length} dias</span>
                </div>
                {recentDays.map((day) => (
                  <div key={day} className="space-y-2">
                    <div className="text-[11px] text-iv-muted uppercase tracking-wide">{fullDayLabel(day)}</div>
                    <div className="space-y-2 min-w-0">
                      {recentGrouped[day].map((sl) => renderLessonCard(sl))}
                    </div>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}

        {/* Edit Modal */}
        <Modal open={editModal} onClose={() => { setEditModal(false); setEditingLessonId(null); }} title="Editar Aula Agendada">
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs">
              <Clock size={12} className="shrink-0" />
              Fuso: <span className="font-medium">Brasília (America/Sao_Paulo)</span>
            </div>
            <Field label="Turma">
              <div className="w-full px-3 py-2.5 rounded-xl bg-iv-bg/40 border border-white/10 text-sm flex items-center gap-2">
                <Lock size={13} className="text-iv-muted/50 shrink-0" />
                <span className="text-iv-text flex-1 truncate">{classes.find((c) => c.id === formClassId)?.name ?? '—'}</span>
                <span className="text-xs text-iv-muted/50 italic shrink-0">somente leitura</span>
              </div>
            </Field>
            <Field label="Aula (opcional)">
              <Select value={formLessonId} onChange={(e) => setFormLessonId(e.target.value)}>
                <option value="">Nenhuma (aula livre)</option>
                {filteredLessons.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
              </Select>
            </Field>
            {/* Coordination-only: per-lesson professor assignment / emergency substitution. */}
            {canManage && (
              <Field label="Professor designado (substituição)">
                <Select value={formProfessorId} onChange={(e) => setFormProfessorId(e.target.value)}>
                  <option value="">— Sem assignee específico (qualquer prof. da turma)</option>
                  {(() => {
                    // Prefer the class's roster of professors at the top, then any other professor
                    // (so coord can substitute with someone outside the regular roster).
                    const roster = classProfMap[formClassId] ?? [];
                    const inRoster = professors.filter((p) => roster.includes(p.id));
                    const others = professors.filter((p) => !roster.includes(p.id));
                    return (
                      <>
                        {inRoster.length > 0 && <optgroup label="Professores da turma">{inRoster.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</optgroup>}
                        {others.length > 0 && <optgroup label="Outros professores">{others.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</optgroup>}
                      </>
                    );
                  })()}
                </Select>
                <p className="text-[11px] text-iv-muted/70 mt-1.5">
                  Trocar o professor aqui registra a mudança no histórico automático (substituição) e dispara push notification.
                </p>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Data">
                <TextInput type="date" value={formDate} onChange={(e) => handleDateChange(e.target.value)} min={todayStr} required />
              </Field>
              <Field label="Horário">
                <TextInput type="time" value={formTime} onChange={(e) => handleTimeChange(e.target.value)} required />
              </Field>
            </div>
            <Field label="Duração (minutos)">
              <TextInput type="number" value={formDuration} onChange={(e) => setFormDuration(Number(e.target.value) || 60)} min={15} max={240} step={15} />
            </Field>
            {dateTimeError && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-xl">{dateTimeError}</p>
            )}
            <Button type="submit" loading={saving} disabled={!isDateTimeValid} fullWidth haptic="success">Salvar</Button>
          </form>
        </Modal>

        <ConfirmModal open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={confirmAction} title={confirmTitle} message={confirmMsg} confirmLabel={confirmLabel} variant={confirmVariant} />

        {/* Swap-request modal (peer-to-peer between professors) */}
        <Modal open={!!swapModal} onClose={() => setSwapModal(null)} title="Solicitar troca de aula">
          {swapModal && (() => {
            const sl = swapModal.lesson;
            const cl = classMap[sl.class_id];
            // Targets: other professors assigned to the same class (junction).
            const candidateIds = (classProfMap[sl.class_id] ?? []).filter((id) => id !== profile?.id);
            const candidates = professors.filter((p) => candidateIds.includes(p.id));
            return (
              <form onSubmit={handleSubmitSwap} className="space-y-4">
                <div className="px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 text-xs text-iv-muted space-y-0.5">
                  <p className="text-iv-text font-medium">{lessonById(sl.lesson_id)?.title ?? 'Aula livre'}</p>
                  <p>{cl?.name ?? 'Turma'} · {formatTime(sl.scheduled_at)} · {sl.duration_minutes}min</p>
                </div>
                <Field label="Solicitar para" required>
                  <Select value={swapTargetId} onChange={(e) => setSwapTargetId(e.target.value)} required>
                    <option value="">Selecione um professor da turma</option>
                    {candidates.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                  </Select>
                  {candidates.length === 0 && (
                    <p className="text-[11px] text-amber-300/80 mt-1.5">
                      Nenhum outro professor está vinculado à turma. Peça à coordenação para adicionar mais professores antes de solicitar uma troca.
                    </p>
                  )}
                </Field>
                <Field label="Mensagem (opcional)">
                  <textarea
                    value={swapMessage}
                    onChange={(e) => setSwapMessage(e.target.value)}
                    rows={3}
                    maxLength={300}
                    placeholder="Ex.: Tenho consulta médica nesse horário. Pode cobrir?"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-iv-text placeholder:text-iv-muted/50 focus:outline-none focus:border-iv-accent/50 resize-none"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" loading={swapSubmitting} disabled={!swapTargetId} fullWidth haptic="success" leftIcon={<ArrowLeftRight size={14} />}>Enviar solicitação</Button>
                  <Button type="button" variant="ghost" onClick={() => setSwapModal(null)} fullWidth>Cancelar</Button>
                </div>
                {/* Requester also sees their own outgoing pending swaps for this lesson. */}
                {(() => {
                  const outgoing = mySwaps.filter((s) => s.scheduled_lesson_id === sl.id && s.requester_id === profile?.id && s.status === 'pending');
                  if (outgoing.length === 0) return null;
                  return (
                    <div className="pt-2 border-t border-white/5 space-y-1.5">
                      <p className="text-[11px] uppercase tracking-wide text-iv-muted">Solicitações pendentes para esta aula</p>
                      {outgoing.map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-iv-muted">para <span className="text-iv-text">{profMap[s.target_id]?.full_name ?? '—'}</span></span>
                          <Button size="sm" variant="ghost" onClick={() => handleCancelSwap(s)}>Cancelar</Button>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </form>
            );
          })()}
        </Modal>
      </div>
    </PullToRefresh>
  );
}

