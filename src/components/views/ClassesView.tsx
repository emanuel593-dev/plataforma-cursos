import React, { useEffect, useState, type FormEvent } from 'react';
import {
  Users, Plus, Pencil, Trash2,
  Loader2, ChevronRight, AlertCircle,
} from 'lucide-react';
import {
  listClasses, createClass, updateClass, deleteClass,
  listEnrollmentsByClass, createEnrollment, deleteEnrollment,
  countEnrollmentsByClasses,
  listProfessorsByClasses, listProfessorsOfClass, setClassProfessors,
} from '../../services/classes.service';
import { listClassesByMonitor } from '../../services/monitors.service';
import { listManagedProfessors } from '../../services/managed.service';
import { listModules } from '../../services/modules.service';
import { listProfilesByRole } from '../../services/profiles.service';
import type { Class, Module, Profile, ClassStatus, ClassModality } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useNavigate } from 'react-router-dom';
import { CLASS_STATUS_LABELS, CLASS_STATUS_COLORS } from '../../lib/constants';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import StatusBadge from '../ui/StatusBadge';
import EmptyState from '../ui/EmptyState';
import Button from '../ui/Button';
import PullToRefresh from '../ui/PullToRefresh';
import PageLoader from '../ui/PageLoader';
import { Field, TextInput, Select } from '../ui/FormField';

