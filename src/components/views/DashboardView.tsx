import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ROLE_LABELS } from '../../lib/constants';
import { Calendar, Users, BookOpen, TrendingUp, Video, Clock, Megaphone, Pin, CheckCircle2, ClipboardCheck, Pencil, Trash2 } from 'lucide-react';
import { listModules } from '../../services/modules.service';
import { listClasses, listEnrollmentsByStudent, listClassesByProfessor } from '../../services/classes.service';
import { listClassesByMonitor } from '../../services/monitors.service';
import { listUpcoming } from '../../services/schedule.service';
import { getStudentStats, type AttendanceStats } from '../../services/attendance.service';
import { countByRole } from '../../services/profiles.service';
import { createAnnouncement, updateAnnouncement, deleteAnnouncement, listVisibleAnnouncements, markAnnouncementRead, getUserReadSet } from '../../services/announcements.service';
import type { Module, Class, ScheduledLesson, Announcement } from '../../types';
import { effectiveLessonModality } from '../../types';
import { formatDateTime } from '../../lib/utils';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import PageLoader from '../ui/PageLoader';
import { Field, TextInput, Textarea, Select } from '../ui/FormField';
import CoordinationExceptionsPanel from './CoordinationExceptionsPanel';

export default function DashboardView() {
  const { profile, user } = useAuth();
  const { showToast } = useToast();
  const role = profile?.role ?? 'aluno';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightedAvisoId = searchParams.get('aviso');
  const canCreateAnnouncements = role === 'coordenacao' || role === 'professor';

  const [loading, setLoading] = useState(true);
  const [modules, setModules] = useState<Module[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [upcoming, setUpcoming] = useState<ScheduledLesson[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementClasses, setAnnouncementClasses] = useState<Class[]>([]);
  const [stats, setStats] = useState<AttendanceStats | null>(null);
  const [roleCounts, setRoleCounts] = useState({ coordenacao: 0, professor: 0, aluno: 0 });
  const [myClassCount, setMyClassCount] = useState(0);
  const [isAnnouncementModalOpen, setIsAnnouncementModalOpen] = useState(false);
  const [announcementTitle, setAnnouncementTitle] = useState('');
  const [announcementContent, setAnnouncementContent] = useState('');
  const [announcementClassId, setAnnouncementClassId] = useState('');
  const [announcementExpiresAt, setAnnouncementExpiresAt] = useState('');
  const [announcementPinned, setAnnouncementPinned] = useState(false);
  const [creatingAnnouncement, setCreatingAnnouncement] = useState(false);
  const [userReadSet, setUserReadSet] = useState<Set<string>>(new Set());
  const [editingAnn, setEditingAnn] = useState<Announcement | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [editPinned, setEditPinned] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingAnnId, setDeletingAnnId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function resetAnnouncementForm() {
    setAnnouncementTitle('');
    setAnnouncementContent('');
    setAnnouncementClassId('');
    setAnnouncementExpiresAt('');
    setAnnouncementPinned(false);
  }

  async function reloadAnnouncements() {
    const items = await listVisibleAnnouncements(5);
    setAnnouncements(items);
    return items;
  }

  async function handleCreateAnnouncement(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (role === 'professor' && !announcementClassId) {
      showToast('Selecione a turma para publicar o aviso.', 'warning');
      return;
    }

    setCreatingAnnouncement(true);
    try {
      const newAnn = await createAnnouncement({
        author_id: user.id,
        class_id: announcementClassId || null,
        title: announcementTitle.trim(),
        content: announcementContent.trim(),
        is_pinned: announcementPinned,
        expires_at: announcementExpiresAt ? new Date(announcementExpiresAt).toISOString() : null,
      });
      setAnnouncements(prev => {
        const updated = [newAnn, ...prev];
        // Keep pinned on top, then by date, max 5
        updated.sort((a, b) => {
          if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
        return updated.slice(0, 5);
      });
      setIsAnnouncementModalOpen(false);
      resetAnnouncementForm();
      showToast('Aviso publicado com sucesso.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Falha ao publicar aviso.', 'error');
    } finally {
      setCreatingAnnouncement(false);
    }
  }

  function openEditAnn(item: Announcement) {
    setEditingAnn(item);
    setEditTitle(item.title);
    setEditContent(item.content);
    setEditExpiresAt(item.expires_at ? new Date(item.expires_at).toISOString().slice(0, 16) : '');
    setEditPinned(item.is_pinned);
  }

  async function handleEditAnn(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAnn) return;
    setSavingEdit(true);
    try {
      await updateAnnouncement(editingAnn.id, {
        title: editTitle.trim(),
        content: editContent.trim(),
        is_pinned: editPinned,
        expires_at: editExpiresAt ? new Date(editExpiresAt).toISOString() : null,
      });
      setAnnouncements(prev => prev.map(a =>
        a.id === editingAnn.id
          ? { ...a, title: editTitle.trim(), content: editContent.trim(), is_pinned: editPinned, expires_at: editExpiresAt ? new Date(editExpiresAt).toISOString() : null }
          : a,
      ));
      setEditingAnn(null);
      showToast('Aviso atualizado.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao editar aviso.', 'error');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteAnn(id: string) {
    setDeletingAnnId(id);
    try {
      await deleteAnnouncement(id);
      setAnnouncements(prev => prev.filter(a => a.id !== id));
      setConfirmDeleteId(null);
      showToast('Aviso removido.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao remover aviso.', 'error');
    } finally {
      setDeletingAnnId(null);
    }
  }

  function setExpiresPreset(days: number, setter: (v: string) => void) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    setter(d.toISOString().slice(0, 16));
  }

  async function handleMarkRead(announcementId: string) {
    if (!user) return;
    setUserReadSet(prev => new Set(prev).add(announcementId));
    try {
      await markAnnouncementRead(announcementId, user.id);
    } catch {
      setUserReadSet(prev => {
        const next = new Set(prev);
        next.delete(announcementId);
        return next;
      });
    }
  }

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const [mods, cls] = await Promise.all([
          listModules(),
          listClasses(),
        ]);
        if (!isMounted) return;
        setModules(mods);
        setClasses(cls);
        const anns = await reloadAnnouncements();
        if (!isMounted) return;

        if (user) {
          // Load which announcements the user already read
          if (anns.length > 0) {
            const readSet = await getUserReadSet(user.id, anns.map(a => a.id));
            if (isMounted) setUserReadSet(readSet);
          }
          if (role === 'aluno') {
            const [st, enrollments] = await Promise.all([
              getStudentStats(user.id),
              listEnrollmentsByStudent(user.id),
            ]);
            if (!isMounted) return;
            setStats(st);
            const activeEnrolls = enrollments.filter((e) => e.status === 'active');
            setMyClassCount(activeEnrolls.length);
            
            const classIds = activeEnrolls.map((e) => e.class_id);
            const up = await listUpcoming(5, classIds);
            if (isMounted) setUpcoming(up);
          } else if (role === 'professor') {
            const myCls = await listClassesByProfessor(user.id);
            if (!isMounted) return;
            setMyClassCount(myCls.length);
            setAnnouncementClasses(myCls);
            
            const classIds = myCls.map((c) => c.id);
            const up = await listUpcoming(5, classIds);
            if (isMounted) setUpcoming(up);
          } else if (role === 'monitor') {
            const myCls = await listClassesByMonitor(user.id);
            if (!isMounted) return;
            setMyClassCount(myCls.length);
            const classIds = myCls.map((c) => c.id);
            const up = await listUpcoming(5, classIds);
            if (isMounted) setUpcoming(up);
          } else {
            const [up, rc] = await Promise.all([listUpcoming(5), countByRole()]);
            if (!isMounted) return;
            setUpcoming(up);
            setRoleCounts(rc);
            setAnnouncementClasses(cls);
          }
        }
      } catch (err) {
        console.error('Dashboard load error:', err);
        if (isMounted) showToast(err instanceof Error ? err.message : 'Erro ao carregar dashboard.', 'error');
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    load();
    return () => { isMounted = false; };
  }, [user, role]);

  if (loading) {
    return <PageLoader variant="list" rows={3} />;
  }

  const activeClasses = classes.filter((c) => c.status === 'active').length;

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-iv-text">
          Olá, {profile?.full_name?.split(' ')[0] ?? 'Usuário'} 👋
        </h2>
        <p className="text-xs sm:text-sm text-iv-muted mt-1">
          {ROLE_LABELS[role]} · Bem-vindo ao LMS Education Platform
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <StatCard icon={<Calendar size={18} />} label="Próximas Aulas" value={String(upcoming.length)} />
        {role === 'aluno' && (
          <StatCard icon={<TrendingUp size={18} />} label="Frequência" value={stats ? `${stats.percentage}%` : '—'} />
        )}
        {role === 'coordenacao' && (
          <StatCard icon={<Users size={18} />} label="Total Alunos" value={String(roleCounts.aluno)} />
        )}
        {role !== 'aluno' && (
          <StatCard icon={<Users size={18} />} label="Turmas Ativas" value={String(role === 'professor' ? myClassCount : activeClasses)} />
        )}
        {role === 'aluno' && (
          <StatCard icon={<Users size={18} />} label="Minhas Turmas" value={String(myClassCount)} />
        )}
        <StatCard icon={<BookOpen size={18} />} label="Módulos" value={String(modules.length)} />
        {role === 'coordenacao' && (
          <StatCard icon={<Users size={18} />} label="Professores" value={String(roleCounts.professor)} />
        )}
      </div>

      {/* Painel de Exceções (coordenação) — Frentes B + C */}
      {role === 'coordenacao' && <CoordinationExceptionsPanel />}

      {/* Announcements */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h3 className="text-sm font-semibold text-iv-muted uppercase tracking-wider">Avisos</h3>
          {canCreateAnnouncements && (
            <Button
              size="sm"
              onClick={() => setIsAnnouncementModalOpen(true)}
              leftIcon={<Megaphone size={14} />}
            >
              <span className="hidden sm:inline">Novo aviso</span><span className="sm:hidden">Novo</span>
            </Button>
          )}
        </div>
        {announcements.length === 0 ? (
          <div className="glass-panel p-6 text-center">
            <p className="text-sm text-iv-muted">Nenhum aviso recente.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {announcements.map((item) => {
              const cls = item.class_id ? classes.find((c) => c.id === item.class_id) : null;
              const isHighlighted = highlightedAvisoId === item.id;
              return (
                <div
                  key={item.id}
                  id={`aviso-${item.id}`}
                  ref={(el) => {
                    if (el && isHighlighted) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      // Clear the param after highlighting so refresh doesn't keep scrolling
                      window.setTimeout(() => {
                        setSearchParams((prev) => {
                          const next = new URLSearchParams(prev);
                          next.delete('aviso');
                          return next;
                        }, { replace: true });
                      }, 1200);
                    }
                  }}
                  className={`glass-panel p-4 space-y-2 transition-all ${
                    isHighlighted ? 'ring-2 ring-iv-accent/60 shadow-lg shadow-iv-accent/20' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-iv-text flex items-center gap-2 min-w-0">
                        <span className="truncate">{item.title}</span>
                        {item.is_pinned && <Pin size={12} className="text-amber-400" />}
                        {item.expires_at && (
                          <span className="text-[10px] text-iv-muted/60 shrink-0">
                            exp. {new Date(item.expires_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-iv-muted mt-0.5">
                        {cls ? `Turma: ${cls.name}` : 'Aviso geral'} · {formatDateTime(item.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {canCreateAnnouncements && (
                        <>
                          <button
                            onClick={() => openEditAnn(item)}
                            className="p-1.5 rounded-lg text-iv-muted hover:text-iv-text hover:bg-white/10 transition-colors"
                            title="Editar aviso"
                          >
                            <Pencil size={13} />
                          </button>
                          {confirmDeleteId === item.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1 rounded-lg text-xs text-iv-muted hover:bg-white/10 transition-colors"
                              >
                                Cancelar
                              </button>
                              <button
                                onClick={() => handleDeleteAnn(item.id)}
                                disabled={deletingAnnId === item.id}
                                className="px-2 py-1 rounded-lg text-xs text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors border border-red-500/20"
                              >
                                {deletingAnnId === item.id ? '…' : 'Confirmar'}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteId(item.id)}
                              className="p-1.5 rounded-lg text-iv-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              title="Remover aviso"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </>
                      )}
                      {userReadSet.has(item.id) ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400 pl-1">
                          <CheckCircle2 size={14} /> Lido
                        </span>
                      ) : (
                        <button
                          onClick={() => handleMarkRead(item.id)}
                          className="flex items-center gap-1 px-2 py-2 sm:py-1 rounded-lg text-xs text-iv-muted hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors touch-target sm:min-h-0 sm:min-w-0"
                        >
                          <CheckCircle2 size={14} /> Marcar lido
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-iv-muted leading-relaxed">{item.content}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upcoming lessons */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-iv-muted uppercase tracking-wider">Próximas Aulas</h3>
        {upcoming.length === 0 ? (
          <div className="glass-panel p-6 text-center">
            <p className="text-sm text-iv-muted">Nenhuma aula agendada.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {upcoming.map((sl) => {
              const cls = classes.find((c) => c.id === sl.class_id);
              const mod = modules.find((m) => m.id === cls?.module_id);
              const slModality = effectiveLessonModality(sl, cls ?? null);
              const isPresencial = slModality === 'presencial';
              return (
                <div key={sl.id} className="glass-panel p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{ backgroundColor: mod ? `${mod.color}20` : undefined }}
                    >
                      <Video size={18} style={{ color: mod?.color || '#6366f1' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-iv-text truncate">
                        {cls?.name || 'Turma'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-iv-muted mt-1">
                        <span className="inline-flex items-center gap-1"><Clock size={12} /> {formatDateTime(sl.scheduled_at)}</span>
                        <span>· {sl.duration_minutes}min</span>
                        {slModality !== 'online' && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${
                            slModality === 'presencial'
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/20'
                              : 'bg-purple-500/15 text-purple-300 border-purple-500/20'
                          }`}>
                            {slModality === 'presencial' ? '🏛️ Presencial' : '🔀 Híbrida'}
                          </span>
                        )}
                      </div>
                    </div>
                    {sl.status === 'in_progress' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                        Ao vivo
                      </span>
                    )}
                  </div>
                  {sl.status === 'in_progress' && sl.room_id && !isPresencial && (
                    <Button
                      onClick={() => navigate(`/sala/${sl.room_id}?aula=${sl.id}`)}
                      size="sm"
                      leftIcon={<Video size={14} />}
                      fullWidth
                      className="sm:w-auto"
                    >
                      Entrar na aula
                    </Button>
                  )}
                  {isPresencial && (
                    <p className="text-[11px] text-amber-300/80 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      🏛️ Aula presencial — presença registrada manualmente.
                    </p>
                  )}
                  {isPresencial && (role === 'coordenacao' || role === 'monitor') && (
                    <Button
                      onClick={() => navigate(`/presencas?aula=${sl.id}`)}
                      size="sm"
                      leftIcon={<ClipboardCheck size={14} />}
                      fullWidth
                      className="sm:w-auto"
                    >
                      Fazer chamada
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Module overview */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-iv-muted uppercase tracking-wider">Módulos</h3>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((mod) => (
            <div
              key={mod.id}
              className="glass-panel p-4 border-l-4 space-y-1"
              style={{ borderLeftColor: mod.color }}
            >
              <h4 className="text-sm font-semibold text-iv-text">{mod.name}</h4>
              {mod.description && (
                <p className="text-xs text-iv-muted">{mod.description}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Edit announcement modal */}
      <Modal
        open={!!editingAnn}
        onClose={() => { if (!savingEdit) setEditingAnn(null); }}
        title="Editar aviso"
        maxWidth="max-w-lg"
      >
        <form className="space-y-3" onSubmit={handleEditAnn}>
          <Field label="Título" required>
            <TextInput
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              required
              maxLength={120}
            />
          </Field>
          <Field label="Mensagem" required>
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              required
              rows={4}
              maxLength={1000}
            />
          </Field>
          <Field label="Expiração (opcional)">
            <TextInput
              type="datetime-local"
              value={editExpiresAt}
              onChange={(e) => setEditExpiresAt(e.target.value)}
              className="[color-scheme:dark]"
            />
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setExpiresPreset(d, setEditExpiresAt)}
                  className="px-2 py-0.5 rounded text-[11px] bg-white/5 hover:bg-white/10 text-iv-muted border border-white/10 transition-colors"
                >
                  {d} dias
                </button>
              ))}
              {editExpiresAt && (
                <button
                  type="button"
                  onClick={() => setEditExpiresAt('')}
                  className="px-2 py-0.5 rounded text-[11px] bg-white/5 hover:bg-white/10 text-iv-muted border border-white/10 transition-colors"
                >
                  Sem prazo
                </button>
              )}
            </div>
          </Field>
          <label className="inline-flex items-center gap-2 text-sm text-iv-muted">
            <input
              type="checkbox"
              checked={editPinned}
              onChange={(e) => setEditPinned(e.target.checked)}
              className="rounded border-white/10 bg-iv-bg"
            />
            Fixar este aviso no topo
          </label>
          <Button type="submit" loading={savingEdit} fullWidth haptic="success">
            {savingEdit ? 'Salvando...' : 'Salvar alterações'}
          </Button>
        </form>
      </Modal>

      <Modal
        open={isAnnouncementModalOpen}
        onClose={() => {
          if (!creatingAnnouncement) {
            setIsAnnouncementModalOpen(false);
            resetAnnouncementForm();
          }
        }}
        title="Novo aviso"
        maxWidth="max-w-lg"
      >
        <form className="space-y-3" onSubmit={handleCreateAnnouncement}>
          <Field label="Título" required>
            <TextInput
              value={announcementTitle}
              onChange={(e) => setAnnouncementTitle(e.target.value)}
              required
              maxLength={120}
              placeholder="Ex.: Mudança de horário da aula"
            />
          </Field>

          <Field label="Mensagem" required>
            <Textarea
              value={announcementContent}
              onChange={(e) => setAnnouncementContent(e.target.value)}
              required
              rows={4}
              maxLength={1000}
              placeholder="Escreva o aviso para os alunos e professores."
            />
          </Field>

          <Field label="Turma" required={role === 'professor'}>
            <Select
              value={announcementClassId}
              onChange={(e) => setAnnouncementClassId(e.target.value)}
              required={role === 'professor'}
            >
              <option value="" disabled={role === 'professor'}>
                {role === 'coordenacao' ? 'Aviso geral (todas as turmas)' : 'Selecione uma turma...'}
              </option>
              {announcementClasses.map((cls) => (
                <option key={cls.id} value={cls.id}>{cls.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="Expiração (opcional)">
            <TextInput
              type="datetime-local"
              value={announcementExpiresAt}
              onChange={(e) => setAnnouncementExpiresAt(e.target.value)}
              className="[color-scheme:dark]"
            />
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setExpiresPreset(d, setAnnouncementExpiresAt)}
                  className="px-2 py-0.5 rounded text-[11px] bg-white/5 hover:bg-white/10 text-iv-muted border border-white/10 transition-colors"
                >
                  {d} dias
                </button>
              ))}
              {announcementExpiresAt && (
                <button
                  type="button"
                  onClick={() => setAnnouncementExpiresAt('')}
                  className="px-2 py-0.5 rounded text-[11px] bg-white/5 hover:bg-white/10 text-iv-muted border border-white/10 transition-colors"
                >
                  Sem prazo
                </button>
              )}
            </div>
          </Field>

          <label className="inline-flex items-center gap-2 text-sm text-iv-muted">
            <input
              type="checkbox"
              checked={announcementPinned}
              onChange={(e) => setAnnouncementPinned(e.target.checked)}
              className="rounded border-white/10 bg-iv-bg"
            />
            Fixar este aviso no topo
          </label>

          <Button type="submit" loading={creatingAnnouncement} fullWidth haptic="success">
            {creatingAnnouncement ? 'Publicando...' : 'Publicar aviso'}
          </Button>
        </form>
      </Modal>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="glass-panel p-4 sm:p-4 space-y-2">
      <div className="text-iv-muted">{icon}</div>
      <p className="text-[13px] sm:text-xs text-iv-muted">{label}</p>
      <p className="text-base sm:text-lg font-bold text-iv-text">{value}</p>
    </div>
  );
}
