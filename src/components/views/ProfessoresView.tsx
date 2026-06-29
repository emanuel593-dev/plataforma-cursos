import React, { useEffect, useMemo, useState } from 'react';
import { UserCheck, Plus, Mail, Trash2, Users, BookOpen, Pencil, Search } from 'lucide-react';
import type { Profile } from '../../types';
import { listProfilesByRole } from '../../services/profiles.service';
import { createProfessorAccount, updateManagedAccount, deleteManagedAccount } from '../../services/auth.service';
import { createManagedProfessor, updateManagedProfile, deleteManagedProfile, promoteManagedToReal } from '../../services/managed.service';
import { listClasses, listProfessorsByClasses, addProfessorToClass, removeProfessorFromClass } from '../../services/classes.service';
import { authHeaders } from '../../lib/apiAuth';
import type { Class } from '../../types';
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

export default function ProfessoresView() {
  const [professors, setProfessors] = useState<Profile[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedProfessor, setSelectedProfessor] = useState<Profile | null>(null);
  const [error, setError] = useState('');

  // Create form
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState<string>(generatePassword);
  /** Quando true, cria perfil presencial sem login (is_managed_only=true). */
  const [createManaged, setCreateManaged] = useState(false);
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

  // Promote managed → real account
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<Profile | null>(null);
  const [promoteEmail, setPromoteEmail] = useState('');
  const [promoteSendInvite, setPromoteSendInvite] = useState(true);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');

  // Map professorId → array of assigned classes (N:N via junction).
  const [classProfMap, setClassProfMap] = useState<Record<string, string[]>>({});
  const professorClassesMap = useMemo(() => {
    const out: Record<string, Class[]> = {};
    for (const cls of classes) {
      const profIds = classProfMap[cls.id] ?? [];
      for (const pid of profIds) (out[pid] ??= []).push(cls);
    }
    return out;
  }, [classes, classProfMap]);

  async function load() {
    setLoading(true);
    try {
      const [profs, cls] = await Promise.all([
        listProfilesByRole('professor'),
        listClasses(),
      ]);
      setProfessors(profs);
      setClasses(cls);
      const map = await listProfessorsByClasses(cls.map((c) => c.id));
      setClassProfMap(map);
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
      if (createManaged) {
        // Professor presencial — sem login.
        const managed = await createManagedProfessor({
          full_name: fullName.trim(),
          phone: phone.trim() || null,
        });
        const newProfile: Profile = {
          id: managed.id,
          email: null,
          full_name: fullName.trim(),
          avatar_url: null,
          role: 'professor',
          phone: phone.trim() || null,
          must_change_password: false,
          is_managed_only: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setProfessors((prev) => [...prev, newProfile]);
        setCreateSuccess('Professor presencial cadastrado. Sem necessidade de login.');
        setFullName('');
        setPhone('');
        return;
      }

      const newUser = await createProfessorAccount(email.trim(), fullName.trim(), generatedPassword);

      // Optimistic update — add to local state immediately
      const newProfile: Profile = {
        id: newUser.id,
        email: newUser.email,
        full_name: fullName.trim(),
        avatar_url: null,
        role: 'professor',
        phone: null,
        must_change_password: true,
        is_managed_only: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setProfessors((prev) => [...prev, newProfile]);

      // Send invite email via server
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
      const msg = friendlyError(e, 'Erro ao criar conta.');
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProfessor || !selectedClassId) return;
    setAssigning(true);
    try {
      await addProfessorToClass(selectedClassId, selectedProfessor.id);
      // Optimistic update — patch the junction map locally.
      setClassProfMap((prev) => {
        const next = { ...prev };
        const arr = next[selectedClassId] ? [...next[selectedClassId]] : [];
        if (!arr.includes(selectedProfessor.id)) arr.push(selectedProfessor.id);
        next[selectedClassId] = arr;
        return next;
      });
      setAssignModalOpen(false);
      setSelectedProfessor(null);
      setSelectedClassId('');
      showToast('Turma atribuída com sucesso.', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao atribuir turma.', 'error');
    } finally {
      setAssigning(false);
    }
  }

  async function handleUnassign(prof: Profile, cls: Class) {
    try {
      await removeProfessorFromClass(cls.id, prof.id);
      setClassProfMap((prev) => {
        const next = { ...prev };
        next[cls.id] = (next[cls.id] || []).filter((id) => id !== prof.id);
        return next;
      });
      showToast(`${prof.full_name} removido(a) de ${cls.name}.`, 'info');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao remover atribuição.', 'error');
    }
  }

  function openEdit(prof: Profile) {
    setSelectedProfessor(prof);
    setEditName(prof.full_name);
    setEditEmail(prof.email ?? '');
    setEditError('');
    setEditModalOpen(true);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProfessor) return;
    setEditing(true);
    setEditError('');
    try {
      if (selectedProfessor.is_managed_only) {
        await updateManagedProfile(selectedProfessor.id, {
          full_name: editName,
        });
      } else {
        await updateManagedAccount(selectedProfessor.id, {
          full_name: editName,
          email: editEmail,
        });
      }
      // Optimistic update — patch professor in local state
      setProfessors((prev) => prev.map((p) =>
        p.id === selectedProfessor.id
          ? {
              ...p,
              full_name: editName,
              email: selectedProfessor.is_managed_only ? p.email : editEmail,
              updated_at: new Date().toISOString(),
            }
          : p,
      ));
      setEditModalOpen(false);
      setSelectedProfessor(null);
      showToast('Professor atualizado.', 'success');
    } catch (e) {
      setEditError(friendlyError(e, 'Erro ao editar professor.'));
    } finally {
      setEditing(false);
    }
  }

  async function handleDelete(prof: Profile) {
    const assignedClasses = (professorClassesMap[prof.id] ?? []).map((c) => c.name).join(', ');
    const impact = assignedClasses ? ` As turmas "${assignedClasses}" perderão este professor (mas continuarão existindo se houver outros atribuídos).` : '';
    setConfirmTitle('Excluir Professor');
    setConfirmMsg(`Excluir professor ${prof.full_name}? Esta ação remove a conta permanentemente.${impact}`);
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      setDeletingId(prof.id);
      try {
        const classToUnassign = professorClassesMap[prof.id] ?? [];
        for (const cls of classToUnassign) {
          await removeProfessorFromClass(cls.id, prof.id);
        }
        if (prof.is_managed_only) {
          await deleteManagedProfile(prof.id);
        } else {
          await deleteManagedAccount(prof.id);
        }
        setProfessors((prev) => prev.filter((p) => p.id !== prof.id));
        setClassProfMap((prev) => {
          const next: Record<string, string[]> = {};
          for (const [cid, ids] of Object.entries(prev)) next[cid] = ids.filter((id) => id !== prof.id);
          return next;
        });
        showToast('Professor excluído.', 'success');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Erro ao excluir professor.', 'error');
      } finally {
        setDeletingId(null);
      }
    });
    setConfirmOpen(true);
  }

  function openPromote(prof: Profile) {
    setPromoteTarget(prof);
    setPromoteEmail('');
    setPromoteSendInvite(true);
    setPromoteError('');
    setPromoteOpen(true);
  }

  async function handlePromote(e: React.FormEvent) {
    e.preventDefault();
    if (!promoteTarget) return;
    setPromoteError('');
    setPromoting(true);
    try {
      const result = await promoteManagedToReal({
        profileId: promoteTarget.id,
        email: promoteEmail,
        sendInvite: promoteSendInvite,
      });
      setProfessors((prev) =>
        prev.map((p) =>
          p.id === promoteTarget.id
            ? { ...p, is_managed_only: false, email: result.email }
            : p,
        ),
      );
      showToast(
        result.inviteSent
          ? 'Conta criada e convite enviado por email.'
          : 'Conta criada. Professor pode acessar via link de senha.',
        'success',
      );
      setPromoteOpen(false);
    } catch (err) {
      setPromoteError(friendlyError(err, 'Erro ao promover professor.'));
    } finally {
      setPromoting(false);
    }
  }

  return (
    <>
    <PullToRefresh onRefresh={load}>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-bold text-iv-text">Professores</h2>
          <p className="text-xs sm:text-sm text-iv-muted mt-0.5">Gerencie as contas dos professores</p>
        </div>
        <Button leftIcon={<Plus size={16} />} onClick={() => { setGeneratedPassword(generatePassword()); setFullName(''); setEmail(''); setPhone(''); setCreateManaged(false); setCreateError(''); setCreateSuccess(''); setModalOpen(true); }} className="shrink-0">
          Novo professor
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
      )}

      {loading ? (
        <PageLoader variant="list" rows={5} />
      ) : professors.length === 0 ? (
        <EmptyState icon={<UserCheck size={32} />} title="Nenhum professor" description="Crie credenciais para os professores do instituto." />
      ) : (
        <>
          {professors.length > 0 && (
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
            const filtered = q ? professors.filter((p) => p.full_name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q)) : professors;
            return filtered.length === 0 ? (
              <p className="text-sm text-iv-muted text-center py-6">Nenhum professor encontrado para "{search}".</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((prof) => {
                  const assignedClasses = professorClassesMap[prof.id] ?? [];
                  return (
              <div key={prof.id} className="glass-panel p-3 sm:p-4 space-y-3">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="w-10 h-10 rounded-xl bg-iv-accent/15 text-iv-accent flex items-center justify-center font-bold">
                    {prof.full_name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-sm font-semibold text-iv-text truncate">{prof.full_name}</p>
                      {prof.is_managed_only && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20 shrink-0" title="Professor presencial sem login">
                          🏛️
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-iv-muted truncate">
                      {prof.email ?? (prof.phone ?? 'Professor presencial')}
                    </p>
                  </div>
                  <StatusBadge label="Professor" colorClass={ROLE_COLORS.professor} />
                </div>
                <div className="text-xs text-iv-muted space-y-1.5">
                  {assignedClasses.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {assignedClasses.map((cls) => (
                        <span key={cls.id} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-iv-accent/10 text-iv-accent border border-iv-accent/20">
                          <BookOpen size={11} />
                          <span className="font-medium">{cls.name}</span>
                          <button
                            type="button"
                            onClick={() => handleUnassign(prof, cls)}
                            className="ml-1 -mr-0.5 hover:text-red-400 transition-colors"
                            aria-label={`Remover ${prof.full_name} de ${cls.name}`}
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
                    onClick={() => { setSelectedProfessor(prof); setSelectedClassId(''); setAssignModalOpen(true); }}
                    aria-label="Atribuir turma"
                    className="min-h-[44px]"
                  >
                    <Users size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => openEdit(prof)}
                    aria-label="Editar professor"
                    className="min-h-[44px]"
                  >
                    <Pencil size={14} />
                  </Button>
                  {prof.is_managed_only && (
                    <Button
                      variant="ghost"
                      onClick={() => openPromote(prof)}
                      aria-label="Promover para conta real"
                      title="Criar login para este professor"
                      className="min-h-[44px]"
                    >
                      <UserCheck size={14} />
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={() => handleDelete(prof)}
                    loading={deletingId === prof.id}
                    aria-label="Excluir professor"
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

      {/* Create professor modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setCreateError(''); setCreateSuccess(''); }}
        title="Novo professor"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {/* Toggle: professor online (login) vs presencial (managed) */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { val: false, label: 'Online', hint: 'com login' },
              { val: true, label: 'Presencial', hint: 'sem login' },
            ].map((opt) => {
              const active = createManaged === opt.val;
              return (
                <button
                  key={String(opt.val)}
                  type="button"
                  onClick={() => setCreateManaged(opt.val)}
                  className={`flex flex-col items-center gap-0.5 py-3 rounded-xl border text-sm font-medium transition-all touch-target ${
                    active
                      ? 'border-iv-accent bg-iv-accent/15 text-iv-accent'
                      : 'border-white/10 bg-white/3 text-iv-muted hover:bg-white/5 hover:text-iv-text'
                  }`}
                  aria-pressed={active}
                >
                  <span>{opt.label}</span>
                  <span className="text-[10px] opacity-70">{opt.hint}</span>
                </button>
              );
            })}
          </div>

          <Field label="Nome completo">
            <TextInput
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              maxLength={100}
              placeholder="Nome do professor"
            />
          </Field>
          {!createManaged && (
            <Field label="E-mail">
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="professor@email.com"
              />
            </Field>
          )}
          {createManaged && (
            <Field label="Telefone" hint="Opcional. Útil para contato direto da coordenação.">
              <TextInput
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={20}
                placeholder="(99) 99999-9999"
              />
            </Field>
          )}
          {createManaged ? (
            <p className="text-[11px] text-amber-300/80 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              🏛️ Professor presencial — sem login, sem e-mail. Atribua à turma presencial depois pela tela de turmas.
            </p>
          ) : (
            <p className="text-[11px] text-iv-muted/60 flex items-center gap-1"><Mail size={11} /> Uma senha temporária será gerada e enviada por e-mail. O professor deve alterá-la no primeiro acesso.</p>
          )}
          {createError && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{createError}</div>}
          {createSuccess && <div className="px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">{createSuccess}</div>}
          {!createSuccess && (
            <Button type="submit" loading={creating} fullWidth leftIcon={<Plus size={16} />} haptic="success">
              {createManaged ? 'Cadastrar professor presencial' : 'Criar conta e enviar convite'}
            </Button>
          )}
        </form>
      </Modal>

      {/* Edit professor modal */}
      <Modal
        open={editModalOpen}
        onClose={() => { setEditModalOpen(false); setSelectedProfessor(null); setEditError(''); }}
        title={`Editar professor — ${selectedProfessor?.full_name ?? ''}`}
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
          {!selectedProfessor?.is_managed_only && (
            <Field label="E-mail">
              <TextInput
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                required
              />
            </Field>
          )}
          {selectedProfessor?.is_managed_only && (
            <p className="text-[11px] text-amber-300/80 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              🏛️ Professor presencial — não tem login. E-mail não se aplica.
            </p>
          )}
          {editError && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{editError}</div>}
          <Button type="submit" loading={editing} fullWidth leftIcon={<Pencil size={16} />} haptic="success">
            Salvar alterações
          </Button>
        </form>
      </Modal>

      {/* Assign class modal */}
      <Modal
        open={assignModalOpen}
        onClose={() => { setAssignModalOpen(false); setSelectedProfessor(null); setSelectedClassId(''); }}
        title={`Atribuir turma — ${selectedProfessor?.full_name ?? ''}`}
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
                .filter((c) => !(classProfMap[c.id] ?? []).includes(selectedProfessor?.id ?? ''))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </Select>
          </Field>
          <p className="text-[11px] text-iv-muted/70">Cada turma aceita múltiplos professores. Esta ação adiciona o professor à turma sem remover os demais.</p>
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

      {/* Promote managed → real account */}
      <Modal
        open={promoteOpen}
        onClose={() => !promoting && setPromoteOpen(false)}
        title={`Promover ${promoteTarget?.full_name ?? ''} para conta real`}
      >
        <form onSubmit={handlePromote} className="space-y-4">
          <p className="text-xs text-iv-muted">
            Cria login para o professor presencial preservando o vínculo com turmas. Um link de definição de senha é enviado por email se solicitado.
          </p>
          <Field label="Email do professor" required>
            <TextInput
              type="email"
              value={promoteEmail}
              onChange={(e) => setPromoteEmail(e.target.value)}
              placeholder="professor@email.com"
              required
              autoFocus
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-iv-text cursor-pointer select-none">
            <input
              type="checkbox"
              checked={promoteSendInvite}
              onChange={(e) => setPromoteSendInvite(e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-iv-bg accent-iv-accent"
            />
            <span>Enviar link de definição de senha por email</span>
          </label>
          {promoteError && (
            <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {promoteError}
            </div>
          )}
          <Button type="submit" loading={promoting} fullWidth leftIcon={<UserCheck size={16} />} haptic="success">
            Promover e {promoteSendInvite ? 'enviar convite' : 'criar conta'}
          </Button>
        </form>
      </Modal>
    </div>
    </PullToRefresh>
    </>
  );
}
