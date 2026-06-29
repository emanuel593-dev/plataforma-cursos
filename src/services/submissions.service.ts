import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type { Submission, SubmissionInsert, SubmissionUpdate } from '../types';

/** Only students may submit; only professors/coordenacao may grade or return. */
function assertRole(allowed: string[], action: string): void {
  if (isSupabaseConfigured) return;
  const role = getCurrentUserRole();
  if (!role || !allowed.includes(role)) {
    throw new Error(`Sem permissão para ${action}.`);
  }
}

const LS_SUBMISSIONS = 'iv_submissions';

function getStored(): Submission[] {
  try {
    return JSON.parse(localStorage.getItem(LS_SUBMISSIONS) || '[]');
  } catch {
    return [];
  }
}

function save(items: Submission[]) {
  localStorage.setItem(LS_SUBMISSIONS, JSON.stringify(items));
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function listByAssignment(assignmentId: string): Promise<Submission[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .eq('assignment_id', assignmentId)
      .order('submitted_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter(s => s.assignment_id === assignmentId)
    .sort((a, b) => {
      const ta = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
      const tb = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
      return tb - ta;
    });
}

export async function listByStudent(studentId: string): Promise<Submission[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter(s => s.student_id === studentId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function getStudentSubmission(assignmentId: string, studentId: string): Promise<Submission | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStored().find(
    s => s.assignment_id === assignmentId && s.student_id === studentId,
  ) || null;
}

/** Batch: get all submissions for multiple assignments (avoids N+1) */
export async function listByAssignments(assignmentIds: string[]): Promise<Submission[]> {
  if (assignmentIds.length === 0) return [];
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase.from('submissions') as any)
      .select('*')
      .in('assignment_id', assignmentIds);
    if (error) throw new Error(error.message);
    return data || [];
  }
  const idSet = new Set(assignmentIds);
  return getStored().filter(s => idSet.has(s.assignment_id));
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function submitWork(input: SubmissionInsert): Promise<Submission> {
  assertRole(['aluno'], 'submeter trabalho');
  assertOnline();
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    const payload = { ...input, status: 'submitted', submitted_at: now };
    const { data, error } = await (supabase.from('submissions') as any)
      .upsert(payload, { onConflict: 'assignment_id,student_id' })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const all = getStored();
  const existing = all.findIndex(
    s => s.assignment_id === input.assignment_id && s.student_id === input.student_id,
  );
  const item: Submission = {
    id: existing >= 0 ? all[existing].id : crypto.randomUUID(),
    assignment_id: input.assignment_id,
    student_id: input.student_id,
    content: input.content ?? null,
    file_url: input.file_url ?? null,
    status: 'submitted',
    score: null,
    feedback: null,
    graded_by: null,
    submitted_at: now,
    graded_at: null,
    created_at: existing >= 0 ? all[existing].created_at : now,
  };
  if (existing >= 0) {
    all[existing] = item;
  } else {
    all.push(item);
  }
  save(all);
  return item;
}

export async function gradeSubmission(
  id: string,
  score: number,
  feedback: string | null,
  gradedBy: string,
): Promise<void> {
  assertRole(['coordenacao', 'professor'], 'avaliar entrega');
  assertOnline();
  const now = new Date().toISOString();
  const updates: SubmissionUpdate = {
    score,
    feedback,
    graded_by: gradedBy,
    graded_at: now,
    status: 'graded',
  };
  if (isSupabaseConfigured) {
    const { error } = await (supabase.from('submissions') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const all = getStored();
  const idx = all.findIndex(s => s.id === id);
  if (idx === -1) throw new Error('Entrega não encontrada.');
  all[idx] = { ...all[idx], ...updates };
  save(all);
}

export async function returnSubmission(id: string, feedback: string): Promise<void> {
  assertRole(['coordenacao', 'professor'], 'devolver entrega');
  assertOnline();
  const updates: SubmissionUpdate = {
    feedback,
    status: 'returned',
  };
  if (isSupabaseConfigured) {
    const { error } = await (supabase.from('submissions') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const all = getStored();
  const idx = all.findIndex(s => s.id === id);
  if (idx === -1) throw new Error('Entrega não encontrada.');
  all[idx] = { ...all[idx], ...updates };
  save(all);
}
