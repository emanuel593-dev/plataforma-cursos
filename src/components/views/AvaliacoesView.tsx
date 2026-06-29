import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  Star,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import EvaluateLessonModal from './EvaluateLessonModal';
import {
  listCompletedLessonsForMonitor,
  listAllEvaluationsWithContext,
  type LessonForEval,
  type EvaluationWithContext,
} from '../../services/lessonEvaluations.service';

// ── Shared helpers ────────────────────────────────────────────────────────────

interface PendingEval {
  scheduledLessonId: string;
  classId: string;
  monitorId: string;
  lessonTitle?: string;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function ScoreStars({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star
          key={n}
          size={12}
          className={n <= value ? 'fill-amber-400 text-amber-400' : 'text-white/20'}
        />
      ))}
    </div>
  );
}

const DURATION_LABEL: Record<string, string> = {
  curta: 'Curta',
  adequada: 'Adequada',
  longa: 'Longa',
};

const DURATION_CLS: Record<string, string> = {
  adequada: 'bg-emerald-500/20 text-emerald-400',
  curta:    'bg-blue-500/20 text-blue-400',
  longa:    'bg-orange-500/20 text-orange-400',
};

// ── Monitor view ──────────────────────────────────────────────────────────────

function MonitorView({
  monitorId,
  pendingEval,
}: {
  monitorId: string;
  pendingEval?: PendingEval;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const [lessons, setLessons] = useState<LessonForEval[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'done'>(
    pendingEval ? 'pending' : 'pending',
  );

  // null = modal closed; otherwise holds the lesson to evaluate
  const [modal, setModal] = useState<LessonForEval | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listCompletedLessonsForMonitor(monitorId)
      .then(setLessons)
      .finally(() => setLoading(false));
  }, [monitorId]);

  useEffect(() => { load(); }, [load]);

  // Auto-open when arriving from ClassroomView with a pendingEval in state.
  // We build a synthetic LessonForEval so the modal receives proper props.
  useEffect(() => {
    if (!pendingEval) return;
    setModal({
      lessonId:    pendingEval.scheduledLessonId,
      classId:     pendingEval.classId,
      classTitle:  pendingEval.lessonTitle ?? 'Aula',
      scheduledAt: new Date().toISOString(),
      evalId:      null,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  const handleClose = () => {
    setModal(null);
    // Clear the location state so back-navigation doesn't re-trigger the auto-open.
    navigate(location.pathname, { replace: true, state: null });
    load();
  };

  const pending = lessons.filter(l => l.evalId === null);
  const done    = lessons.filter(l => l.evalId !== null);
  const shown   = tab === 'pending' ? pending : done;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Star className="text-amber-400 shrink-0" size={22} />
        <h1 className="text-xl font-semibold">Avaliações de Aula</h1>
      </div>

      {/* Post-lesson banner */}
      {pendingEval && (
        <div className="flex items-start gap-3 p-4 bg-amber-500/15 border border-amber-500/40 rounded-xl">
          <AlertCircle className="text-amber-400 shrink-0 mt-0.5" size={18} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-200">
              Avaliação pós-aula pendente
            </p>
            <p className="text-xs text-iv-muted mt-0.5">
              {pendingEval.lessonTitle
                ? `"${pendingEval.lessonTitle}" — `
                : ''}
              Preencha antes de navegar para outra página.
            </p>
          </div>
          <button
            onClick={() =>
              setModal({
                lessonId:    pendingEval.scheduledLessonId,
                classId:     pendingEval.classId,
                classTitle:  pendingEval.lessonTitle ?? 'Aula',
                scheduledAt: new Date().toISOString(),
                evalId:      null,
              })
            }
            className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold shrink-0 transition-colors"
          >
            Avaliar agora
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 rounded-xl p-1 w-fit">
        {(
          [
            ['pending', `Pendentes (${pending.length})`],
            ['done',    `Realizadas (${done.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === key
                ? 'bg-amber-500 text-white'
                : 'text-iv-muted hover:text-iv-text'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12 text-iv-muted">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center py-12 text-iv-muted">
          <ClipboardList size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {tab === 'pending'
              ? 'Nenhuma avaliação pendente'
              : 'Nenhuma avaliação realizada ainda'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map(lesson => (
            <div
              key={lesson.lessonId}
              className="flex items-center gap-4 p-4 bg-iv-surface rounded-xl border border-white/8 hover:border-white/15 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{lesson.classTitle}</p>
                <p className="text-xs text-iv-muted mt-0.5">
                  {formatDate(lesson.scheduledAt)}
                </p>
              </div>

              {lesson.evalId ? (
                <div className="flex items-center gap-1.5 text-emerald-400 text-xs shrink-0">
                  <CheckCircle2 size={14} />
                  <span>Avaliado</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-amber-400 text-xs shrink-0">
                  <Clock size={14} />
                  <span>Pendente</span>
                </div>
              )}

              <button
                onClick={() => setModal(lesson)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 transition-colors ${
                  lesson.evalId
                    ? 'bg-white/8 hover:bg-white/15 text-iv-muted'
                    : 'bg-amber-500 hover:bg-amber-600 text-white'
                }`}
              >
                {lesson.evalId ? 'Ver / Editar' : 'Avaliar'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Evaluation modal */}
      {modal && (
        <EvaluateLessonModal
          open
          onClose={handleClose}
          scheduledLessonId={modal.lessonId}
          classId={modal.classId}
          monitorId={monitorId}
          lessonTitle={modal.classTitle}
        />
      )}
    </div>
  );
}

// ── Coordinator view ──────────────────────────────────────────────────────────

function CoordView() {
  const [evals, setEvals] = useState<EvaluationWithContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    listAllEvaluationsWithContext()
      .then(setEvals)
      .finally(() => setLoading(false));
  }, []);

  const shown = evals.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.classTitle.toLowerCase().includes(q) ||
      (e.monitorName ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Star className="text-amber-400 shrink-0" size={22} />
        <h1 className="text-xl font-semibold">Avaliações de Aula</h1>
      </div>

      <input
        type="search"
        placeholder="Filtrar por turma ou monitor…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full sm:max-w-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-amber-400 transition-colors"
      />

      {loading ? (
        <div className="flex justify-center py-12 text-iv-muted">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center py-12 text-iv-muted">
          <ClipboardList size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhuma avaliação encontrada</p>
        </div>
      ) : (
        <>
          {/* ── Mobile: cards ─────────────────────────────────────────────── */}
          <div className="sm:hidden space-y-3">
            {shown.map(ev => (
              <div key={ev.id} className="glass-panel p-4 border border-white/8 space-y-3">
                {/* Top row: turma + duração badge */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-iv-text">{ev.classTitle}</p>
                    <p className="text-xs text-iv-muted mt-0.5">
                      {formatDate(ev.scheduledAt)}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
                    DURATION_CLS[ev.duration_assessment] ?? 'bg-white/10 text-iv-muted'
                  }`}>
                    {DURATION_LABEL[ev.duration_assessment] ?? ev.duration_assessment}
                  </span>
                </div>
                {/* Monitor */}
                <p className="text-xs text-iv-muted">
                  Monitor: {ev.monitorName ?? `${ev.monitor_id.slice(0, 8)}…`}
                </p>
                {/* Scores grid */}
                <div className="grid grid-cols-3 gap-3">
                  {([
                    ['Conteúdo',    ev.content_score],
                    ['Dinâmicas',   ev.dynamics_score],
                    ['Engajamento', ev.engagement_score],
                  ] as const).map(([label, score]) => (
                    <div key={label}>
                      <p className="text-[10px] text-iv-muted mb-1">{label}</p>
                      <ScoreStars value={score} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop: table ────────────────────────────────────────────── */}
          <div className="hidden sm:block overflow-x-auto rounded-xl border border-white/8">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-iv-muted text-xs">
                  <th className="px-4 py-3 text-left font-medium">Turma</th>
                  <th className="px-4 py-3 text-left font-medium">Data</th>
                  <th className="px-4 py-3 text-left font-medium">Monitor</th>
                  <th className="px-4 py-3 text-center font-medium">Conteúdo</th>
                  <th className="px-4 py-3 text-center font-medium">Dinâmicas</th>
                  <th className="px-4 py-3 text-center font-medium">Engajamento</th>
                  <th className="px-4 py-3 text-center font-medium">Duração</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(ev => (
                  <tr
                    key={ev.id}
                    className="border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium whitespace-nowrap">{ev.classTitle}</td>
                    <td className="px-4 py-3 text-iv-muted whitespace-nowrap">
                      {formatDate(ev.scheduledAt)}
                    </td>
                    <td className="px-4 py-3 text-iv-muted text-xs whitespace-nowrap">
                      {ev.monitorName ?? `${ev.monitor_id.slice(0, 8)}…`}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-center">
                        <ScoreStars value={ev.content_score} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-center">
                        <ScoreStars value={ev.dynamics_score} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-center">
                        <ScoreStars value={ev.engagement_score} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          DURATION_CLS[ev.duration_assessment] ?? 'bg-white/10 text-iv-muted'
                        }`}
                      >
                        {DURATION_LABEL[ev.duration_assessment] ?? ev.duration_assessment}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function AvaliacoesView() {
  const { profile } = useAuth();
  const location = useLocation();

  const pendingEval = (location.state as { pendingEval?: PendingEval } | null)?.pendingEval;

  if (profile?.role === 'monitor') {
    return <MonitorView monitorId={profile.id} pendingEval={pendingEval} />;
  }

  if (profile?.role === 'coordenacao') {
    return <CoordView />;
  }

  return null;
}
