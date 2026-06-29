import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type {
  Class, ClassInsert, ClassUpdate, ClassStatus,
  Enrollment, EnrollmentInsert, EnrollmentUpdate, EnrollmentStatus,
  ClassProfessor,
} from '../types';

// ── Permission helpers (localStorage mode only; Supabase uses RLS) ───────────

function assertCoordinator() {
  const role = getCurrentUserRole();
  if (role !== null && role !== 'coordenacao') {
    throw new Error('Operação permitida apenas para coordenação.');
  }
}

// ── localStorage keys ────────────────────────────────────────────────────────

const LS_CLASSES = 'iv_classes';
const LS_ENROLLMENTS = 'iv_enrollments';const LS_CLASS_PROFESSORS = 'iv_class_professors';

function getStoredClassProfessors(): ClassProfessor[] {
  try { return JSON.parse(localStorage.getItem(LS_CLASS_PROFESSORS) || '[]'); } catch { return []; }
}

function saveClassProfessors(items: ClassProfessor[]) {
  localStorage.setItem(LS_CLASS_PROFESSORS, JSON.stringify(items));
}
function getStoredClasses(): Class[] {
  try {
    return JSON.parse(localStorage.getItem(LS_CLASSES) || '[]');
  } catch {
    return [];
  }
}

function saveClasses(classes: Class[]) {
  localStorage.setItem(LS_CLASSES, JSON.stringify(classes));
}

function getStoredEnrollments(): Enrollment[] {
  try {
    return JSON.parse(localStorage.getItem(LS_ENROLLMENTS) || '[]');
  } catch {
    return [];
  }
}

function saveEnrollments(enrollments: Enrollment[]) {
  localStorage.setItem(LS_ENROLLMENTS, JSON.stringify(enrollments));
}

// ── Classes CRUD ─────────────────────────────────────────────────────────────

export async function listClasses(): Promise<Class[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('classes')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredClasses().sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export async function listClassesByStatus(status: ClassStatus): Promise<Class[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('classes')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredClasses()
    .filter((c) => c.status === status)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function listClassesByProfessor(professorId: string): Promise<Class[]> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase
      .from('classes') as any)
      .select('*, class_professors!inner(professor_id)')
      .eq('class_professors.professor_id', professorId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ((data || []) as Array<Class & { class_professors?: unknown }>).map((row) => {
      const { class_professors: _cp, ...cls } = row;
      return cls as Class;
    });
  }
  const links = getStoredClassProfessors().filter((cp) => cp.professor_id === professorId);
  const classIds = new Set(links.map((cp) => cp.class_id));
  return getStoredClasses()
    .filter((c) => classIds.has(c.id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// ── Class ↔ Professor junction (N:N) ───────────────────────────────

export async function listProfessorsOfClass(classId: string): Promise<string[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('class_professors')
      .select('professor_id')
      .eq('class_id', classId);
    if (error) throw new Error(error.message);
    return ((data || []) as Array<{ professor_id: string }>).map((r) => r.professor_id);
  }
  return getStoredClassProfessors()
    .filter((cp) => cp.class_id === classId)
    .map((cp) => cp.professor_id);
}

/** Batch: { classId: professorId[] } for a list of class ids. Avoids N+1. */
export async function listProfessorsByClasses(
  classIds: string[],
): Promise<Record<string, string[]>> {
  if (classIds.length === 0) return {};
  const out: Record<string, string[]> = {};
  for (const id of classIds) out[id] = [];
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('class_professors')
      .select('class_id, professor_id')
      .in('class_id', classIds);
    if (error) throw new Error(error.message);
    for (const row of (data || []) as Array<{ class_id: string; professor_id: string }>) {
      (out[row.class_id] ??= []).push(row.professor_id);
    }
    return out;
  }
  for (const cp of getStoredClassProfessors()) {
    if (classIds.includes(cp.class_id)) (out[cp.class_id] ??= []).push(cp.professor_id);
  }
  return out;
}

export async function addProfessorToClass(classId: string, professorId: string): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('class_professors') as any)
      .insert({ class_id: classId, professor_id: professorId });
    if (error && !error.message.toLowerCase().includes('duplicate')) {
      throw new Error(error.message);
    }
    return;
  }
  const items = getStoredClassProfessors();
  if (items.some((cp) => cp.class_id === classId && cp.professor_id === professorId)) return;
  items.push({ class_id: classId, professor_id: professorId, added_at: new Date().toISOString(), added_by: null });
  saveClassProfessors(items);
}

export async function removeProfessorFromClass(classId: string, professorId: string): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('class_professors').delete()
      .eq('class_id', classId).eq('professor_id', professorId);
    if (error) throw new Error(error.message);
    return;
  }
  saveClassProfessors(
    getStoredClassProfessors().filter((cp) => !(cp.class_id === classId && cp.professor_id === professorId)),
  );
}

