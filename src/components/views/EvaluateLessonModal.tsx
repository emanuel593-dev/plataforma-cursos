import React, { useEffect, useState } from 'react';
import { ClipboardCheck, X, Loader2, Star } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import {
  getMyEvaluation,
  upsertEvaluation,
} from '../../services/lessonEvaluations.service';
import type { LessonEvaluationDuration } from '../../types';

// ── EvaluateLessonModal ──────────────────────────────────────────────────────
//
// Confidential post-lesson form filled by class monitors. The data lands in
// `lesson_evaluations` (migration 029) and is read only by coordenação and
// the monitor themself — never by the evaluated professor (RLS).
//
// The modal pre-loads any existing answer so the monitor can revise before
// closing the lesson. Submit is an upsert keyed by
// (scheduled_lesson_id, monitor_id) so re-opens never duplicate rows.

interface Props {
  open: boolean;
  onClose: () => void;
  scheduledLessonId: string;
  classId: string;
  monitorId: string;
  /** Optional friendly label so the monitor knows which lesson they are
   *  evaluating — defaults to a generic title. */
  lessonTitle?: string;
}

const DURATIONS: { value: LessonEvaluationDuration; label: string }[] = [
  { value: 'curta',    label: 'Curta'    },
  { value: 'adequada', label: 'Adequada' },
  { value: 'longa',    label: 'Longa'    },
];

const NOTES_MAX = 4000;
const SUGG_MAX  = 2000;

export default function EvaluateLessonModal({
  open, onClose, scheduledLessonId, classId, monitorId, lessonTitle,
}: Props) {
  const { showToast } = useToast();
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [content, setContent]     = useState<number>(0);
  const [duration, setDuration]   = useState<LessonEvaluationDuration>('adequada');
  const [dynamics, setDynamics]   = useState<number>(0);
  const [engagement, setEngagement] = useState<number>(0);
  const [notes, setNotes]         = useState('');
  const [suggestions, setSugg]    = useState('');

  // Load existing answer (if any) every time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getMyEvaluation(scheduledLessonId, monitorId)
      .then((row) => {
        if (cancelled) return;
        if (row) {
          setContent(row.content_score);
          setDuration(row.duration_assessment);
          setDynamics(row.dynamics_score);
          setEngagement(row.engagement_score);
          setNotes(row.notes ?? '');
          setSugg(row.suggestions ?? '');
        } else {
          // Reset to defaults — the monitor opened the form for a fresh entry.
          setContent(0);
          setDuration('adequada');
          setDynamics(0);
          setEngagement(0);
          setNotes('');
          setSugg('');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, scheduledLessonId, monitorId]);

  // ESC closes the modal — matches the rest of the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = content >= 1 && dynamics >= 1 && engagement >= 1 && !saving;

  async function handleSubmit() {
    if (!canSubmit) {
      showToast('Preencha todas as notas (1 a 5).', 'warning');
      return;
    }
    setSaving(true);
    try {
      await upsertEvaluation({
        scheduled_lesson_id: scheduledLessonId,
        class_id: classId,
        monitor_id: monitorId,
        content_score: content,
        duration_assessment: duration,
        dynamics_score: dynamics,
        engagement_score: engagement,
        notes: notes.trim() ? notes.trim() : null,
        suggestions: suggestions.trim() ? suggestions.trim() : null,
      });
      showToast('Avaliação enviada à coordenação.', 'success');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao enviar avaliação.';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="eval-lesson-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-iv-surface text-iv-text rounded-2xl shadow-2xl w-full max-w-lg my-8 border border-white/10">
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardCheck className="text-amber-400 shrink-0" size={20} />
            <div className="min-w-0">
              <h2 id="eval-lesson-title" className="text-base font-semibold truncate">Avaliar aula</h2>
              {lessonTitle && (
                <p className="text-xs text-iv-muted truncate">{lessonTitle}</p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 text-iv-muted touch-target"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </header>

        {loading ? (
          <div className="p-8 flex items-center justify-center text-iv-muted">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : (
          <div className="p-4 space-y-5 max-h-[70vh] overflow-y-auto">
            <p className="text-xs text-iv-muted bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              Esta avaliação é <strong>confidencial</strong> e visível apenas para você e para a coordenação. O professor avaliado não tem acesso.
            </p>

            <ScoreField label="Conteúdo apresentado" value={content} onChange={setContent} />

            <div>
              <label className="block text-sm font-medium mb-2">Duração da aula</label>
              <div className="flex gap-2">
                {DURATIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDuration(value)}
                    className={
                      'flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ' +
                      (duration === value
                        ? 'bg-amber-500 border-amber-400 text-white'
                        : 'bg-white/5 border-white/10 text-iv-muted hover:bg-white/10')
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <ScoreField label="Dinâmicas / atividades" value={dynamics} onChange={setDynamics} />
            <ScoreField label="Engajamento da turma" value={engagement} onChange={setEngagement} />

            <div>
              <label htmlFor="eval-notes" className="block text-sm font-medium mb-2">
                Observações <span className="text-iv-muted text-xs">(opcional)</span>
              </label>
              <textarea
                id="eval-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX))}
                rows={4}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-amber-400"
                placeholder="O que chamou atenção durante a aula?"
              />
              <p className="text-[11px] text-iv-muted text-right mt-1">{notes.length} / {NOTES_MAX}</p>
            </div>

            <div>
              <label htmlFor="eval-sugg" className="block text-sm font-medium mb-2">
                Sugestões <span className="text-iv-muted text-xs">(opcional)</span>
              </label>
              <textarea
                id="eval-sugg"
                value={suggestions}
                onChange={(e) => setSugg(e.target.value.slice(0, SUGG_MAX))}
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-amber-400"
                placeholder="Ideias de melhoria para próximas aulas."
              />
              <p className="text-[11px] text-iv-muted text-right mt-1">{suggestions.length} / {SUGG_MAX}</p>
            </div>
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 p-4 border-t border-white/10">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 className="animate-spin" size={14} />}
            Enviar avaliação
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Score field (1..5 stars) ─────────────────────────────────────────────────

function ScoreField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2">{label}</label>
      <div className="flex gap-1.5" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            onClick={() => onChange(n)}
            className={
              'flex-1 py-2 rounded-lg border transition-colors flex items-center justify-center gap-1 ' +
              (value >= n
                ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                : 'bg-white/5 border-white/10 text-iv-muted hover:bg-white/10')
            }
          >
            <Star size={14} className={value >= n ? 'fill-amber-300 text-amber-300' : ''} />
            <span className="text-xs font-semibold">{n}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
