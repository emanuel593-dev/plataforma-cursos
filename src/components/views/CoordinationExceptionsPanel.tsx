/**
 * CoordinationExceptionsPanel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Painel unificado de pendências operacionais da coordenação com SLA visível.
 *
 * Origem: view SQL `v_coordination_exceptions` (migration 044) consumida via
 * `src/services/exceptions.service.ts`.
 *
 * Implementa as Frentes B (Gestão por exceção) e C (Operação por SLA) da
 * BASE_PROGRESSO_COORDENACAO_2026-05-25.md.
 *
 * Comportamento:
 *   - Renderiza apenas para `role === 'coordenacao'` (controle no chamador).
 *   - Mostra contadores por tipo + lista ordenada por urgência.
 *   - Cada item exibe badge de SLA (Vencido / Vence em breve / No prazo) e
 *     link "Abrir" que navega para a tela operacional do item.
 *   - Atualização: ao montar + refresh manual (botão). Sem polling agressivo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Clock,
  CheckCircle2,
  RefreshCcw,
  ExternalLink,
  Inbox,
} from 'lucide-react';
import {
  listCoordinationExceptions,
  listCoordinationExceptionsSummary,
  EXCEPTION_TYPE_LABEL,
  SLA_STATUS_LABEL,
  type CoordinationException,
  type CoordinationExceptionSummary,
  type ExceptionSlaStatus,
} from '../../services/exceptions.service';
import Button from '../ui/Button';

interface CoordinationExceptionsPanelProps {
  /** Máximo de itens exibidos na lista (default 8). */
  maxItems?: number;
}

const SLA_STYLES: Record<
  ExceptionSlaStatus,
  { dot: string; chip: string; icon: typeof AlertTriangle }
> = {
  overdue: {
    dot: 'bg-red-500',
    chip: 'bg-red-500/15 text-red-300 border-red-500/30',
    icon: AlertTriangle,
  },
  due_soon: {
    dot: 'bg-amber-400',
    chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    icon: Clock,
  },
  on_track: {
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    icon: CheckCircle2,
  },
};

function formatDueIn(dueAt: string | null): string {
  if (!dueAt) return '—';
  const diffMs = new Date(dueAt).getTime() - Date.now();
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  const isPast = diffMs < 0;

  let label: string;
  if (absMin < 60) {
    label = `${absMin} min`;
  } else if (absMin < 60 * 24) {
    const h = Math.round(absMin / 60);
    label = `${h} h`;
  } else {
    const d = Math.round(absMin / (60 * 24));
    label = `${d} d`;
  }
  return isPast ? `há ${label}` : `em ${label}`;
}

/** Formata a data da aula como “DD/MM HH:mm” (ano omitido se for o atual). */
function formatLessonDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart =
    d.getFullYear() === now.getFullYear()
      ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
      : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${datePart} às ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

