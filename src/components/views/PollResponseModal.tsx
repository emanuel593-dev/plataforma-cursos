import React, { useEffect, useState } from 'react';
import { X, Loader2, CheckCircle2, MessageSquare } from 'lucide-react';
import { upsertResponse, getMyResponse } from '../../services/lessonPolls.service';
import type { LessonPoll } from '../../types';
import { useToast } from '../../contexts/ToastContext';

// ── PollResponseModal ────────────────────────────────────────────────────────
//
// Student-facing modal that pops up when an open poll is detected for the
// current lesson. The parent (ClassroomView) decides when to mount us — it
// listens to `subscribeToPolls` and shows this modal as long as a poll
// with status='open' exists. After submission we keep the modal up showing
// the confirmation; closing is the student's choice.
//
// The student CAN edit their answer while the poll stays open (RLS allows
// UPDATE under the same gating). Once the poll closes, the parent unmounts
// the modal automatically (the open-poll selector returns null).

interface Props {
  poll: LessonPoll;
  classId: string;
  studentId: string;
  onClose: () => void;
}

export default function PollResponseModal({ poll, classId, studentId, onClose }: Props) {
  const { showToast } = useToast();
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText]         = useState('');

  // Pre-populate from server in case the student already answered (e.g. they
  // refreshed mid-poll). maybeSingle returns null if no row exists.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMyResponse(poll.id, studentId).then((row) => {
      if (cancelled) return;
      if (row) {
        setSelected(row.selected_option);
        setText(row.text_answer ?? '');
        setSubmittedAt(row.submitted_at);
      } else {
        setSelected(null);
        setText('');
        setSubmittedAt(null);
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [poll.id, studentId]);

  const canSubmit =
    !saving && (
      poll.kind === 'open_text'
        ? text.trim().length > 0
        : selected != null
    );

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const row = await upsertResponse({
        poll_id: poll.id,
        class_id: classId,
        student_id: studentId,
        selected_option: poll.kind === 'open_text' ? null : selected,
        text_answer: poll.kind === 'open_text' ? text.trim() : null,
      });
      setSubmittedAt(row.submitted_at);
      showToast('Resposta enviada!', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao enviar resposta.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-iv-surface text-iv-text rounded-2xl shadow-2xl w-full max-w-md border border-amber-400/30">
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <MessageSquare className="text-amber-400 shrink-0" size={18} />
            <h2 className="text-base font-semibold truncate">Dinâmica em andamento</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 text-iv-muted touch-target"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </header>

        <div className="p-4 space-y-4">
          <p className="text-sm text-iv-text font-medium">{poll.question}</p>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="animate-spin text-iv-muted" size={20} />
            </div>
          ) : poll.kind === 'open_text' ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 1000))}
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-amber-400"
              placeholder="Sua resposta..."
            />
          ) : (
            <div className="space-y-2">
              {poll.options?.map((opt, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSelected(idx)}
                  className={
                    'w-full px-3 py-2.5 rounded-lg border text-sm text-left transition-colors flex items-center gap-2 ' +
                    (selected === idx
                      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                      : 'bg-white/5 border-white/10 text-iv-text hover:bg-white/10')
                  }
                >
                  <span className={
                    'shrink-0 w-6 h-6 rounded-full border flex items-center justify-center text-xs font-semibold ' +
                    (selected === idx
                      ? 'bg-amber-500 border-amber-400 text-white'
                      : 'border-white/20 text-iv-muted')
                  }>
                    {String.fromCharCode(65 + idx)}
                  </span>
                  <span className="flex-1">{opt}</span>
                </button>
              ))}
            </div>
          )}

          {submittedAt && (
            <p className="text-xs text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={12} />
              Resposta registrada às {new Date(submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.
              Você pode alterá-la enquanto a dinâmica estiver aberta.
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 p-4 border-t border-white/10">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium disabled:opacity-50"
          >
            Fechar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 className="animate-spin" size={14} />}
            {submittedAt ? 'Atualizar' : 'Enviar'}
          </button>
        </footer>
      </div>
    </div>
  );
}