export default function ClassesView() {
  const { profile, user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [classes, setClasses] = useState<Class[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [professors, setProfessors] = useState<Profile[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Class form modal
  const [classModal, setClassModal] = useState(false);
  const [editingClass, setEditingClass] = useState<Class | null>(null);
  const [className, setClassName] = useState('');
  const [classModuleId, setClassModuleId] = useState('');
  const [classProfIds, setClassProfIds] = useState<string[]>([]);
  const [classStatus, setClassStatus] = useState<ClassStatus>('active');
  const [classModality, setClassModality] = useState<ClassModality>('online');
  const [classLocation, setClassLocation] = useState('');
  const [showManagedProfs, setShowManagedProfs] = useState(false);
  const [saving, setSaving] = useState(false);
  // junction map: class_id → [professor_id]
  const [classProfMap, setClassProfMap] = useState<Record<string, string[]>>({});

  // Enroll modal
  const [enrollModal, setEnrollModal] = useState(false);
  const [enrollClassId, setEnrollClassId] = useState('');
  const [enrollStudentId, setEnrollStudentId] = useState('');

  // Confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState<() => void>(() => {});

  async function load() {
    try {
      // Monitor sees only classes they are assigned to (junction-scoped).
      // Coord/professor see the full list (RLS = true on classes).
      const isMonitor = profile?.role === 'monitor';
      const [cls, mods, profs, managedProfs, studs] = await Promise.all([
        isMonitor && user ? listClassesByMonitor(user.id) : listClasses(),
        listModules(),
        listProfilesByRole('professor'),
        listManagedProfessors().catch(() => [] as Profile[]),
        listProfilesByRole('aluno'),
      ]);
      setClasses(cls);
      setModules(mods);
      // Merge real professors + managed professors (deduped by id).
      const merged = new Map<string, Profile>();
      [...profs, ...managedProfs].forEach((p) => merged.set(p.id, p));
      setProfessors(Array.from(merged.values()));
      setStudents(studs);

      // Single batch query instead of N+1 per-class calls
      const c = await countEnrollmentsByClasses(cls.map((cl) => cl.id));
      setCounts(c);
      const profMap = await listProfessorsByClasses(cls.map((cl) => cl.id));
      setClassProfMap(profMap);
      setLoadError(null);
    } catch (err) {
      console.error(err);
      setLoadError(err instanceof Error ? err.message : 'Erro ao carregar turmas.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function moduleName(id: string) {
    return modules.find((m) => m.id === id)?.name ?? '—';
  }
  function moduleColor(id: string) {
    return modules.find((m) => m.id === id)?.color ?? '#6366f1';
  }
  function profNames(classId: string): string {
    const ids = classProfMap[classId] ?? [];
    if (ids.length === 0) return 'Sem professor';
    const names = ids
      .map((id) => professors.find((p) => p.id === id)?.full_name)
      .filter(Boolean) as string[];
    if (names.length === 0) return '—';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names.join(', ');
    return `${names[0]} +${names.length - 1}`;
  }

  // Expand enrollments
  async function toggleExpand(id: string) {
    navigate(`/turmas/${id}`);
  }

  // Class CRUD
  function openCreate() {
    setEditingClass(null);
    setClassName('');
    setClassModuleId(modules[0]?.id ?? '');
    setClassProfIds([]);
    setClassStatus('active');
    setClassModality('online');
    setClassLocation('');
    setShowManagedProfs(false);
    setClassModal(true);
  }
  async function openEdit(cl: Class) {
    setEditingClass(cl);
    setClassName(cl.name);
    setClassModuleId(cl.module_id);
    setClassStatus(cl.status);
    setClassModality(cl.modality);
    setClassLocation(cl.location ?? '');
    setShowManagedProfs(cl.modality !== 'online');
    // Load current assignments from junction.
    setClassProfIds(classProfMap[cl.id] ?? []);
    setClassModal(true);
    try {
      const fresh = await listProfessorsOfClass(cl.id);
      setClassProfIds(fresh);
      setClassProfMap((prev) => ({ ...prev, [cl.id]: fresh }));
    } catch { /* keep optimistic */ }
  }

  async function handleSaveClass(e: FormEvent) {
    e.preventDefault();
    // Pre-validation: presencial/híbrida exigem >=1 professor.
    if (classModality !== 'online' && classProfIds.length === 0) {
      showToast(
        `Turmas ${classModality === 'presencial' ? 'presenciais' : 'híbridas'} exigem ao menos 1 professor vinculado.`,
        'error',
      );
      return;
    }
    const trimmedLocation = classLocation.trim() || null;
    setSaving(true);
    try {
      if (editingClass) {
        const updates = {
          name: className.trim(),
          module_id: classModuleId,
          status: classStatus,
          modality: classModality,
          location: trimmedLocation,
        };
        // Trigger AFTER UPDATE OF modality precisa ver >=1 prof: garantimos
        // sincronizando os professores ANTES do updateClass quando a
        // modalidade muda para presencial/híbrida.
        if (classModality !== 'online') {
          await setClassProfessors(editingClass.id, classProfIds);
          await updateClass(editingClass.id, updates);
        } else {
          await updateClass(editingClass.id, updates);
          await setClassProfessors(editingClass.id, classProfIds);
        }
        setClasses(prev => prev.map(c => c.id === editingClass.id ? { ...c, ...updates } : c));
        setClassProfMap(prev => ({ ...prev, [editingClass.id]: [...classProfIds] }));
      } else {
        // Cria sempre como 'online' primeiro (default seguro), vincula
        // professores, depois faz UPDATE para modalidade real — nesse momento
        // o trigger valida que há >=1 professor.
        const newCls = await createClass({
          name: className.trim(),
          module_id: classModuleId,
          modality: 'online',
          location: null,
        });
        if (classProfIds.length > 0) {
          await setClassProfessors(newCls.id, classProfIds);
        }
        if (classModality !== 'online' || trimmedLocation) {
          await updateClass(newCls.id, {
            modality: classModality,
            location: trimmedLocation,
          });
          newCls.modality = classModality;
          newCls.location = trimmedLocation;
        }
        setClasses(prev => [newCls, ...prev]);
        setCounts(prev => ({ ...prev, [newCls.id]: 0 }));
        setClassProfMap(prev => ({ ...prev, [newCls.id]: [...classProfIds] }));
      }
      setClassModal(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar turma.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setConfirmTitle('Excluir Turma');
    setConfirmMsg('Excluir esta turma e todas as matrículas associadas? Esta ação não pode ser desfeita.');
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      await deleteClass(id);
      setClasses(prev => prev.filter(c => c.id !== id));
      setCounts(prev => { const next = { ...prev }; delete next[id]; return next; });
    });
    setConfirmOpen(true);
  }

  // Enrollment
  function openEnroll(classId: string) {
    setEnrollClassId(classId);
    setEnrollStudentId(students[0]?.id ?? '');
    setEnrollModal(true);
  }

  async function handleEnroll(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await createEnrollment({ class_id: enrollClassId, student_id: enrollStudentId, status: 'active' });
      setEnrollModal(false);
      // Refresh enrollment count for this class
      const enrs = await listEnrollmentsByClass(enrollClassId);
      setCounts((prev) => ({ ...prev, [enrollClassId]: enrs.length }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao matricular.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveEnrollment(enrollmentId: string, classId: string) {
    setConfirmTitle('Remover Matrícula');
    setConfirmMsg('Remover esta matrícula? O aluno será desassociado da turma.');
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      await deleteEnrollment(enrollmentId);
      const enrs = await listEnrollmentsByClass(classId);
      setCounts((prev) => ({ ...prev, [classId]: enrs.length }));
    });
    setConfirmOpen(true);
  }

  if (loading) {
    return <PageLoader variant="list" rows={4} />;
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <AlertCircle size={32} className="text-red-400" />
        <p className="text-iv-muted text-sm">{loadError}</p>
        <Button variant="secondary" size="sm" onClick={load}>Tentar novamente</Button>
      </div>
    );
  }

  const activeCount = classes.filter((c) => c.status === 'active').length;
  const totalEnrollments = Object.values(counts).reduce((acc, n) => acc + n, 0);

  return (
    <PullToRefresh onRefresh={load}>
    <div className="space-y-4 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
      <div className="glass-panel p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-iv-muted">Gestao de Turmas</p>
            <h2 className="text-lg sm:text-xl font-bold text-iv-text leading-tight break-words">Turmas</h2>
          </div>
          {profile?.role === 'coordenacao' && (
            <Button onClick={openCreate} leftIcon={<Plus size={16} />} className="shrink-0 w-full sm:w-auto">
              Nova Turma
            </Button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Total</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{classes.length}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Ativas</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{activeCount}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Alunos</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{totalEnrollments}</p>
          </div>
        </div>
      </div>

      {classes.length === 0 ? (
        <EmptyState icon={<Users size={32} />} title="Nenhuma turma" description="Crie a primeira turma para começar." />
      ) : (
        <div className="space-y-3">
          {classes.map((cl) => {
            return (
              <div key={cl.id} className="glass-panel overflow-hidden native-pressable w-full min-w-0">
                <div
                  className="flex items-start gap-3 p-3.5 sm:p-4 cursor-pointer min-w-0"
                  onClick={() => toggleExpand(cl.id)}
                >
                  <div className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: moduleColor(cl.module_id) }} />
                  <div className="flex-1 min-w-0">
                    {/* Row 1: name + actions */}
                    <div className="flex items-start gap-2 min-w-0">
                      <h3 className="text-base sm:text-sm font-semibold text-iv-text flex-1 leading-snug break-words">{cl.name}</h3>
                      <div className="flex items-center gap-1 shrink-0">
                        {profile?.role === 'coordenacao' && (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); openEdit(cl); }} className="p-2 sm:p-1.5 rounded-lg text-iv-muted hover:text-iv-accent hover:bg-iv-accent/10 transition-colors touch-target sm:min-h-0 sm:min-w-0" title="Editar"><Pencil size={16} className="sm:w-3.5 sm:h-3.5" /></button>
                            <button onClick={(e) => { e.stopPropagation(); handleDelete(cl.id); }} className="p-2 sm:p-1.5 rounded-lg text-iv-muted hover:text-red-400 hover:bg-red-500/10 transition-colors touch-target sm:min-h-0 sm:min-w-0" title="Excluir"><Trash2 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
                          </>
                        )}
                        <ChevronRight size={16} className="text-iv-muted" />
                      </div>
                    </div>
                    {/* Row 2: metadata */}
                    <div className="flex items-center gap-1.5 sm:gap-2 mt-2 flex-wrap min-w-0">
                      <span className="text-[11px] sm:text-xs text-iv-muted break-words px-2 py-1 rounded-lg bg-white/5 border border-white/8 max-w-full">{moduleName(cl.module_id)}</span>
                      <span className="text-[11px] sm:text-xs text-iv-muted break-words px-2 py-1 rounded-lg bg-white/5 border border-white/8 max-w-full">{profNames(cl.id)}</span>
                      <span className="text-[11px] sm:text-xs text-iv-muted shrink-0 px-2 py-1 rounded-lg bg-white/5 border border-white/8">{counts[cl.id] ?? 0} alunos</span>
                      {(() => {
                        const m = cl.modality ?? 'online';
                        const cfg = {
                          online:     { label: '🟢 Online',     cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
                          presencial: { label: '🏛️ Presencial', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
                          hibrida:    { label: '🔀 Híbrida',    cls: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
                        }[m];
                        return (
                          <span className={`text-[11px] sm:text-xs shrink-0 px-2 py-1 rounded-lg border ${cfg.cls}`}>
                            {cfg.label}
                          </span>
                        );
                      })()}
                      {cl.location && (
                        <span className="text-[11px] sm:text-xs text-iv-muted break-words px-2 py-1 rounded-lg bg-white/5 border border-white/8 max-w-full" title={cl.location}>
                          📍 {cl.location}
                        </span>
                      )}
                      <StatusBadge label={CLASS_STATUS_LABELS[cl.status]} colorClass={CLASS_STATUS_COLORS[cl.status]} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Class Modal */}
      <Modal open={classModal} onClose={() => setClassModal(false)} title={editingClass ? 'Editar Turma' : 'Nova Turma'} maxWidth="max-w-lg">
        <form onSubmit={handleSaveClass} className="space-y-4">
          <Field label="Nome" required>
            <TextInput value={className} onChange={(e) => setClassName(e.target.value)} required maxLength={100} />
          </Field>
          <Field label="Módulo" required>
            <Select value={classModuleId} onChange={(e) => setClassModuleId(e.target.value)}>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>

          {/* Modalidade — radio group mobile-first (botões grandes, touch-friendly) */}
          <Field label="Modalidade" required>
            <div className="grid grid-cols-3 gap-2">
              {(['online', 'presencial', 'hibrida'] as ClassModality[]).map((m) => {
                const active = classModality === m;
                const labels: Record<ClassModality, string> = {
                  online: 'Online',
                  presencial: 'Presencial',
                  hibrida: 'Híbrida',
                };
                const icons: Record<ClassModality, string> = {
                  online: '🟢',
                  presencial: '🏛️',
                  hibrida: '🔀',
                };
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setClassModality(m);
                      if (m !== 'online') setShowManagedProfs(true);
                    }}
                    className={`flex flex-col items-center gap-1 px-2 py-3 rounded-xl border text-xs font-medium transition-all touch-target ${
                      active
                        ? 'border-iv-accent bg-iv-accent/15 text-iv-accent'
                        : 'border-white/10 bg-white/3 text-iv-muted hover:bg-white/5 hover:text-iv-text'
                    }`}
                    aria-pressed={active}
                  >
                    <span className="text-lg leading-none" aria-hidden="true">{icons[m]}</span>
                    <span>{labels[m]}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-iv-muted/70 mt-1.5">
              {classModality === 'online' && 'Sala virtual com WebRTC, presença automática.'}
              {classModality === 'presencial' && 'Aulas físicas. Presença feita pelo monitor/coordenação.'}
              {classModality === 'hibrida' && 'Mistura aulas online e presenciais — define modalidade ao agendar cada aula.'}
            </p>
          </Field>

          {/* Local físico — apenas presencial/híbrida */}
          {classModality !== 'online' && (
            <Field label="Local" hint="Endereço, sala ou referência (ex.: Templo Sede - Sala 3).">
              <TextInput
                value={classLocation}
                onChange={(e) => setClassLocation(e.target.value)}
                maxLength={200}
                placeholder="Templo Sede - Sala 3"
              />
            </Field>
          )}

          <Field label={classModality === 'online' ? 'Professores' : 'Professores *'}>
            {/* Toggle managed visibility — útil em presencial/híbrida */}
            {classModality !== 'online' && (
              <label className="flex items-center gap-2 mb-2 text-[11px] text-iv-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showManagedProfs}
                  onChange={(e) => setShowManagedProfs(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-iv-accent"
                />
                Mostrar professores presenciais (sem login)
              </label>
            )}
            <div className="max-h-48 overflow-y-auto rounded-xl border border-white/8 bg-white/3 divide-y divide-white/5">
              {(() => {
                const visibleProfs = professors.filter((p) =>
                  showManagedProfs || p.is_managed_only === false,
                );
                if (visibleProfs.length === 0) {
                  return <p className="p-3 text-xs text-iv-muted/70">
                    {showManagedProfs
                      ? 'Nenhum professor cadastrado. Cadastre em "Professores".'
                      : 'Nenhum professor real cadastrado. Marque a opção acima para incluir presenciais.'}
                  </p>;
                }
                return visibleProfs.map((p) => {
                  const checked = classProfIds.includes(p.id);
                  return (
                    <label key={p.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/3 transition-colors touch-target">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setClassProfIds((prev) => e.target.checked
                            ? [...new Set([...prev, p.id])]
                            : prev.filter((id) => id !== p.id));
                        }}
                        className="w-4 h-4 rounded accent-iv-accent"
                      />
                      <span className="text-sm text-iv-text flex-1 truncate">{p.full_name}</span>
                      {p.is_managed_only && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20 shrink-0">
                          presencial
                        </span>
                      )}
                    </label>
                  );
                });
              })()}
            </div>
            <p className="text-[11px] text-iv-muted/70 mt-1.5">
              {classModality === 'online'
                ? 'Selecione um ou mais professores. As aulas específicas podem ser atribuídas individualmente depois.'
                : 'Pelo menos 1 professor é obrigatório para turmas presenciais e híbridas.'}
            </p>
          </Field>

          {editingClass && (
            <Field label="Status">
              <Select value={classStatus} onChange={(e) => setClassStatus(e.target.value as ClassStatus)}>
                <option value="active">Ativa</option>
                <option value="completed">Concluída</option>
                <option value="cancelled">Cancelada</option>
              </Select>
            </Field>
          )}
          <Button type="submit" loading={saving} fullWidth haptic="success">
            {editingClass ? 'Salvar' : 'Criar'}
          </Button>
        </form>
      </Modal>

      {/* Enroll Modal */}
      <Modal open={enrollModal} onClose={() => setEnrollModal(false)} title="Matricular Aluno">
        <form onSubmit={handleEnroll} className="space-y-4">
          <Field label="Aluno" required>
            <Select value={enrollStudentId} onChange={(e) => setEnrollStudentId(e.target.value)}>
              {students.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.email})</option>)}
            </Select>
          </Field>
          <Button type="submit" loading={saving} fullWidth haptic="success">
            Matricular
          </Button>
        </form>
      </Modal>

      <ConfirmModal open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={confirmAction} title={confirmTitle} message={confirmMsg} />
    </div>
    </PullToRefresh>
  );
}