/** Replace the full set of professors for a class atomically. */
export async function setClassProfessors(classId: string, professorIds: string[]): Promise<void> {
  assertCoordinator();
  const desired = Array.from(new Set(professorIds));
  const current = await listProfessorsOfClass(classId);
  const toAdd = desired.filter((id) => !current.includes(id));
  const toRemove = current.filter((id) => !desired.includes(id));
  for (const id of toAdd) await addProfessorToClass(classId, id);
  for (const id of toRemove) await removeProfessorFromClass(classId, id);
}

export async function getClass(id: string): Promise<Class | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('classes')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStoredClasses().find((c) => c.id === id) || null;
}

export async function createClass(input: ClassInsert): Promise<Class> {
  assertCoordinator();
  assertOnline();
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('classes') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const cls: Class = {
    id: crypto.randomUUID(),
    name: input.name,
    module_id: input.module_id,
    status: input.status || 'active',
    modality: input.modality ?? 'online',
    location: input.location ?? null,
    created_at: now,
  };
  const classes = getStoredClasses();
  classes.push(cls);
  saveClasses(classes);
  return cls;
}

export async function updateClass(id: string, updates: ClassUpdate): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('classes') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const classes = getStoredClasses();
  const idx = classes.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('Turma não encontrada.');
  classes[idx] = { ...classes[idx], ...updates };
  saveClasses(classes);
}

export async function deleteClass(id: string): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('classes').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  saveClasses(getStoredClasses().filter((c) => c.id !== id));
  // Cascade enrollments + junction
  saveEnrollments(getStoredEnrollments().filter((e) => e.class_id !== id));
  saveClassProfessors(getStoredClassProfessors().filter((cp) => cp.class_id !== id));
}

// ── Enrollments CRUD ─────────────────────────────────────────────────────────

export async function listAllEnrollments(): Promise<Enrollment[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('enrollments')
      .select('*')
      .order('enrolled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredEnrollments()
    .sort((a, b) => new Date(a.enrolled_at).getTime() - new Date(b.enrolled_at).getTime());
}

export async function listEnrollmentsByClass(classId: string): Promise<Enrollment[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('enrollments')
      .select('*')
      .eq('class_id', classId)
      .order('enrolled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredEnrollments()
    .filter((e) => e.class_id === classId)
    .sort((a, b) => new Date(a.enrolled_at).getTime() - new Date(b.enrolled_at).getTime());
}

export async function listEnrollmentsByStudent(studentId: string): Promise<Enrollment[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('enrollments')
      .select('*')
      .eq('student_id', studentId)
      .order('enrolled_at');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredEnrollments()
    .filter((e) => e.student_id === studentId)
    .sort((a, b) => new Date(a.enrolled_at).getTime() - new Date(b.enrolled_at).getTime());
}

export async function createEnrollment(input: EnrollmentInsert): Promise<Enrollment> {
  assertOnline();
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('enrollments') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  // Check duplicate
  const existing = getStoredEnrollments();
  if (existing.some((e) => e.class_id === input.class_id && e.student_id === input.student_id)) {
    throw new Error('Aluno já está matriculado nesta turma.');
  }
  const enrollment: Enrollment = {
    id: crypto.randomUUID(),
    class_id: input.class_id,
    student_id: input.student_id,
    status: 'active',
    enrolled_at: now,
  };
  existing.push(enrollment);
  saveEnrollments(existing);
  return enrollment;
}

export async function updateEnrollment(id: string, updates: EnrollmentUpdate): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('enrollments') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const enrollments = getStoredEnrollments();
  const idx = enrollments.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error('Matrícula não encontrada.');
  enrollments[idx] = { ...enrollments[idx], ...updates };
  saveEnrollments(enrollments);
}

export async function deleteEnrollment(id: string): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('enrollments').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  saveEnrollments(getStoredEnrollments().filter((e) => e.id !== id));
}

export async function countEnrollmentsByClass(classId: string): Promise<number> {
  const enrollments = await listEnrollmentsByClass(classId);
  return enrollments.filter((e) => e.status === 'active').length;
}

/** Batch count of active enrollments for multiple classes — avoids N+1 queries */
export async function countEnrollmentsByClasses(classIds: string[]): Promise<Record<string, number>> {
  if (classIds.length === 0) return {};
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('enrollments') as any)
      .select('class_id')
      .in('class_id', classIds)
      .eq('status', 'active');
    if (error) throw new Error(error.message);
    const counts: Record<string, number> = {};
    for (const id of classIds) counts[id] = 0;
    for (const row of (data || []) as Array<{ class_id: string }>) {
      counts[row.class_id] = (counts[row.class_id] ?? 0) + 1;
    }
    return counts;
  }
  const all = getStoredEnrollments().filter(
    (e) => e.status === 'active' && classIds.includes(e.class_id),
  );
  const counts: Record<string, number> = {};
  for (const id of classIds) counts[id] = 0;
  for (const e of all) counts[e.class_id] = (counts[e.class_id] ?? 0) + 1;
  return counts;
}

/** Get class IDs where a student is enrolled (active) */
export async function getStudentClassIds(studentId: string): Promise<string[]> {
  const enrollments = await listEnrollmentsByStudent(studentId);
  return enrollments.filter((e) => e.status === 'active').map((e) => e.class_id);
}
