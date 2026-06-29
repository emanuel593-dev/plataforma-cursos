import React, { useEffect, useState } from 'react';
import {
  GraduationCap, Plus, Mail, Users, Pencil, Trash2, Search, UserCheck,
} from 'lucide-react';
import { listProfilesByRole } from '../../services/profiles.service';
import { createStudentAccount, updateManagedAccount, deleteManagedAccount } from '../../services/auth.service';
import { createManagedStudent, updateManagedProfile, deleteManagedProfile, promoteManagedToReal } from '../../services/managed.service';
import {
  listClasses, createEnrollment, listAllEnrollments, listEnrollmentsByStudent, deleteEnrollment,
} from '../../services/classes.service';
import { listModules } from '../../services/modules.service';
import { authHeaders } from '../../lib/apiAuth';
import type { Profile, Class, Module } from '../../types';
import EmptyState from '../ui/EmptyState';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import Button from '../ui/Button';
import PageLoader from '../ui/PageLoader';
import PullToRefresh from '../ui/PullToRefresh';
import { Field, TextInput, Select } from '../ui/FormField';
import { useToast } from '../../contexts/ToastContext';
import { friendlyError } from '../../lib/utils';

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export default function StudentsView() {
  const [students, setStudents] = useState<Profile[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [modalOpen, setModalOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [selectedClassId, setSelectedClassId] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState('');
  /** Quando true, cria perfil presencial sem login (is_managed_only=true). */
  const [createManaged, setCreateManaged] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');
  const [editing, setEditing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { showToast } = useToast();
  const [search, setSearch] = useState('');

  // Edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<Profile | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editClassId, setEditClassId] = useState('');
  const [editError, setEditError] = useState('');

  // Confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);

  // Promote managed → real account modal
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<Profile | null>(null);
  const [promoteEmail, setPromoteEmail] = useState('');
  const [promoteSendInvite, setPromoteSendInvite] = useState(true);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [studs, cls, mods] = await Promise.all([
        listProfilesByRole('aluno'),
        listClasses(),
        listModules(),
      ]);
      setStudents(studs);
      setClasses(cls);
      setModules(mods);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openModal() {
    setFullName('');
    setEmail('');
    setPhone('');
    setSelectedClassId('');
    setGeneratedPassword(generatePassword());
    setCreateManaged(false);
    setCreateError('');
    setCreateSuccess('');
    setModalOpen(true);
  }

  function moduleForClass(cls: Class): Module | undefined {
    return modules.find((m) => m.id === cls.module_id);
  }

  const [enrollmentMap, setEnrollmentMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (students.length === 0) return;
    listAllEnrollments().then((all) => {
      const map: Record<string, string> = {};
      for (const en of all) {
        if (en.status === 'active') map[en.student_id] = en.class_id;
      }
      setEnrollmentMap(map);
    }).catch(console.error);
  }, [students]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError('');
    setCreateSuccess('');
    try {
      let studentId: string;
      let studentEmail: string | null;

      if (createManaged) {
        // Aluno presencial — sem login, sem email obrigatório.
        const managed = await createManagedStudent({
          full_name: fullName,
          phone: phone || null,
        });
        studentId = managed.id;
        studentEmail = null;
        if (selectedClassId) {
          await createEnrollment({ class_id: selectedClassId, student_id: studentId, status: 'active' });
        }
        const newProfile: Profile = {
          id: studentId,
          email: null,
          full_name: fullName,
          avatar_url: null,
          role: 'aluno',
          phone: phone || null,
          must_change_password: false,
          is_managed_only: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setStudents((prev) => [...prev, newProfile]);
        if (selectedClassId) {
          setEnrollmentMap((prev) => ({ ...prev, [studentId]: selectedClassId }));
        }
        setCreateSuccess('Aluno presencial cadastrado. Sem necessidade de login.');
        return;
      }

      const student = await createStudentAccount(email, fullName, generatedPassword);
      studentId = student.id;
      studentEmail = student.email;

      // Enroll in selected class if provided
      if (selectedClassId) {
        await createEnrollment({ class_id: selectedClassId, student_id: studentId, status: 'active' });
      }

      // Optimistic update — add student profile to local state
      const newProfile: Profile = {
        id: studentId,
        email: studentEmail,
        full_name: fullName,
        avatar_url: null,
        role: 'aluno',
        phone: null,
        must_change_password: true,
        is_managed_only: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setStudents((prev) => [...prev, newProfile]);
      if (selectedClassId) {
        setEnrollmentMap((prev) => ({ ...prev, [studentId]: selectedClassId }));
      }

      // Try sending invite email
      let emailSent = false;
      try {
        const cls = classes.find((c) => c.id === selectedClassId);
        const res = await fetch('/api/invite', {
          method: 'POST',
          headers: await authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            to: email,
            name: fullName,
            password: generatedPassword,
            role: 'aluno',
            className: cls?.name,
          }),
        });
        const json = await res.json();
        emailSent = json.emailSent === true;
      } catch {
        // server offline — silent
      }

      setCreateSuccess(emailSent
        ? `Conta criada! As credenciais de acesso foram enviadas para ${email}.`
        : `Conta criada com sucesso! Não foi possível enviar o e-mail automaticamente — anote a senha gerada e repasse manualmente.`);
    } catch (err: unknown) {
      const msg = friendlyError(err, 'Erro ao criar conta.');
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  }

  function openEdit(student: Profile) {
    setSelectedStudent(student);
    setEditName(student.full_name);
    setEditEmail(student.email ?? '');
    setEditClassId(enrollmentMap[student.id] ?? '');
    setEditError('');
    setEditModalOpen(true);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedStudent) return;
    setEditing(true);
    setEditError('');
    try {
      if (selectedStudent.is_managed_only) {
        // Aluno presencial — sem email, atualiza só nome via RPC managed.
        await updateManagedProfile(selectedStudent.id, {
          full_name: editName,
        });
      } else {
        await updateManagedAccount(selectedStudent.id, {
          full_name: editName,
          email: editEmail,
        });
      }

      const currentClassId = enrollmentMap[selectedStudent.id] ?? '';
      if (currentClassId !== editClassId) {
        const studentEnrollments = await listEnrollmentsByStudent(selectedStudent.id);
        for (const en of studentEnrollments) {
          await deleteEnrollment(en.id);
        }
        if (editClassId) {
          await createEnrollment({
            class_id: editClassId,
            student_id: selectedStudent.id,
            status: 'active',
          });
        }
      }

      // Optimistic update — patch student in local state
      setStudents((prev) => prev.map((s) =>
        s.id === selectedStudent.id
          ? {
              ...s,
              full_name: editName,
              email: selectedStudent.is_managed_only ? s.email : editEmail,
              updated_at: new Date().toISOString(),
            }
          : s,
      ));
      setEnrollmentMap((prev) => {
        const next = { ...prev };
        if (editClassId) {
          next[selectedStudent.id] = editClassId;
        } else {
          delete next[selectedStudent.id];
        }
        return next;
      });

      setEditModalOpen(false);
      setSelectedStudent(null);
      showToast('Aluno atualizado.', 'success');
    } catch (err) {
      setEditError(friendlyError(err, 'Erro ao editar aluno.'));
    } finally {
      setEditing(false);
    }
  }

  async function handleDelete(student: Profile) {
    setConfirmTitle('Excluir Aluno');
    setConfirmMsg(`Excluir aluno ${student.full_name}? Esta ação remove a conta, a matrícula e o histórico de presenças permanentemente.`);
    setConfirmAction(() => async () => {
      setConfirmOpen(false);
      setDeletingId(student.id);
      try {
        const enrollments = await listEnrollmentsByStudent(student.id);
        for (const en of enrollments) {
          await deleteEnrollment(en.id);
        }
        if (student.is_managed_only) {
          await deleteManagedProfile(student.id);
        } else {
          await deleteManagedAccount(student.id);
        }
        setStudents((prev) => prev.filter((s) => s.id !== student.id));
        setEnrollmentMap((prev) => {
          const next = { ...prev };
          delete next[student.id];
          return next;
        });
        showToast('Aluno excluído.', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao excluir aluno.', 'error');
      } finally {
        setDeletingId(null);
      }
    });
    setConfirmOpen(true);
  }

  function openPromote(student: Profile) {
    setPromoteTarget(student);
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
      // Update local list: profile is no longer managed
      setStudents((prev) =>
        prev.map((s) =>
          s.id === promoteTarget.id
            ? { ...s, is_managed_only: false, email: result.email }
            : s,
        ),
      );
      showToast(
        result.inviteSent
          ? 'Conta criada e convite enviado por email.'
          : 'Conta criada. Aluno pode acessar com email + link de senha.',
        'success',
      );
      setPromoteOpen(false);
    } catch (err) {
      setPromoteError(friendlyError(err, 'Erro ao promover aluno.'));
    } finally {
      setPromoting(false);
    }
  }

  if (loading) {
    return <PageLoader variant="list" rows={5} />;
  }

  return (
    <>
    <PullToRefresh onRefresh={load}>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-bold text-iv-text">Alunos</h2>
          <p className="text-xs sm:text-sm text-iv-muted mt-0.5">Gerencie os alunos matriculados</p>
        </div>
        <Button leftIcon={<Plus size={16} />} onClick={openModal} className="shrink-0">
          Novo aluno
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <div className="glass-panel p-3 sm:p-4">
          <div className="flex items-center gap-2 text-iv-muted mb-1"><GraduationCap size={15} /><span className="text-xs">Total de alunos</span></div>
          <p className="text-xl sm:text-2xl font-bold text-iv-text">{students.length}</p>
        </div>
        <div className="glass-panel p-3 sm:p-4">
          <div className="flex items-center gap-2 text-iv-muted mb-1"><Users size={15} /><span className="text-xs">Turmas ativas</span></div>
          <p className="text-xl sm:text-2xl font-bold text-iv-text">{classes.filter((c) => c.status === 'active').length}</p>
        </div>
      </div>

      {/* Search */}
      {students.length > 0 && (
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

      {/* Student list */}
      {students.length === 0 ? (
        <EmptyState
          icon={<GraduationCap size={32} />}
          title="Nenhum aluno cadastrado"
          description="Crie o primeiro aluno usando o botão acima."
        />
      ) : (() => {
        const q = search.toLowerCase();
        const filtered = q ? students.filter((s) => s.full_name.toLowerCase().includes(q) || (s.email ?? '').toLowerCase().includes(q)) : students;
        return (
          <div className="space-y-2">
            {filtered.length === 0 ? (
              <p className="text-sm text-iv-muted text-center py-6">Nenhum aluno encontrado para "{search}".</p>
            ) : filtered.map((student) => {
              const classId = enrollmentMap[student.id];
              const cls = classes.find((c) => c.id === classId);
              const mod = cls ? moduleForClass(cls) : undefined;
              return (
              <div key={student.id} className="glass-panel p-3 sm:p-4 flex items-center gap-2 sm:gap-3 flex-wrap">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm shrink-0"
                  style={{
                    backgroundColor: mod ? `${mod.color}22` : 'rgba(var(--iv-accent-rgb, 124 58 237) / 0.15)',
                    color: mod?.color ?? 'rgb(124,58,237)',
                  }}
                >
                  {student.full_name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <p className="text-sm font-semibold text-iv-text truncate">{student.full_name}</p>
                    {student.is_managed_only && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20 shrink-0" title="Aluno presencial sem login">
                        🏛️
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-iv-muted truncate">
                    {student.email ?? (student.phone ?? 'Aluno presencial')}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto">
                  {cls ? (
                    <span
                      className="text-xs px-2.5 py-1 rounded-full border shrink-0"
                      style={{
                        backgroundColor: mod ? `${mod.color}22` : undefined,
                        color: mod?.color ?? '#a78bfa',
                        borderColor: mod ? `${mod.color}55` : undefined,
                      }}
                    >
                      {cls.name}
                    </span>
                  ) : (
                    <span className="text-xs text-iv-muted/50 shrink-0">Sem turma</span>
                  )}
                  <Button size="icon" variant="ghost" onClick={() => openEdit(student)} aria-label="Editar aluno">
                    <Pencil size={14} />
                  </Button>
                  {student.is_managed_only && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openPromote(student)}
                      aria-label="Promover para conta real"
                      title="Criar login para este aluno"
                    >
                      <UserCheck size={14} />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="danger"
                    onClick={() => handleDelete(student)}
                    loading={deletingId === student.id}
                    aria-label="Excluir aluno"
                    haptic="error"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            );})}
          </div>
        );
      })()}

      {/* Create student modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setCreateError(''); setCreateSuccess(''); }}
        title="Novo aluno"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {/* Toggle: aluno online (login) vs presencial (managed) */}
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
              placeholder="Nome do aluno"
            />
          </Field>
          {!createManaged && (
            <Field label="E-mail">
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="aluno@email.com"
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
          <Field label="Turma / Módulo" required>
            <Select
              value={selectedClassId}
              onChange={(e) => setSelectedClassId(e.target.value)}
              required
            >
              <option value="">Selecione a turma</option>
              {classes.map((cls) => {
                const mod = moduleForClass(cls);
                return (
                  <option key={cls.id} value={cls.id}>
                    {cls.name}{mod ? ` — ${mod.name}` : ''}
                    {cls.modality !== 'online' ? ` · ${cls.modality === 'presencial' ? 'Presencial' : 'Híbrida'}` : ''}
                  </option>
                );
              })}
            </Select>
          </Field>
          {createManaged ? (
            <p className="text-[11px] text-amber-300/80 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              🏛️ Aluno presencial — sem login, sem e-mail. A coordenação faz a chamada.
            </p>
          ) : (
            <p className="text-[11px] text-iv-muted/60 flex items-center gap-1"><Mail size={11} /> Uma senha temporária será gerada e enviada por e-mail. O aluno deve alterá-la no primeiro acesso.</p>
          )}
          {createError && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{createError}</div>}
          {createSuccess && <div className="px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">{createSuccess}</div>}
          {!createSuccess && (
            <Button type="submit" loading={creating} fullWidth leftIcon={<Plus size={16} />} haptic="success">
              {createManaged ? 'Cadastrar aluno presencial' : 'Criar conta e enviar convite'}
            </Button>
          )}
        </form>
      </Modal>

      {/* Edit student modal */}
      <Modal
        open={editModalOpen}
        onClose={() => { setEditModalOpen(false); setSelectedStudent(null); setEditError(''); }}
        title={`Editar aluno — ${selectedStudent?.full_name ?? ''}`}
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
          {!selectedStudent?.is_managed_only && (
            <Field label="E-mail">
              <TextInput
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                required
              />
            </Field>
          )}
          {selectedStudent?.is_managed_only && (
            <p className="text-[11px] text-amber-300/80 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              🏛️ Aluno presencial — não tem login. E-mail não se aplica.
            </p>
          )}
          <Field label="Turma" required>
            <Select
              value={editClassId}
              onChange={(e) => setEditClassId(e.target.value)}
              required
            >
              <option value="">Selecione a turma</option>
              {classes.map((cls) => {
                const mod = moduleForClass(cls);
                return (
                  <option key={cls.id} value={cls.id}>
                    {cls.name}{mod ? ` — ${mod.name}` : ''}
                  </option>
                );
              })}
            </Select>
          </Field>
          {editError && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{editError}</div>}
          <Button type="submit" loading={editing} fullWidth leftIcon={<Pencil size={16} />} haptic="success">
            Salvar alterações
          </Button>
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
            Esta ação cria um login para o aluno presencial preservando o histórico (matrículas, presenças). Um link de definição de senha é enviado por email se solicitado.
          </p>
          <Field label="Email do aluno" required>
            <TextInput
              type="email"
              value={promoteEmail}
              onChange={(e) => setPromoteEmail(e.target.value)}
              placeholder="aluno@email.com"
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

