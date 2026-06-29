import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type { Assignment, AssignmentInsert, AssignmentUpdate } from '../types';

/** Assert the caller has a role that can mutate assignments in localStorage mode. */
function assertCanMutate(action: string): void {
  if (isSupabaseConfigured) return; // RLS enforces this in Supabase mode
  const role = getCurrentUserRole();
  if (role !== 'coordenacao' && role !== 'professor') {
    throw new Error(`Sem permissão para ${action} tarefas.`);
  }
}

const LS_ASSIGNMENTS = 'iv_assignments';

function getStored(): Assignment[] {
  try {
    return JSON.parse(localStorage.getItem(LS_ASSIGNMENTS) || '[]');
  } catch {
    return [];
  }
}

function save(items: Assignment[]) {
  localStorage.setItem(LS_ASSIGNMENTS, JSON.stringify(items));
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function listByClass(classId: string): Promise<Assignment[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('class_id', classId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter(a => a.class_id === classId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function listPublishedByClass(classId: string): Promise<Assignment[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('class_id', classId)
      .eq('status', 'published')
      .order('due_date', { ascending: true });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter(a => a.class_id === classId && a.status === 'published')
    .sort((a, b) => {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
    });
}

export async function getAssignment(id: string): Promise<Assignment | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStored().find(a => a.id === id) || null;
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createAssignment(input: AssignmentInsert): Promise<Assignment> {
  assertCanMutate('criar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase.from('assignments') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const item: Assignment = {
    id: crypto.randomUUID(),
    class_id: input.class_id,
    title: input.title,
    description: input.description ?? null,
    due_date: input.due_date ?? null,
    max_score: input.max_score ?? 10,
    status: input.status ?? 'draft',
    created_by: input.created_by,
    created_at: new Date().toISOString(),
  };
  const all = getStored();
  all.push(item);
  save(all);
  return item;
}

export async function updateAssignment(id: string, updates: AssignmentUpdate): Promise<void> {
  assertCanMutate('actualizar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await (supabase.from('assignments') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const all = getStored();
  const idx = all.findIndex(a => a.id === id);
  if (idx === -1) throw new Error('Tarefa não encontrada.');
  all[idx] = { ...all[idx], ...updates };
  save(all);
}

export async function deleteAssignment(id: string): Promise<void> {
  assertCanMutate('eliminar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('assignments').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  save(getStored().filter(a => a.id !== id));
}
