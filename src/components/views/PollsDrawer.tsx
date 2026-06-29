import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Play, Square, Trash2, BarChart3, MessageSquare, CheckSquare, ToggleLeft, Loader2 } from 'lucide-react';
import {
  createPoll, openPoll, closePoll, deletePoll,
  listPollResponses, subscribeToPollResponses,
  tallyResponses, hasOpenPoll,
} from '../../services/lessonPolls.service';
import type { LessonPoll, LessonPollKind, LessonPollResponse } from '../../types';
import { useToast } from '../../contexts/ToastContext';

// ── PollsDrawer ──────────────────────────────────────────────────────────────
//
// Side drawer for class staff (monitor / professor / coordenação) to author
// and run live polls during a lesson. Keeps the lesson_polls list in sync
// via Realtime so a coordenador opening the drawer mid-class sees the same
// state as the monitor who created the polls.
//
// Constraints baked in:
//   • At most ONE open poll per lesson — simplifies the student UX (single
//     modal at a time). The "Abrir" button is disabled while another is
//     running (`hasOpenPoll`).
//   • Drafts are editable; once opened the question is frozen (UI-side).

interface Props {
  open: boolean;
  onClose: () => void;
  scheduledLessonId: string;
  classId: string;
  authorId: string;
  /** Poll list kept live by ClassroomView's subscription — passed down to
   *  avoid a duplicate `polls:{scheduledLessonId}` Supabase Realtime channel
   *  that would cause double-event delivery and potential connection errors. */
  polls: LessonPoll[];
}

const KIND_LABEL: Record<LessonPollKind, string> = {
  multiple_choice: 'Múltipla escolha',
  true_false:      'Verdadeiro / Falso',
  open_text:       'Resposta aberta',
};

export default function PollsDrawer({ open, onClose, scheduledLessonId, classId, authorId, polls }: Props) {
  const { showToast } = useToast();
  const [creating, setCreating] = useState(false);
  // expandedId controls which poll's results are visible. Only one at a
  // time to keep the drawer compact on mobile.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const anotherOpen = hasOpenPoll(polls);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex justify-end bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <aside className="w-full sm:max-w-md bg-iv-surface border-l border-white/10 flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <BarChart3 className="text-amber-400" size={18} />
            <h2 className="text-base font-semibold text-iv-text">Dinâmicas</h2>
            {polls.length > 0 && (
              <span className="text-xs text-iv-muted">({polls.length})</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCreating(true)}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-400/40 text-xs font-semibold flex items-center gap-1.5"
            >
              <Plus size={14} /> Nova
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-white/10 text-iv-muted touch-target"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {polls.length === 0 ? (
            <p className="text-sm text-iv-muted text-center py-8">
              Nenhuma dinâmica criada ainda. Use <strong>Nova</strong> para criar.
            </p>
          ) : (
            polls.map((p) => (
              <PollCard
                key={p.id}
                poll={p}
                expanded={expandedId === p.id}
                onToggleExpand={() => setExpandedId((cur) => cur === p.id ? null : p.id)}
                onOpen={async () => {
                  if (anotherOpen && p.status !== 'open') {
                    showToast('Encerre a dinâmica em andamento antes de abrir outra.', 'warning');
                    return;
                  }
                  try { await openPoll(p.id); } catch (e) {
                    showToast(e instanceof Error ? e.message : 'Erro ao abrir.', 'error');
                  }
                }}
                onClose={async () => {
                  try { await closePoll(p.id); } catch (e) {
                    showToast(e instanceof Error ? e.message : 'Erro ao encerrar.', 'error');
                  }
                }}
                onDelete={async () => {
                  if (!window.confirm('Excluir esta dinâmica e todas as respostas?')) return;
                  try {
                    await deletePoll(p.id);
                    if (expandedId === p.id) setExpandedId(null);
                  } catch (e) {
                    showToast(e instanceof Error ? e.message : 'Erro ao excluir.', 'error');
                  }
                }}
              />
            ))
          )}
        </div>
      </aside>

      {creating && (
        <CreatePollModal
          onClose={() => setCreating(false)}
          onCreated={(p) => { setCreating(false); setExpandedId(p.id); }}
          scheduledLessonId={scheduledLessonId}
          classId={classId}
          authorId={authorId}
        />
      )}
    </div>
  );
}

// ── PollCard: one row, with results when expanded ────────────────────────────

interface PollCardProps {
  poll: LessonPoll;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
}

