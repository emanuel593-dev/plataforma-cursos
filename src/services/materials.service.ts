import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type { ClassMaterial, ClassMaterialInsert, ClassMaterialUpdate } from '../types';

/** Assert the caller has a role that can mutate materials in localStorage mode. */
function assertCanMutate(action: string): void {
  if (isSupabaseConfigured) return;
  const role = getCurrentUserRole();
  if (role !== 'coordenacao' && role !== 'professor') {
    throw new Error(`Sem permissão para ${action} materiais.`);
  }
}

const LS_MATERIALS = 'iv_class_materials';

function getStored(): ClassMaterial[] {
  try {
    return JSON.parse(localStorage.getItem(LS_MATERIALS) || '[]');
  } catch {
    return [];
  }
}

function save(items: ClassMaterial[]) {
  localStorage.setItem(LS_MATERIALS, JSON.stringify(items));
}

export async function listByClass(classId: string): Promise<ClassMaterial[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('class_materials')
      .select('*')
      .eq('class_id', classId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter((m) => m.class_id === classId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function createMaterial(input: ClassMaterialInsert): Promise<ClassMaterial> {
  assertCanMutate('criar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase.from('class_materials') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const item: ClassMaterial = {
    id: crypto.randomUUID(),
    class_id: input.class_id,
    title: input.title,
    url: input.url,
    type: input.type,
    uploaded_by: input.uploaded_by,
    created_at: new Date().toISOString(),
  };
  const all = getStored();
  all.push(item);
  save(all);
  return item;
}

export async function updateMaterial(id: string, updates: ClassMaterialUpdate): Promise<void> {
  assertCanMutate('actualizar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await (supabase.from('class_materials') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const all = getStored();
  const idx = all.findIndex((m) => m.id === id);
  if (idx === -1) throw new Error('Material não encontrado.');
  all[idx] = { ...all[idx], ...updates };
  save(all);
}

export async function deleteMaterial(id: string): Promise<void> {
  assertCanMutate('eliminar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('class_materials').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  save(getStored().filter((m) => m.id !== id));
}
