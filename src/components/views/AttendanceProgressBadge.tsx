import { useEffect, useState } from 'react';
import { Clock, CheckCircle2 } from 'lucide-react';

/** Indicador de presença ao vivo para o aluno na sala.
 *
 *  Mostra quanto tempo já conta para a presença automática + quanto falta
 *  para atingir o mínimo de 75 % da aula. Atualiza a cada 15 s.
 *
 *  Não exibe nada quando a aula ainda não foi iniciada formalmente
 *  (lessonStartedAt === null) — nesse cenário o tempo não está sendo contado.
 *
 *  Auditoria §4 Fase C #7.
 */
export interface AttendanceProgressBadgeProps {
  /** Timestamp ms em que o anfitrião clicou "Iniciar aula". `null` enquanto
   *  a aula não foi iniciada — nesse caso o badge não renderiza. */
  lessonStartedAt: number | null;
  /** Duração agendada da aula em minutos (sl.duration_minutes). */
  classDurationMin: number;
  /** Segundos já gravados em `attendance.duration_seconds` antes do join atual
   *  (vem de `priorDurationRef.current`). Re-semeado a cada rejoin. */
  getPriorDurationSec: () => number;
  /** Timestamp ms do join atual (vem de `getJoinedAt()`). `null` se ainda
   *  não entrou — nesse caso só conta o `priorDurationSec`. */
  getJoinedAt: () => number | null;
  /** Razão mínima para presença (default 0.75 — alinhado com `MIN_DURATION_RATIO`). */
  minRatio?: number;
}

const TICK_MS = 15_000;

export function AttendanceProgressBadge({
  lessonStartedAt,
  classDurationMin,
  getPriorDurationSec,
  getJoinedAt,
  minRatio = 0.75,
}: AttendanceProgressBadgeProps) {
  // Tick para re-renderizar com tempo atual.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (lessonStartedAt === null) return;
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, [lessonStartedAt]);

  if (lessonStartedAt === null || classDurationMin <= 0) return null;

  const joinedAt = getJoinedAt();
  const baseStart = joinedAt !== null ? Math.max(joinedAt, lessonStartedAt) : null;
  const sessionSec = baseStart !== null ? Math.max(0, Math.round((Date.now() - baseStart) / 1000)) : 0;
  const countedSec = getPriorDurationSec() + sessionSec;
  const totalSec = classDurationMin * 60;
  const requiredSec = totalSec * minRatio;

  const ratio = totalSec > 0 ? countedSec / totalSec : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const reached = countedSec >= requiredSec;

  if (reached) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-xs font-medium"
        title={`Presença automática garantida (${pct}% da aula).`}
      >
        <CheckCircle2 size={12} />
        Presença garantida · {pct}%
      </span>
    );
  }

  const remainingSec = Math.max(0, Math.ceil(requiredSec - countedSec));
  const remainingMin = Math.floor(remainingSec / 60);
  const remainingSecs = remainingSec % 60;
  const remainingLabel = remainingMin > 0
    ? `${remainingMin} min${remainingSecs >= 30 ? '+' : ''}`
    : `${remainingSec}s`;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-200 text-xs font-medium"
      title={`Permanência atual: ${pct}% (mínimo ${Math.round(minRatio * 100)}%). Faltam ${remainingLabel} para garantir presença.`}
    >
      <Clock size={12} />
      {pct}% · faltam {remainingLabel}
    </span>
  );
}
