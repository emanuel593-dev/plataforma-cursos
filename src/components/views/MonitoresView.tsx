import React, { useEffect, useMemo, useState } from 'react';
import { UserCheck, Plus, Mail, Trash2, Users, BookOpen, Pencil, Search } from 'lucide-react';
import type { Profile, Class } from '../../types';
import { listProfilesByRole } from '../../services/profiles.service';
import { createMonitorAccount, updateManagedAccount, deleteManagedAccount } from '../../services/auth.service';
import { listClasses } from '../../services/classes.service';
import {
  listMonitorsByClasses,
  addMonitorToClass,
  removeMonitorFromClass,
} from '../../services/monitors.service';
import { authHeaders } from '../../lib/apiAuth';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import EmptyState from '../ui/EmptyState';
import StatusBadge from '../ui/StatusBadge';
import Button from '../ui/Button';
import PageLoader from '../ui/PageLoader';
import PullToRefresh from '../ui/PullToRefresh';
import { Field, TextInput, Select } from '../ui/FormField';
import { ROLE_COLORS } from '../../lib/constants';
import { useToast } from '../../contexts/ToastContext';
import { friendlyError } from '../../lib/utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePassword(length = 10): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#';
  let pw = '';
  for (let i = 0; i < length; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MonitoresView() {
  const [monitors, setMonitors] = useState<Profile[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [error, setError] = useState('');

  // Create form
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState<string>(generatePassword);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');

  // Assign form
  const [selectedClassId, setSelectedClassId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editError, setEditError] = useState('');
  const { showToast } = useToast();
  const [search, setSearch] = useState('');

  // Confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);

  // Map classId → array of assigned monitors (N:N).
  const [classMonMap, setClassMonMap] = useState<Record<string, string[]>>({});
  const monitorClassesMap = useMemo(() => {
    const out: Record<string, Class[]> = {};
    for (const cls of classes) {
      const monIds = classMonMap[cls.id] ?? [];
      for (const mid of monIds) (out[mid] ??= []).push(cls);
    }
    return out;
  }, [classes, classMonMap]);

  async function load() {
    setLoading(true);
    try {
      const [mons, cls] = await Promise.all([
        listProfilesByRole('monitor'),
        listClasses(),
      ]);
      setMonitors(mons);
      setClasses(cls);
      const map = await listMonitorsByClasses(cls.map((c) => c.id));
      setClassMonMap(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreateSuccess('');
    setCreating(true);
    try {
      const newUser = await createMonitorAccount(email.trim(), fullName.trim(), generatedPassword);

      const newProfile: Profile = {
        id: newUser.id,
        email: newUser.email,
        full_name: fullName.trim(),
        avatar_url: null,
        role: 'monitor',
        phone: null,
        must_change_password: true,
        is_managed_only: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setMonitors((prev) => [...prev, newProfile]);

      try {
        const res = await fetch('/api/invite', {
          method: 'POST',
          headers: await authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ email: email.trim(), fullName: fullName.trim(), password: generatedPassword }),
        });
        const data = await res.json() as { emailSent?: boolean; error?: string };
        if (data.emailSent) {
          setCreateSuccess(`Conta criada! As credenciais de acesso foram enviadas para ${email}.`);
        } else {
          setCreateSuccess(`Conta criada com sucesso! Não foi possível enviar o e-mail automaticamente — anote a senha gerada e repasse manualmente.`);
        }
      } catch {
        setCreateSuccess(`Conta criada com sucesso! Servidor de e-mail indisponível — anote a senha gerada e repasse manualmente.`);
      }

      setFullName('');
      setEmail('');
      setGeneratedPassword(generatePassword());
    } catch (e) {
      setCreateError(friendlyError(e, 'Erro ao criar conta.'));
    } finally {
      setCreating(false);
    }
  }

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !selectedClassId) return;
    setAssigning(true);
    try {
      await addMonitorToClass(selectedClassId, selected.id);
      setClassMonMap((prev) => {
        const next = { ...prev };
        const arr = next[selectedClassId] ? [...next[selectedClassId]] : [];
        if (!arr.includes(selected.id)) arr.push(selected.id);
        next[selectedClassId] = arr;
        return next;
      });
      setAssignModalOpen(false);
      setSelected(null);
      setSelectedClassId('');
      showToast('Turma atribuída ao monitor.', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao atribuir turma.', 'error');
    } finally {
      setAssigning(false);
    }
  }

  async function handleUnassign(mon: Profile, cls: Class) {
    try {
      await removeMonitorFromClass(cls.id, mon.id);
      setClassMonMap((prev) => {
        const next = { ...prev };
        next[cls.id] = (next[cls.id] || []).filter((id) => id !== mon.id);
        return next;
      });
      showToast(`${mon.full_name} removido(a) de ${cls.name}.`, 'info');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao remover atribuição.', 'error');
    }
  }

  function openEdit(mon: Profile) {
    setSelected(mon);
    setEditName(mon.full_name);
    setEditEmail(mon.email ?? '');
    setEditError('');
    setEditModalOpen(true);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setEditing(true);
    setEditError('');
    try {
      await updateManagedAccount(selected.id, {
        full_name: editName,
        email: editEmail,
      });
      setMonitors((prev) => prev.map((p) =>
        p.id === selected.id
          ? { ...p, full_name: editName, email: editEmail, updated_at: new Date().toISOString() }
          : p,
      ));
      setEditModalOpen(false);
      setSelected(null);
      showToast('Monitor atualizado.', 'success');
    } catch (e) {
      setEditError(friendlyError(e, 'Erro ao editar monitor.'));
    } finally {
      setEditing(false);
    }
  }

  async function handleDelete(mon: Profile) {
    const assignedClasses = (monitorClassesMap[mon.id] ?? []).map((c) => c.name).join(', ');
    const impact = assignedClasses ? ` As turmas "${assignedClasses}" perderão este monitor.` : '';
    setConfirmTitle('Excluir Monitor');
    setConfirmMsg(`Excluir monitor ${mon.full_name}? Esta ação remove a conta permanentemente.${impact}`);
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      setDeletingId(mon.id);
      try {
        const classToUnassign = monitorClassesMap[mon.id] ?? [];
        for (const cls of classToUnassign) {
          await removeMonitorFromClass(cls.id, mon.id);
        }
        await deleteManagedAccount(mon.id);
        setMonitors((prev) => prev.filter((p) => p.id !== mon.id));
        setClassMonMap((prev) => {
          const next: Record<string, string[]> = {};
          for (const [cid, ids] of Object.entries(prev)) next[cid] = ids.filter((id) => id !== mon.id);
          return next;
        });
        showToast('Monitor excluído.', 'success');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Erro ao excluir monitor.', 'error');
      } finally {
        setDeletingId(null);
      }
    });
    setConfirmOpen(true);
  }

  return (
    <>
    <PullToRefresh onRefresh={load}>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-bold text-iv-text">Monitores</h2>
          <p className="text-xs sm:text-sm text-iv-muted mt-0.5">Monitores acompanham aulas, marcam presença e moderam o chat das turmas atribuídas.</p>
        </div>
        <Button leftIcon={<Plus size={16} />} onClick={() => { setGeneratedPassword(generatePassword()); setModalOpen(true); }} className="shrink-0">
          Novo monitor
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
      )}

      {loading ? (
        <PageLoader variant="list" rows={5} />
      ) : monitors.length === 0 ? (
        <EmptyState icon={<UserCheck size={32} />} title="Nenhum monitor" description="Crie credenciais para os monitores das turmas." />
      ) : (
        <>
          {monitors.length > 0 && (
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-iv-muted/60 pointer-events-none z-10" />
              <TextInput
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome ou e-mail..."
                className="pl-9"
              />
            </div>
          )}
          {(() => {
            const q = search.toLowerCase();
            const filtered = q ? monitors.filter((p) => p.full_name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q)) : monitors;
            return filtered.length === 0 ? (
              <p className="text-sm text-iv-muted text-center py-6">Nenhum monitor encontrado para "{search}".</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((mon) => {
                  const assignedClasses = monitorClassesMap[mon.id] ?? [];
                  return (
              <div key={mon.id} className="glass-panel p-3 sm:p-4 space-y-3">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center font-bold">
                    {mon.full_name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-iv-text truncate">{mon.full_name}</p>
                    <p className="text-xs text-iv-muted truncate">{mon.email}</p>
                  </div>
                  <StatusBadge label="Monitor" colorClass={ROLE_COLORS.monitor} />
                </div>
                <div className="text-xs text-iv-muted space-y-1.5">
                  {assignedClasses.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {assignedClasses.map((cls) => (
                        <span key={cls.id} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <BookOpen size={11} />
                          <span className="font-medium">{cls.name}</span>
                          <button
                            type="button"
                            onClick={() => handleUnassign(mon, cls)}
                            className="ml-1 -mr-0.5 hover:text-red-400 transition-colors"
                            aria-label={`Remover ${mon.full_name} de ${cls.name}`}
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-iv-muted/60">Sem turmas atribuídas</span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => { setSelected(mon); setSelectedClassId(''); setAssignModalOpen(true); }}
                    aria-label="Atribuir turma"
                    className="min-h-[44px]"
                  >
                    <Users size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => openEdit(mon)}
                    aria-label="Editar monitor"
                    className="min-h-[44px]"
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => handleDelete(mon)}
                    loading={deletingId === mon.id}
                    aria-label="Excluir monitor"
                    haptic="error"
                    className="min-h-[44px]"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
                  );
                })}
              </div>
            );
          })()}
        </>
      )}

      {/* Create monitor modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setCreateError(''); setCreateSuccess(''); }}
        title="Novo monitor"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Field label="Nome completo">
            <TextInput
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              maxLength={100}
              placeholder="Nome do monitor"
            />
          </Field>
          <Field label="E-mail">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="monitor@email.com"
            />
          </Field>
          <p className="text-[11px] text-iv-muted/60 flex items-center gap-1"><Mail size={11} /> Uma senha temporária será gerada e enviada por e-mail. O monitor deve alterá-la no primeiro acesso.</p>
          {createError && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{createError}</div>}
          {createSuccess && <div className="px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">{createSuccess}</div>}
          {!createSuccess && (
            <Button type="submit" loading={creating} fullWidth leftIcon={<Plus size={16} />} haptic="success">
              Criar conta e enviar convite
            </Button>
          )}
        </form>
      </Modal>

      {/* Edit monitor modal */}
      <Modal
        open={editModalOpen}
        onClose={() => { setEditModalOpen(false); setSelected(null); setEditError(''); }}
        title={`Editar monitor — ${selected?.full_name ?? ''}`}
      >
        <form onSubmit={handleEdit} className="space-y-4">
          <Field label="Nome completo">
            <TextInput
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
              maxLength={100}
            />
          </Field>
          <Field label="E-mail">
            <TextInput
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              required
            />
          </Field>
          {editError && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{editError}</div>}
          <Button type="submit" loading={editing} fullWidth leftIcon={<Pencil size={16} />} haptic="success">
            Salvar alterações
          </Button>
        </form>
      </Modal>

      {/* Assign class modal */}
      <Modal
        open={assignModalOpen}
        onClose={() => { setAssignModalOpen(false); setSelected(null); setSelectedClassId(''); }}
        title={`Atribuir turma — ${selected?.full_name ?? ''}`}
      >
        <form onSubmit={handleAssign} className="space-y-4">
          <Field label="Turma">
            <Select
              value={selectedClassId}
              onChange={(e) => setSelectedClassId(e.target.value)}
              required
            >
              <option value="">Selecione uma turma</option>
              {classes
                .filter((c) => !(classMonMap[c.id] ?? []).includes(selected?.id ?? ''))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </Select>
          </Field>
          <p className="text-[11px] text-iv-muted/70">Cada turma aceita múltiplos monitores. Esta ação adiciona o monitor à turma sem remover os demais.</p>
          <div className="flex gap-3">
            <Button type="submit" loading={assigning} fullWidth haptic="success">Adicionar</Button>
            <Button type="button" variant="ghost" onClick={() => { setAssignModalOpen(false); }} fullWidth>Cancelar</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => confirmAction?.()}
        title={confirmTitle}
        message={confirmMsg}
        confirmLabel="Excluir"
        variant="danger"
      />
    </div>
    </PullToRefresh>
    </>
  );
}
