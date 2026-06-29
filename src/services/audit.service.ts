import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { AuditLog, AuditLogInsert } from '../types';

const LS_AUDIT_LOGS = 'iv_audit_logs';

function getStored(): AuditLog[] {
  try {
    return JSON.parse(localStorage.getItem(LS_AUDIT_LOGS) || '[]');
  } catch {
    return [];
  }
}

function save(items: AuditLog[]) {
  localStorage.setItem(LS_AUDIT_LOGS, JSON.stringify(items));
}

export async function writeAuditLog(input: AuditLogInsert): Promise<void> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('audit_logs') as any).insert(input);
    if (error) {
      // Direct client INSERTs into audit_logs were intentionally blocked by
      // mig 039 (M-3 hardening). Telemetry-style callers (WebRTC, audio
      // snapshots) should not break the call — log at debug level and move
      // on. SECURITY DEFINER RPCs handle legitimate audit writes server-side.
      const isRlsBlock = /row-level security|row violates|permission denied/i.test(error.message);
      if (isRlsBlock) {
        if (typeof console !== 'undefined' && console.debug) {
          console.debug('[IV] audit_logs insert blocked by RLS (expected for client telemetry):', input.action);
        }
        return;
      }
      throw new Error(`Falha ao registrar auditoria: ${error.message}`);
    }
    return;
  }
  const item: AuditLog = {
    id: crypto.randomUUID(),
    ...input,
    created_at: new Date().toISOString(),
  };
  const all = getStored();
  all.push(item);
  save(all);
}

export async function listAuditLogs(limit = 50): Promise<AuditLog[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data || []) as AuditLog[];
  }
  return getStored()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}

export async function listAuditLogsByEntity(entity: string, entityId: string): Promise<AuditLog[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('entity', entity)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as AuditLog[];
  }
  return getStored()
    .filter((l) => l.entity === entity && l.entity_id === entityId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}
