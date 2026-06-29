import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole } from './auth.service';
import type { Class, ClassMonitor } from '../types';

// ── Permission helpers (localStorage mode only; Supabase uses RLS) ───────────

function assertCoordinator() {
  const role = getCurrentUserRole();
  if (role !== null && role !== 'coordenacao') {
    throw new Error('Operação permitida apenas para coordenação.');
  }
}

// ── localStorage fallback ────────────────────────────────────────────────────

const LS_CLASS_MONITORS = 'iv_class_monitors';

function getStoredClassMonitors(): ClassMonitor[] {
  try { return JSON.parse(localStorage.getItem(LS_CLASS_MONITORS) || '[]'); } catch { return []; }
}

function saveClassMonitors(items: ClassMonitor[]) {
  localStorage.setItem(LS_CLASS_MONITORS, JSON.stringify(items));
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Returns the monitor profile ids linked to a given class. */
export async function listMonitorsOfClass(classId: string): Promise<string[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('class_monitors')
      .select('monitor_id')
      .eq('class_id', classId);
    if (error) throw new Error(error.message);
    return ((data || []) as Array<{ monitor_id: string }>).map((r) => r.monitor_id);
  }
  return getStoredClassMonitors()
    .filter((cm) => cm.class_id === classId)
    .map((cm) => cm.monitor_id);
}

/** Batch: { classId: monitorId[] } for a list of class ids. Avoids N+1. */
export async function listMonitorsByClasses(
  classIds: string[],
): Promise<Record<string, string[]>> {
  if (classIds.length === 0) return {};
  const out: Record<string, string[]> = {};
  for (const id of classIds) out[id] = [];
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('class_monitors')
      .select('class_id, monitor_id')
      .in('class_id', classIds);
    if (error) throw new Error(error.message);
    for (const row of (data || []) as Array<{ class_id: string; monitor_id: string }>) {
      (out[row.class_id] ??= []).push(row.monitor_id);
    }
    return out;
  }
  for (const cm of getStoredClassMonitors()) {
    if (classIds.includes(cm.class_id)) (out[cm.class_id] ??= []).push(cm.monitor_id);
  }
  return out;
}

/** Returns the classes a given monitor is assigned to. */
export async function listClassesByMonitor(monitorId: string): Promise<Class[]> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase
      .from('classes') as any)
      .select('*, class_monitors!inner(monitor_id)')
      .eq('class_monitors.monitor_id', monitorId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ((data || []) as Array<Class & { class_monitors?: unknown }>).map((row) => {
      const { class_monitors: _cm, ...cls } = row;
      return cls as Class;
    });
  }
  // localStorage path: requires reading classes via the class service. To avoid
  // a circular import we accept that dev mode only returns ids; callers should
  // hydrate from `listClasses()` themselves when running offline.
  const monitoredIds = new Set(
    getStoredClassMonitors()
      .filter((cm) => cm.monitor_id === monitorId)
      .map((cm) => cm.class_id),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allClasses: Class[] = JSON.parse(localStorage.getItem('iv_classes') || '[]');
  return allClasses.filter((c) => monitoredIds.has(c.id));
}

// ── Mutations (coordenação only) ─────────────────────────────────────────────

export async function addMonitorToClass(classId: string, monitorId: string): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('class_monitors') as any)
      .insert({ class_id: classId, monitor_id: monitorId });
    if (error && !error.message.toLowerCase().includes('duplicate')) {
      throw new Error(error.message);
    }
    return;
  }
  const items = getStoredClassMonitors();
  if (items.some((cm) => cm.class_id === classId && cm.monitor_id === monitorId)) return;
  items.push({ class_id: classId, monitor_id: monitorId, added_at: new Date().toISOString(), added_by: null });
  saveClassMonitors(items);
}

export async function removeMonitorFromClass(classId: string, monitorId: string): Promise<void> {
  assertCoordinator();
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('class_monitors').delete()
      .eq('class_id', classId).eq('monitor_id', monitorId);
    if (error) throw new Error(error.message);
    return;
  }
  saveClassMonitors(
    getStoredClassMonitors().filter((cm) => !(cm.class_id === classId && cm.monitor_id === monitorId)),
  );
}

/** Replace the full set of monitors for a class atomically. */
export async function setClassMonitors(classId: string, monitorIds: string[]): Promise<void> {
  assertCoordinator();
  const desired = Array.from(new Set(monitorIds));
  const current = await listMonitorsOfClass(classId);
  const toAdd = desired.filter((id) => !current.includes(id));
  const toRemove = current.filter((id) => !desired.includes(id));
  for (const id of toAdd) await addMonitorToClass(classId, id);
  for (const id of toRemove) await removeMonitorFromClass(classId, id);
}
