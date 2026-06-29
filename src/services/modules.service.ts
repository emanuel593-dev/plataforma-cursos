import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { Module, ModuleInsert, ModuleUpdate, Lesson, LessonInsert, LessonUpdate } from '../types';

// ── localStorage keys ────────────────────────────────────────────────────────

const LS_MODULES = 'iv_modules';
const LS_LESSONS = 'iv_lessons';

// ── Seed data (mirrors 002_seed_modules.sql) ─────────────────────────────────

const SEED_MODULES: Module[] = [
  { id: 'a1000000-0000-0000-0000-000000000001', name: '1° Módulo', description: 'Fundamentos da fé e vida cristã', color: '#3b82f6', order_index: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 'a2000000-0000-0000-0000-000000000002', name: '2° Módulo', description: 'Caráter cristão e cura da alma', color: '#22c55e', order_index: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 'a3000000-0000-0000-0000-000000000003', name: '3° Módulo', description: 'Liderança e missão', color: '#ef4444', order_index: 3, created_at: '2026-01-01T00:00:00Z' },
];

const SEED_LESSONS: Lesson[] = [
  // 1° Módulo — stable IDs so FK references survive page reloads
  { id: 'b1000000-0000-0000-0000-000000000001', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'Enfrentando o dia a dia I – Vida Social e Música', description: null, order_index: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000002', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'Enfrentando o dia a dia II – Vencendo as tentações', description: null, order_index: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000003', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'A arma do cristão I – Bíblia', description: null, order_index: 3, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000004', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'A arma do cristão II – Oração e Jejum', description: null, order_index: 4, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000005', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'As características de Deus', description: null, order_index: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000006', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'DEUS X PECADO – A obra redentora da cruz e o poder do nome de Jesus', description: null, order_index: 6, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000007', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'O desenvolvimento da fé com a condução do Espírito Santo', description: null, order_index: 7, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000008', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'Fé (Dízimo e ofertas)', description: null, order_index: 8, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000009', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'Obediência', description: null, order_index: 9, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000010', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'Benção e maldição', description: null, order_index: 10, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000011', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'Guerra Espiritual – A armadura de Deus', description: null, order_index: 11, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1000000-0000-0000-0000-000000000012', module_id: 'a1000000-0000-0000-0000-000000000001', title: 'A importância da casa de Deus', description: null, order_index: 12, created_at: '2026-01-01T00:00:00Z' },
  // 2° Módulo
  { id: 'b2000000-0000-0000-0000-000000000001', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Projeto de Deus x Decisão do homem', description: null, order_index: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000002', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Caráter deformado: Mente distorcida', description: null, order_index: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000003', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Caráter deformado: Emoções descontroladas', description: null, order_index: 3, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000004', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Caráter deformado: Vã maneira de viver', description: null, order_index: 4, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000005', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Caráter em construção: Valores organizados', description: null, order_index: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000006', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'O perfil do caráter cristão', description: null, order_index: 6, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000007', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Ser humano: Conceitos e a importância da cura da alma', description: null, order_index: 7, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000008', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Jesus o grande conselheiro', description: null, order_index: 8, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000009', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Instrumento da cura da alma', description: null, order_index: 9, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000010', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Como melhorar seus sentimentos', description: null, order_index: 10, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000011', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'O verdadeiro amor', description: null, order_index: 11, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b2000000-0000-0000-0000-000000000012', module_id: 'a2000000-0000-0000-0000-000000000002', title: 'Avaliação / Encerramento', description: null, order_index: 12, created_at: '2026-01-01T00:00:00Z' },
  // 3° Módulo
  { id: 'b3000000-0000-0000-0000-000000000001', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'Desenvolvendo o seu talento', description: null, order_index: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000002', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'Paixão pelo perdido', description: null, order_index: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000003', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'O chamado', description: null, order_index: 3, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000004', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'TAC', description: null, order_index: 4, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000005', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'A batalha pessoal do líder de células', description: null, order_index: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000006', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'A batalha de levar outros a Cristo', description: null, order_index: 6, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000007', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'Escada do sucesso – Parte I', description: null, order_index: 7, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000008', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'Escada do sucesso – Parte II', description: null, order_index: 8, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000009', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'Construindo a aliança de discípulo', description: null, order_index: 9, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000010', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'A mordomia do dinheiro no corpo de Cristo', description: null, order_index: 10, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000011', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'Noções gerais e a força do louvor', description: null, order_index: 11, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b3000000-0000-0000-0000-000000000012', module_id: 'a3000000-0000-0000-0000-000000000003', title: 'A volta de Jesus', description: null, order_index: 12, created_at: '2026-01-01T00:00:00Z' },
];

// ── localStorage helpers ─────────────────────────────────────────────────────

function getStoredModules(): Module[] {
  try {
    const raw = localStorage.getItem(LS_MODULES);
    if (!raw) {
      // Auto-seed on first access
      localStorage.setItem(LS_MODULES, JSON.stringify(SEED_MODULES));
      localStorage.setItem(LS_LESSONS, JSON.stringify(SEED_LESSONS));
      return SEED_MODULES;
    }
    return JSON.parse(raw);
  } catch {
    return SEED_MODULES;
  }
}

function saveModules(modules: Module[]) {
  localStorage.setItem(LS_MODULES, JSON.stringify(modules));
}

function getStoredLessons(): Lesson[] {
  try {
    const raw = localStorage.getItem(LS_LESSONS);
    if (!raw) {
      localStorage.setItem(LS_LESSONS, JSON.stringify(SEED_LESSONS));
      return SEED_LESSONS;
    }
    return JSON.parse(raw);
  } catch {
    return SEED_LESSONS;
  }
}

function saveLessons(lessons: Lesson[]) {
  localStorage.setItem(LS_LESSONS, JSON.stringify(lessons));
}

// ── Modules CRUD ─────────────────────────────────────────────────────────────

export async function listModules(): Promise<Module[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('modules')
      .select('*')
      .order('order_index');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredModules().sort((a, b) => a.order_index - b.order_index);
}

export async function getModule(id: string): Promise<Module | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('modules')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStoredModules().find((m) => m.id === id) || null;
}

export async function createModule(input: ModuleInsert): Promise<Module> {
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('modules') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const mod: Module = {
    id: input.id || crypto.randomUUID(),
    name: input.name,
    description: input.description ?? null,
    color: input.color,
    order_index: input.order_index,
    created_at: now,
  };
  const modules = getStoredModules();
  modules.push(mod);
  saveModules(modules);
  return mod;
}

export async function updateModule(id: string, updates: ModuleUpdate): Promise<void> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('modules') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const modules = getStoredModules();
  const idx = modules.findIndex((m) => m.id === id);
  if (idx === -1) throw new Error('Módulo não encontrado.');
  modules[idx] = { ...modules[idx], ...updates };
  saveModules(modules);
}