export default function CoordinationExceptionsPanel({
  maxItems = 8,
}: CoordinationExceptionsPanelProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<CoordinationException[]>([]);
  const [summary, setSummary] = useState<CoordinationExceptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, sum] = await Promise.all([
        listCoordinationExceptions({ limit: 100 }),
        listCoordinationExceptionsSummary(),
      ]);
      setItems(rows);
      setSummary(sum);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar exceções.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [rows, sum] = await Promise.all([
          listCoordinationExceptions({ limit: 100 }),
          listCoordinationExceptionsSummary(),
        ]);
        if (!mounted) return;
        setItems(rows);
        setSummary(sum);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Falha ao carregar exceções.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const totals = useMemo(() => {
    let overdue = 0;
    let dueSoon = 0;
    let total = 0;
    for (const s of summary) {
      total += s.total;
      overdue += s.overdue;
      dueSoon += s.due_soon;
    }
    return { total, overdue, dueSoon };
  }, [summary]);

  const visible = showAll ? items : items.slice(0, maxItems);

  return (
    <section className="glass-panel p-4 sm:p-5 space-y-4">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={18} className="text-amber-400" />
          <h3 className="text-sm sm:text-base font-semibold text-iv-text">
            Painel de exceções
          </h3>
          {!loading && totals.total > 0 && (
            <span className="text-xs text-iv-muted">
              {totals.total} {totals.total === 1 ? 'pendência' : 'pendências'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!loading && totals.overdue > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-300 border border-red-500/30">
              <AlertTriangle size={12} />
              {totals.overdue} vencidos
            </span>
          )}
          {!loading && totals.dueSoon > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <Clock size={12} />
              {totals.dueSoon} próx. vencimento
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={reload}
            leftIcon={<RefreshCcw size={14} />}
            aria-label="Atualizar lista"
            disabled={loading}
          >
            <span className="hidden sm:inline">Atualizar</span>
          </Button>
        </div>
      </header>

      {/* Summary chips por tipo */}
      {summary.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.map((s) => (
            <div
              key={s.exception_type}
              className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-xs"
            >
              <span className="text-iv-text font-medium">
                {EXCEPTION_TYPE_LABEL[s.exception_type] ?? s.exception_type}
              </span>
              <span className="text-iv-muted">·</span>
              <span className="text-iv-muted">{s.total}</span>
              {s.overdue > 0 && (
                <span className="text-red-300">({s.overdue} vencidos)</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="py-8 text-center text-sm text-iv-muted">Carregando…</div>
      ) : error ? (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-sm text-red-300">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div className="py-10 flex flex-col items-center gap-2 text-iv-muted">
          <Inbox size={28} className="opacity-60" />
          <p className="text-sm">Sem pendências em aberto. 👏</p>
        </div>
      ) : (
        <ul className="divide-y divide-white/5">
          {visible.map((it) => {
            const sla = SLA_STYLES[it.sla_status];
            const SlaIcon = sla.icon;
            // Título principal: título da aula se disponível, caso contrário
            // o campo genérico `summary`.
            const title = it.lesson_title && it.lesson_title !== 'Aula'
              ? it.lesson_title
              : it.summary;
            const lessonDate = formatLessonDate(it.lesson_scheduled_at);
            return (
              <li
                key={it.exception_id}
                className="py-3 flex items-start gap-3"
              >
                <span
                  className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${sla.dot}`}
                  aria-hidden
                />
                <div className="flex-1 min-w-0 space-y-0.5">
                  {/* Linha 1: título + badge SLA */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-iv-text font-medium leading-snug">
                      {title}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-wide border ${sla.chip}`}
                    >
                      <SlaIcon size={10} />
                      {SLA_STATUS_LABEL[it.sla_status]}
                    </span>
                  </div>
                  {/* Linha 2: turma + data da aula */}
                  {(it.class_name || lessonDate) && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-iv-muted">
                      {it.class_name && (
                        <span className="font-medium text-iv-text/70 truncate max-w-[180px]">
                          {it.class_name}
                        </span>
                      )}
                      {it.class_name && lessonDate && (
                        <span className="text-white/20">·</span>
                      )}
                      {lessonDate && (
                        <span>{lessonDate}</span>
                      )}
                    </div>
                  )}
                  {/* Linha 3: tipo de exceção + prazo SLA */}
                  <div className="text-xs text-iv-muted/70">
                    {EXCEPTION_TYPE_LABEL[it.exception_type] ?? it.exception_type}
                    {' · prazo '}
                    <span className={it.sla_status === 'overdue' ? 'text-red-400' : ''}>
                      {formatDueIn(it.due_at)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(it.reference_route)}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-iv-text bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                  aria-label={`Abrir ${title}`}
                >
                  Abrir
                  <ExternalLink size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && items.length > maxItems && (
        <div className="pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll
              ? 'Mostrar menos'
              : `Ver todos (${items.length - maxItems} restantes)`}
          </Button>
        </div>
      )}
    </section>
  );
}
