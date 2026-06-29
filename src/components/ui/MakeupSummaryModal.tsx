/**
 * MakeupSummaryModal.tsx
 *
 * Modal for the student to write and submit the mandatory class summary
 * after watching a makeup (reposição) recording.
 *
 * Rules:
 *  - Minimum 400 characters (enforced internally, not surfaced to the user)
 *  - Friendly progress messages instead of raw counts
 *  - Submit disabled until threshold met
 *  - If a `deadline` prop is passed and already in the past, submission is
 *    blocked with an explicit message (mirrors the backend gate).
 */

import React, { useState, useCallback } from 'react';
import { X, BookOpen, AlertCircle, CheckCircle2, Loader2, Send, Clock } from 'lucide-react';
import { submitSummary } from '../../services/makeup.service';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';

const MIN_CHARS = 400;

interface Props {
  submissionId: string;
  recordingTitle: string;
  /** Optional deadline ISO string. If past → submission is blocked. */
  deadline?: string | null;
  /** Pre-fill the textarea — used when re-submitting after rejection so the
   *  student can refine the previous text instead of rewriting from scratch. */
  initialText?: string | null;
  /** Coordinator/reviewer feedback shown at the top when re-submitting. */
  reviewerNotes?: string | null;
  /** When true, header copy + button label switch to "Reenviar resumo". */
  isResubmission?: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function relativeTo(iso: string): { text: string; expired: boolean; soon: boolean } {
  const ms = new Date(iso).getTime() - Date.now();
  const expired = ms <= 0;
  const soon = !expired && ms < 48 * 60 * 60 * 1000;
  if (expired) return { text: 'prazo encerrado', expired, soon };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return { text: 'menos de 1 hora restante', expired, soon };
  if (hours < 24) return { text: `${hours} ${hours === 1 ? 'hora restante' : 'horas restantes'}`, expired, soon };
  const days = Math.floor(hours / 24);
  return { text: `${days} ${days === 1 ? 'dia restante' : 'dias restantes'}`, expired, soon };
}

export default function MakeupSummaryModal({
  submissionId,
  recordingTitle,
  deadline,
  initialText,
  reviewerNotes,
  isResubmission,
  onClose,
  onSubmitted,
}: Props) {
  const { showToast } = useToast();
  const [text,     setText]     = useState(initialText ?? '');
  const [saving,   setSaving]   = useState(false);

  const charCount    = text.length;
  const meetsMin     = charCount >= MIN_CHARS;
  const deadlineInfo = deadline ? relativeTo(deadline) : null;
  const expired      = deadlineInfo?.expired ?? false;
  const isValid      = meetsMin && !expired;

  const handleSubmit = useCallback(async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      await submitSummary(submissionId, text);
      showToast('Resumo enviado com sucesso!', 'success');
      // Best-effort push notification to coordinators — fire and forget
      supabase.auth.getSession().then(({ data }) => {
        const token = data.session?.access_token;
        if (!token) return;
        fetch('/.netlify/functions/push-makeup-submitted', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ submissionId }),
        }).catch(() => {});
      });
      onSubmitted();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erro ao enviar resumo.', 'error');
    } finally {
      setSaving(false);
    }
  }, [isValid, saving, submissionId, text, showToast, onSubmitted]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />

      {/* Sheet / dialog */}
      <div
        className="relative w-full sm:max-w-2xl bg-iv-card border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92dvh]"
        role="dialog"
        aria-modal="true"
        aria-label="Resumo da aula de reposição"
      >
        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-2.5 pb-0 sm:hidden shrink-0">
          <span className="w-10 h-1 rounded-full bg-white/20" aria-hidden="true" />
        </div>

        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/8 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-iv-accent/15 flex items-center justify-center shrink-0">
            <BookOpen size={18} className="text-iv-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-iv-text">
              {isResubmission ? 'Reenviar Resumo' : 'Resumo da Aula'}
            </p>
            <p className="text-xs text-iv-muted truncate mt-0.5">{recordingTitle}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-iv-muted hover:text-iv-text hover:bg-white/5 transition-colors shrink-0"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Instructions */}
        <div className="px-5 pt-4 pb-3 shrink-0">
          <p className="text-sm text-iv-muted leading-relaxed">
            {isResubmission
              ? 'Sua submissão anterior foi reprovada. Ajuste o resumo conforme o feedback abaixo e reenvie para nova revisão.'
              : 'Escreva um resumo bem elaborado do conteúdo assistido. Demonstre que você compreendeu a aula — inclua os principais tópicos, conceitos e aprendizados.'}
          </p>
        </div>

        {/* Reviewer feedback banner (re-submission) */}
        {isResubmission && reviewerNotes && (
          <div className="px-5 pb-3 shrink-0">
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-200">
              <p className="font-semibold text-rose-300 mb-1">Feedback do revisor</p>
              <p className="leading-relaxed whitespace-pre-wrap">{reviewerNotes}</p>
            </div>
          </div>
        )}

        {/* Deadline banner — only when a deadline is set */}
        {deadlineInfo && (
          <div className="px-5 pb-3 shrink-0">
            <div
              className={[
                'flex items-start gap-2 p-2.5 rounded-lg border text-xs',
                expired
                  ? 'bg-red-500/20 border-red-500/40 text-red-200'
                  : deadlineInfo.soon
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                    : 'bg-blue-500/15 border-blue-500/35 text-blue-200',
              ].join(' ')}
            >
              <Clock size={13} className="shrink-0 mt-0.5" />
              <span>
                {expired ? (
                  <>
                    <strong>Prazo encerrado em {formatDeadline(deadline!)}.</strong>{' '}
                    Não é mais possível enviar este resumo. Procure a coordenação.
                  </>
                ) : (
                  <>
                    Prazo para envio: <strong>{formatDeadline(deadline!)}</strong> ({deadlineInfo.text}).
                  </>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Textarea */}
        <div className="flex-1 min-h-0 px-5 overflow-y-auto">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Descreva o que foi ensinado na aula, os principais conceitos abordados, exemplos apresentados e o que você aprendeu…"
            className="w-full h-full min-h-[200px] bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-iv-text placeholder:text-iv-muted/40 resize-none focus:outline-none focus:ring-1 focus:ring-iv-accent leading-relaxed"
            autoFocus
          />
        </div>

        {/* Footer: counter + actions */}
        <div className="px-5 pt-3 pb-5 space-y-3 shrink-0">
          {/* Status indicator */}
          <div className="flex items-center gap-1.5 text-xs">
            {expired
              ? <><AlertCircle size={13} className="text-red-400" /><span className="text-red-400">Envio bloqueado — prazo encerrado.</span></>
              : meetsMin
                ? <><CheckCircle2 size={13} className="text-emerald-400" /><span className="text-emerald-400">Resumo completo — pronto para enviar!</span></>
                : charCount > 0
                  ? <><AlertCircle size={13} className="text-amber-400" /><span className="text-amber-400">Resumo ainda incompleto — continue escrevendo…</span></>
                  : <><AlertCircle size={13} className="text-iv-muted/60" /><span className="text-iv-muted/60">Nenhum texto escrito ainda.</span></>
            }
          </div>

          {/* Below-min warning */}
          {!meetsMin && !expired && charCount > 0 && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              Seu resumo ainda está muito curto. Continue escrevendo para poder enviar.
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 rounded-xl text-sm text-iv-muted hover:text-iv-text hover:bg-white/5 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSubmit}
              disabled={!isValid || saving}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving
                ? <><Loader2 size={14} className="animate-spin" /> Enviando…</>
                : <><Send size={14} /> {isResubmission ? 'Reenviar Resumo' : 'Enviar Resumo'}</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
