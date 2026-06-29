import React, { useEffect, useState, type FormEvent } from 'react';
import {
  BookOpen, Plus, Pencil, Trash2, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  listModules, createModule, updateModule, deleteModule,
  listLessonsByModule, createLesson, updateLesson, deleteLesson,
} from '../../services/modules.service';
import type { Module, Lesson } from '../../types';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import EmptyState from '../ui/EmptyState';
import Button from '../ui/Button';
import FAB from '../ui/FAB';
import PageLoader from '../ui/PageLoader';
import PullToRefresh from '../ui/PullToRefresh';
import { Field, TextInput } from '../ui/FormField';

export default function ModulesView() {
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lessons, setLessons] = useState<Record<string, Lesson[]>>({});

  // Module modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState<() => void>(() => {});
  const [moduleModal, setModuleModal] = useState(false);
  const [editingModule, setEditingModule] = useState<Module | null>(null);
  const [modName, setModName] = useState('');
  const [modDesc, setModDesc] = useState('');
  const [modColor, setModColor] = useState('#6366f1');
  const [modOrder, setModOrder] = useState(1);
  const [saving, setSaving] = useState(false);

  // Lesson modal
  const [lessonModal, setLessonModal] = useState(false);
  const [lessonModuleId, setLessonModuleId] = useState('');
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [lessonTitle, setLessonTitle] = useState('');
  const [lessonDesc, setLessonDesc] = useState('');
  const [lessonOrder, setLessonOrder] = useState(1);

  async function load() {
    try {
      const mods = await listModules();
      setModules(mods);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!lessons[id]) {
      const ls = await listLessonsByModule(id);
      setLessons((prev) => ({ ...prev, [id]: ls }));
    }
  }

  // Module CRUD
  function openCreateModule() {
    setEditingModule(null);
    setModName('');
    setModDesc('');
    setModColor('#6366f1');
    setModOrder(modules.length + 1);
    setModuleModal(true);
  }

  function openEditModule(mod: Module) {
    setEditingModule(mod);
    setModName(mod.name);
    setModDesc(mod.description || '');
    setModColor(mod.color);
    setModOrder(mod.order_index);
    setModuleModal(true);
  }

  async function handleSaveModule(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingModule) {
        const updates = {
          name: modName.trim(),
          description: modDesc.trim() || null,
          color: modColor,
          order_index: modOrder,
        };
        await updateModule(editingModule.id, updates);
        setModules(prev => prev.map(m => m.id === editingModule.id ? { ...m, ...updates } : m).sort((a, b) => a.order_index - b.order_index));
      } else {
        const newMod = await createModule({
          name: modName.trim(),
          description: modDesc.trim() || null,
          color: modColor,
          order_index: modOrder,
        });
        setModules(prev => [...prev, newMod].sort((a, b) => a.order_index - b.order_index));
      }
      setModuleModal(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao salvar módulo.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteModule(id: string) {
    setConfirmTitle('Excluir Módulo');
    setConfirmMsg('Excluir este módulo e todas as suas aulas? Esta ação não pode ser desfeita.');
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      await deleteModule(id);
      setModules(prev => prev.filter(m => m.id !== id));
      setLessons((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });
    setConfirmOpen(true);
  }

  // Lesson CRUD
  function openCreateLesson(moduleId: string) {
    setLessonModuleId(moduleId);
    setEditingLesson(null);
    setLessonTitle('');
    setLessonDesc('');
    const current = lessons[moduleId] || [];
    setLessonOrder(current.length + 1);
    setLessonModal(true);
  }

  function openEditLesson(lesson: Lesson) {
    setLessonModuleId(lesson.module_id);
    setEditingLesson(lesson);
    setLessonTitle(lesson.title);
    setLessonDesc(lesson.description || '');
    setLessonOrder(lesson.order_index);
    setLessonModal(true);
  }

  async function handleSaveLesson(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingLesson) {
        await updateLesson(editingLesson.id, {
          title: lessonTitle.trim(),
          description: lessonDesc.trim() || null,
          order_index: lessonOrder,
        });
      } else {
        await createLesson({
          module_id: lessonModuleId,
          title: lessonTitle.trim(),
          description: lessonDesc.trim() || null,
          order_index: lessonOrder,
        });
      }
      setLessonModal(false);
      const ls = await listLessonsByModule(lessonModuleId);
      setLessons((prev) => ({ ...prev, [lessonModuleId]: ls }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao salvar aula.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLesson(lesson: Lesson) {
    setConfirmTitle('Excluir Aula');
    setConfirmMsg(`Excluir a aula "${lesson.title}"? Esta ação não pode ser desfeita.`);
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      await deleteLesson(lesson.id);
      const ls = await listLessonsByModule(lesson.module_id);
      setLessons((prev) => ({ ...prev, [lesson.module_id]: ls }));
    });
    setConfirmOpen(true);
  }

  if (loading) {
    return <PageLoader variant="list" rows={4} />;
  }

  return (
    <>
    <PullToRefresh onRefresh={load}>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h2 className="text-lg sm:text-xl font-bold text-iv-text">Módulos & Aulas</h2>
        <Button leftIcon={<Plus size={16} />} onClick={openCreateModule} className="hidden sm:inline-flex">
          Novo Módulo
        </Button>
      </div>

      {modules.length === 0 ? (
        <EmptyState icon={<BookOpen size={32} />} title="Nenhum módulo" description="Crie o primeiro módulo do curso." />
      ) : (
        <div className="space-y-3">
          {modules.map((mod) => {
            const isExpanded = expandedId === mod.id;
            const modLessons = lessons[mod.id] || [];
            return (
              <div key={mod.id} className="glass-panel overflow-hidden">
                {/* Header */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer hover:bg-white/3 transition-colors"
                  onClick={() => toggleExpand(mod.id)}
                >
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${mod.color}20` }}
                  >
                    <BookOpen size={18} style={{ color: mod.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-iv-text">{mod.name}</h3>
                    {mod.description && (
                      <p className="text-xs text-iv-muted truncate">{mod.description}</p>
                    )}
                  </div>
                  <span className="text-xs text-iv-muted shrink-0">
                    {modLessons.length || '…'} aulas
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={(e) => { e.stopPropagation(); openEditModule(mod); }}
                      aria-label="Editar módulo"
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={(e) => { e.stopPropagation(); handleDeleteModule(mod.id); }}
                      aria-label="Excluir módulo"
                      haptic="error"
                      className="text-iv-muted hover:!text-red-400"
                    >
                      <Trash2 size={14} />
                    </Button>
                    {isExpanded ? <ChevronDown size={16} className="text-iv-muted" /> : <ChevronRight size={16} className="text-iv-muted" />}
                  </div>
                </div>

                {/* Lessons list */}
                {isExpanded && (
                  <div className="border-t border-white/5">
                    {modLessons.length === 0 ? (
                      <p className="text-xs text-iv-muted text-center py-4">Nenhuma aula neste módulo.</p>
                    ) : (
                      <div className="divide-y divide-white/5">
                        {modLessons.map((lesson) => (
                          <div key={lesson.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/3 transition-colors">
                            <span className="w-6 text-center text-xs font-mono text-iv-muted">{lesson.order_index}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-iv-text truncate">{lesson.title}</p>
                              {lesson.description && (
                                <p className="text-xs text-iv-muted truncate">{lesson.description}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => openEditLesson(lesson)}
                                aria-label="Editar aula"
                              >
                                <Pencil size={12} />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDeleteLesson(lesson)}
                                aria-label="Excluir aula"
                                haptic="error"
                                className="text-iv-muted hover:!text-red-400"
                              >
                                <Trash2 size={12} />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="px-4 py-3 border-t border-white/5">
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Plus size={14} />}
                        onClick={() => openCreateLesson(mod.id)}
                        className="!text-iv-accent"
                      >
                        Adicionar aula
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Module Modal */}
      <Modal open={moduleModal} onClose={() => setModuleModal(false)} title={editingModule ? 'Editar Módulo' : 'Novo Módulo'}>
        <form onSubmit={handleSaveModule} className="space-y-4">
          <Field label="Nome">
            <TextInput value={modName} onChange={(e) => setModName(e.target.value)} required />
          </Field>
          <Field label="Descrição">
            <TextInput value={modDesc} onChange={(e) => setModDesc(e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Cor">
              <input type="color" value={modColor} onChange={(e) => setModColor(e.target.value)} className="w-full h-11 rounded-xl bg-iv-bg border border-white/10 cursor-pointer" />
            </Field>
            <Field label="Ordem">
              <TextInput type="number" value={String(modOrder)} onChange={(e) => setModOrder(Number(e.target.value) || 1)} />
            </Field>
          </div>
          <Button type="submit" loading={saving} fullWidth haptic="success">{editingModule ? 'Salvar' : 'Criar'}</Button>
        </form>
      </Modal>

      {/* Lesson Modal */}
      <Modal open={lessonModal} onClose={() => setLessonModal(false)} title={editingLesson ? 'Editar Aula' : 'Nova Aula'}>
        <form onSubmit={handleSaveLesson} className="space-y-4">
          <Field label="Título">
            <TextInput value={lessonTitle} onChange={(e) => setLessonTitle(e.target.value)} required />
          </Field>
          <Field label="Descrição">
            <TextInput value={lessonDesc} onChange={(e) => setLessonDesc(e.target.value)} />
          </Field>
          <Field label="Ordem">
            <TextInput type="number" value={String(lessonOrder)} onChange={(e) => setLessonOrder(Number(e.target.value) || 1)} />
          </Field>
          <Button type="submit" loading={saving} fullWidth haptic="success">{editingLesson ? 'Salvar' : 'Criar'}</Button>
        </form>
      </Modal>

      <ConfirmModal open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={confirmAction} title={confirmTitle} message={confirmMsg} />
    </div>
    </PullToRefresh>
    <FAB icon={<Plus size={22} />} label="Novo módulo" onClick={openCreateModule} />
    </>
  );
}
