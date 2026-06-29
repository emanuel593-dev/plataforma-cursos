/**
 * exceptions.service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Consumidor da view `v_coordination_exceptions` (migration 044).
 * Fornece a fila unificada de pendências da coordenação com SLA calculado
 * server-side. Usado pelo painel `CoordinationExceptionsPanel`.
 *
 * Quando Supabase não está configurado (dev/offline), retorna lista vazia —
 * exceções são puramente derivadas do banco; não há equivalente local.
 */

import { supabase, isSupabaseConfigured } from '../lib/supabase';

/**
 * Verifica se o erro do Supabase/PostgREST significa que a view/tabela
 * simplesmente não existe (migration 044 não aplicada no ambiente).
 * Cobre:
 *   - Postgres 42P01 (undefined_table)
 *   - PostgREST PGRST205 ("Could not find the table ... in the schema cache")
 *   - PostgREST PGRST204 (schema cache miss)
 *   - mensagens contendo "does not exist" ou "schema cache"
 */
function isMissingRelation(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('schema cache');
}

export type ExceptionType =
  | 'makeup_pending'
  | 'makeup_review'
  | 'lesson_no_report';

export type ExceptionSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ExceptionSlaStatus = 'overdue' | 'due_soon' | 'on_track';

export interface CoordinationException {
  exception_type: ExceptionType;
  exception_id: string;
  source_table: string;
  source_id: string;
  severity: ExceptionSeverity;
  subject_user_id: string | null;
  class_id: string | null;
  scheduled_lesson_id: string | null;
  summary: string;
  reference_route: string;
  opened_at: string | null;
  due_at: string | null;
  sla_status: ExceptionSlaStatus;
  /** Campos de contexto adicionados na migration 045 */
  class_name: string | null;
  lesson_title: string | null;
  lesson_scheduled_at: string | null;
}

export interface CoordinationExceptionSummary {
  exception_type: ExceptionType;
  total: number;
  overdue: number;
  due_soon: number;
  on_track: number;
  critical: number;
  high: number;
}

export interface ListExceptionsOptions {
  /** Filtrar por tipo. Vazio = todos. */
  types?: ExceptionType[];
  /** Limite (default 50). */
  limit?: number;
  /** Apenas itens vencidos ou prestes a vencer. */
  onlyAtRisk?: boolean;
}

/**
 * Lista as exceções da coordenação ordenadas por urgência:
 *   overdue → due_soon → on_track,
 *   depois por severidade (critical → low),
 *   depois pelo prazo (`due_at` ascendente).
 */
export async function listCoordinationExceptions(
  opts: ListExceptionsOptions = {},
): Promise<CoordinationException[]> {
  if (!isSupabaseConfigured) return [];

  const { types, limit = 50, onlyAtRisk = false } = opts;

  let query = supabase
    .from('v_coordination_exceptions')
    .select('*')
    .limit(limit);

  if (types && types.length > 0) {
    query = query.in('exception_type', types);
  }
  if (onlyAtRisk) {
    query = query.in('sla_status', ['overdue', 'due_soon']);
  }

  const { data, error } = await query;
  if (error) {
    // View ausente (deploy sem migration 044) → degrada silenciosamente.
    if (isMissingRelation(error)) {
      console.warn('[exceptions] v_coordination_exceptions ausente:', error.message);
      return [];
    }
    throw new Error(error.message);
  }

  const rows = (data ?? []) as CoordinationException[];

  // Ordenação client-side (a view não ordena para permitir múltiplos consumos).
  const slaWeight: Record<ExceptionSlaStatus, number> = {
    overdue: 0,
    due_soon: 1,
    on_track: 2,
  };
  const sevWeight: Record<ExceptionSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return rows.sort((a, b) => {
    const slaDiff = slaWeight[a.sla_status] - slaWeight[b.sla_status];
    if (slaDiff !== 0) return slaDiff;
    const sevDiff = sevWeight[a.severity] - sevWeight[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });
}

/**
 * Retorna contadores agregados por tipo (overdue / due_soon / on_track /
 * critical / high). Usado pelos badges do header do painel.
 */
export async function listCoordinationExceptionsSummary(): Promise<
  CoordinationExceptionSummary[]
> {
  if (!isSupabaseConfigured) return [];

  const { data, error } = await supabase
    .from('v_coordination_exceptions_summary')
    .select('*');

  if (error) {
    if (isMissingRelation(error)) {
      console.warn(
        '[exceptions] v_coordination_exceptions_summary ausente:',
        error.message,
      );
      return [];
    }
    throw new Error(error.message);
  }
  return (data ?? []) as CoordinationExceptionSummary[];
}

/** Labels PT-BR para a UI. */
export const EXCEPTION_TYPE_LABEL: Record<ExceptionType, string> = {
  makeup_pending: 'FJ aguardando reposição',
  makeup_review: 'Resumo aguardando revisão',
  lesson_no_report: 'Aula sem relatório',
};

export const SLA_STATUS_LABEL: Record<ExceptionSlaStatus, string> = {
  overdue: 'Vencido',
  due_soon: 'Vence em breve',
  on_track: 'No prazo',
};

export const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  critical: 'Crítico',
  high: 'Alto',
  medium: 'Médio',
  low: 'Baixo',
};