export async function deleteModule(id: string): Promise<void> {
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('modules').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const modules = getStoredModules().filter((m) => m.id !== id);
  saveModules(modules);
  // Cascade delete lessons
  const lessons = getStoredLessons().filter((l) => l.module_id !== id);
  saveLessons(lessons);
}

// ── Lessons CRUD ─────────────────────────────────────────────────────────────

export async function listLessonsByModule(moduleId: string): Promise<Lesson[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lessons')
      .select('*')
      .eq('module_id', moduleId)
      .order('order_index');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredLessons()
    .filter((l) => l.module_id === moduleId)
    .sort((a, b) => a.order_index - b.order_index);
}

export async function listAllLessons(): Promise<Lesson[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lessons')
      .select('*')
      .order('order_index');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredLessons().sort((a, b) => a.order_index - b.order_index);
}

export async function getLesson(id: string): Promise<Lesson | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lessons')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  return getStoredLessons().find((l) => l.id === id) || null;
}

export async function createLesson(input: LessonInsert): Promise<Lesson> {
  const now = new Date().toISOString();
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase
      .from('lessons') as any)
      .insert(input)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const lesson: Lesson = {
    id: crypto.randomUUID(),
    module_id: input.module_id,
    title: input.title,
    description: input.description ?? null,
    order_index: input.order_index,
    created_at: now,
  };
  const lessons = getStoredLessons();
  lessons.push(lesson);
  saveLessons(lessons);
  return lesson;
}

export async function updateLesson(id: string, updates: LessonUpdate): Promise<void> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('lessons') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const lessons = getStoredLessons();
  const idx = lessons.findIndex((l) => l.id === id);
  if (idx === -1) throw new Error('Aula não encontrada.');
  lessons[idx] = { ...lessons[idx], ...updates };
  saveLessons(lessons);
}

export async function deleteLesson(id: string): Promise<void> {
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('lessons').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  saveLessons(getStoredLessons().filter((l) => l.id !== id));
}