function PollCard({ poll, expanded, onToggleExpand, onOpen, onClose, onDelete }: PollCardProps) {
  const [responses, setResponses] = useState<LessonPollResponse[]>([]);
  const [loading, setLoading]     = useState(false);

  // Lazy load + realtime only while expanded — avoids running N
  // subscriptions when the drawer holds many historical polls.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    listPollResponses(poll.id).then((rows) => {
      if (!cancelled) setResponses(rows);
    }).finally(() => { if (!cancelled) setLoading(false); });

    const unsub = subscribeToPollResponses(poll.id, (event, row, oldRow) => {
      setResponses((prev) => {
        if (event === 'DELETE') return prev.filter((r) => r.id !== oldRow?.id);
        if (!row) return prev;
        const idx = prev.findIndex((r) => r.id === row.id);
        if (idx === -1) return [...prev, row];
        const next = prev.slice();
        next[idx] = row;
        return next;
      });
    });
    return () => { cancelled = true; unsub(); };
  }, [expanded, poll.id]);

  const counts = useMemo(() => tallyResponses(poll, responses), [poll, responses]);
  const total  = responses.length;
  const max    = Math.max(1, ...counts);

  const statusBadge =
    poll.status === 'open'   ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : poll.status === 'closed' ? 'bg-iv-muted/15 text-iv-muted border-white/10'
    : 'bg-amber-500/15 text-amber-300 border-amber-500/30';

  const Icon = poll.kind === 'multiple_choice' ? CheckSquare
    : poll.kind === 'true_false' ? ToggleLeft
    : MessageSquare;

  return (
    <div className="glass-panel p-3 space-y-2 border border-white/8">
      <button
        onClick={onToggleExpand}
        className="w-full text-left flex items-start gap-2"
      >
        <Icon size={14} className="text-iv-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-iv-text line-clamp-2">{poll.question}</p>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-iv-muted">
            <span className={`px-2 py-0.5 rounded-full border ${statusBadge}`}>{poll.status}</span>
            <span>{KIND_LABEL[poll.kind]}</span>
            {total > 0 && <span>· {total} {total === 1 ? 'resposta' : 'respostas'}</span>}
          </div>
        </div>
      </button>

      <div className="flex items-center gap-1.5 flex-wrap">
        {poll.status === 'draft' && (
          <button
            onClick={onOpen}
            className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-xs flex items-center gap-1 border border-emerald-500/30"
          >
            <Play size={11} /> Abrir
          </button>
        )}
        {poll.status === 'open' && (
          <button
            onClick={onClose}
            className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 text-xs flex items-center gap-1 border border-amber-500/30"
          >
            <Square size={11} /> Encerrar
          </button>
        )}
        {poll.status !== 'open' && (
          <button
            onClick={onDelete}
            className="px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 text-xs flex items-center gap-1 border border-red-500/30 ml-auto"
            title="Excluir dinâmica"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="pt-2 border-t border-white/5 space-y-1.5">
          {loading ? (
            <Loader2 className="animate-spin mx-auto text-iv-muted" size={16} />
          ) : poll.kind === 'open_text' ? (
            responses.length === 0 ? (
              <p className="text-xs text-iv-muted text-center py-2">Sem respostas ainda.</p>
            ) : (
              <ul className="space-y-1">
                {responses.map((r) => (
                  <li key={r.id} className="text-xs text-iv-muted bg-white/[0.02] rounded-lg px-2.5 py-1.5 border border-white/5">
                    {r.text_answer || <em className="text-iv-muted/60">vazio</em>}
                  </li>
                ))}
              </ul>
            )
          ) : (
            poll.options?.map((opt, idx) => {
              const c = counts[idx] ?? 0;
              const pct = total === 0 ? 0 : Math.round((c / total) * 100);
              const isCorrect = poll.correct_option === idx;
              return (
                <div key={idx} className="space-y-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className={`truncate ${isCorrect ? 'text-emerald-300 font-semibold' : 'text-iv-text'}`}>
                      {isCorrect && '✓ '}{opt}
                    </span>
                    <span className="text-iv-muted text-[10px]">{c} · {pct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={`h-full ${isCorrect ? 'bg-emerald-400' : 'bg-amber-400'}`}
                      style={{ width: `${(c / max) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── CreatePollModal ──────────────────────────────────────────────────────────

interface CreatePollModalProps {
  onClose: () => void;
  onCreated: (p: LessonPoll) => void;
  scheduledLessonId: string;
  classId: string;
  authorId: string;
}

function CreatePollModal({ onClose, onCreated, scheduledLessonId, classId, authorId }: CreatePollModalProps) {
  const { showToast } = useToast();
  const [kind, setKind]         = useState<LessonPollKind>('multiple_choice');
  const [question, setQuestion] = useState('');
  const [options, setOptions]   = useState<string[]>(['', '']);
  const [correct, setCorrect]   = useState<number | null>(null);
  const [saving, setSaving]     = useState(false);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // True/False auto-fills options and locks them.
  useEffect(() => {
    if (kind === 'true_false') {
      setOptions(['Verdadeiro', 'Falso']);
    } else if (kind === 'open_text') {
      setOptions([]);
      setCorrect(null);
    } else if (options.length < 2) {
      setOptions(['', '']);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const canSave =
    question.trim().length > 0 &&
    !saving &&
    (kind === 'open_text' ||
      (options.length >= 2 && options.every((o) => o.trim().length > 0)));

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const finalOptions =
        kind === 'open_text' ? null
        : options.map((o) => o.trim());
      const finalCorrect =
        kind === 'open_text' || correct == null ? null
        : (correct >= 0 && correct < (finalOptions?.length ?? 0) ? correct : null);
      const created = await createPoll({
        scheduled_lesson_id: scheduledLessonId,
        class_id: classId,
        created_by: authorId,
        kind,
        question: question.trim(),
        options: finalOptions,
        correct_option: finalCorrect,
      });
      showToast('Dinâmica criada como rascunho.', 'success');
      onCreated(created);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao criar dinâmica.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-iv-surface text-iv-text rounded-2xl shadow-2xl w-full max-w-md my-8 border border-white/10">
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 className="text-base font-semibold">Nova dinâmica</h3>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-iv-muted">
            <X size={18} />
          </button>
        </header>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-sm font-medium mb-2">Tipo</label>
            <div className="grid grid-cols-3 gap-2">
              {(['multiple_choice', 'true_false', 'open_text'] as LessonPollKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={
                    'px-2 py-2 rounded-lg text-xs font-medium border transition-colors ' +
                    (kind === k
                      ? 'bg-amber-500 border-amber-400 text-white'
                      : 'bg-white/5 border-white/10 text-iv-muted hover:bg-white/10')
                  }
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="poll-q" className="block text-sm font-medium mb-2">Pergunta</label>
            <textarea
              id="poll-q"
              value={question}
              onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-amber-400"
              placeholder="O que você quer perguntar?"
            />
            <p className="text-[11px] text-iv-muted text-right mt-1">{question.length} / 500</p>
          </div>

          {kind !== 'open_text' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                Opções <span className="text-iv-muted text-xs">(2 a 6)</span>
              </label>
              <div className="space-y-2">
                {options.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCorrect(correct === idx ? null : idx)}
                      title={correct === idx ? 'Marcada como correta' : 'Marcar como correta (opcional)'}
                      className={
                        'shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-xs ' +
                        (correct === idx
                          ? 'bg-emerald-500 border-emerald-400 text-white'
                          : 'bg-white/5 border-white/10 text-iv-muted hover:bg-white/10')
                      }
                    >
                      {correct === idx ? '✓' : String.fromCharCode(65 + idx)}
                    </button>
                    <input
                      type="text"
                      value={opt}
                      disabled={kind === 'true_false'}
                      onChange={(e) => {
                        const next = options.slice();
                        next[idx] = e.target.value.slice(0, 200);
                        setOptions(next);
                      }}
                      className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-amber-400 disabled:opacity-60"
                      placeholder={`Opção ${idx + 1}`}
                    />
                    {kind === 'multiple_choice' && options.length > 2 && (
                      <button
                        type="button"
                        onClick={() => {
                          setOptions(options.filter((_, i) => i !== idx));
                          if (correct === idx) setCorrect(null);
                          else if (correct != null && correct > idx) setCorrect(correct - 1);
                        }}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-iv-muted"
                        aria-label="Remover opção"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {kind === 'multiple_choice' && options.length < 6 && (
                  <button
                    type="button"
                    onClick={() => setOptions([...options, ''])}
                    className="text-xs text-amber-300 hover:text-amber-200 flex items-center gap-1"
                  >
                    <Plus size={12} /> Adicionar opção
                  </button>
                )}
              </div>
              <p className="text-[11px] text-iv-muted mt-2">
                Marque o círculo da letra para definir a resposta correta (opcional).
              </p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 p-4 border-t border-white/10">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
          >
            {saving && <Loader2 className="animate-spin" size={14} />}
            Criar rascunho
          </button>
        </footer>
      </div>
    </div>
  );
}
