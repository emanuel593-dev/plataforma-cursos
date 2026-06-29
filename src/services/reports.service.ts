import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type { LessonReport } from '../types';

/** Only professors and coordenacao may create/delete reports in localStorage mode. */
function assertCanMutate(action: string): void {
  if (isSupabaseConfigured) return;
  const role = getCurrentUserRole();
  if (role !== 'coordenacao' && role !== 'professor') {
    throw new Error(`Sem permissão para ${action} relatórios.`);
  }
}

// ── localStorage fallback ─────────────────────────────────────────────────────

const LS_REPORTS = 'iv_lesson_reports';

function getStored(): LessonReport[] {
  try {
    return JSON.parse(localStorage.getItem(LS_REPORTS) || '[]');
  } catch {
    return [];
  }
}

function save(items: LessonReport[]) {
  localStorage.setItem(LS_REPORTS, JSON.stringify(items));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listReports(): Promise<LessonReport[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_reports')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as LessonReport[];
  }
  return getStored().sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export async function saveReport(
  data: Omit<LessonReport, 'id' | 'created_at'>,
): Promise<LessonReport> {
  assertCanMutate('criar');
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (supabase.from('lesson_reports') as any)
      .insert(data)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row as LessonReport;
  }
  const report: LessonReport = {
    ...data,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
  const items = getStored();
  items.push(report);
  save(items);
  return report;
}

export async function deleteReport(id: string): Promise<void> {
  assertCanMutate('eliminar');
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('lesson_reports').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  save(getStored().filter((r) => r.id !== id));
}
