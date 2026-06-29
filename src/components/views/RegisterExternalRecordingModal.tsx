import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Loader2, Video, X, XCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  createRecordingRow,
  listCompletedLessonsWithClassTitle,
  type LessonOption,
} from '../../services/recording.service';

// ── Drive URL helpers ─────────────────────────────────────────────────────────

/**
 * Attempts to extract a Google Drive file ID from various share URL formats:
 *  - drive.google.com/file/d/{ID}/view[?usp=…]
 *  - drive.google.com/open?id={ID}
 *  - drive.google.com/uc?id={ID}
 * Returns null for anything that doesn't match.
 */
function extractDriveFileId(url: string): string | null {
  const filePath = url.match(/\/file\/d\/([a-zA-Z0-9_-]{25,})/);
  if (filePath) return filePath[1];
  const idParam = url.match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
  if (idParam) return idParam[1];
  return null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful insert so the parent can refresh its list. */
  onSuccess: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RegisterExternalRecordingModal({ open, onClose, onSuccess }: Props) {
  const { profile } = useAuth();
  const { showToast } = useToast();

  const titleId = useId();

  // ── Form state ──────────────────────────────────────────────────────────────
  const [driveUrl,  setDriveUrl]  = useState('');
  const [title,     setTitle]     = useState('');
  const [lessonId,  setLessonId]  = useState('');   // scheduledLessonId
  const [classId,   setClassId]   = useState('');
  const [lessons,   setLessons]   = useState<LessonOption[]>([]);
  const [saving,    setSaving]    = useState(false);

  // Derived from driveUrl
  const fileId = extractDriveFileId(driveUrl.trim());
  const urlState: 'empty' | 'valid' | 'invalid' =
    driveUrl.trim() === '' ? 'empty' : fileId ? 'valid' : 'invalid';

  // ── Load completed lessons for the selector ─────────────────────────────────
  useEffect(() => {
    if (!open) return;
    listCompletedLessonsWithClassTitle().then(setLessons);
  }, [open]);

  // ── Reset form when modal closes ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      setDriveUrl('');
      setTitle('');
      setLessonId('');
      setClassId('');
    }
  }, [open]);

  // ── Close on Escape ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ── Lesson selection ─────────────────────────────────────────────────────────
  const handleLessonChange = (value: string) => {
    setLessonId(value);
    const lesson = lessons.find(l => l.scheduledLessonId === value);
    if (lesson) {
      setClassId(lesson.classId);
      // Auto-fill title only if the user hasn't typed anything yet
      if (!title.trim()) {
        setTitle(`${lesson.classTitle} — ${formatDate(lesson.scheduledAt)}`);
      }
    } else {
      setClassId('');
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!fileId || !title.trim() || !profile) return;
    setSaving(true);
    try {
      await createRecordingRow({
        scheduledLessonId: lessonId || null,
        classId:           classId  || null,
        recordedBy:        profile.id,
        gdriveFileId:      fileId,
        gdriveViewLink:    driveUrl.trim(),
        gdriveFolderId:    null,
        title:             title.trim(),
        durationS:         null,
        sizeBytes:         null,
        mimeType:          'video/mp4',
        status:            'ready',
        source:            'external',
      });
      showToast('Gravação registrada com sucesso.', 'success');
      onSuccess();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      showToast(`Erro ao registrar gravação: ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = urlState === 'valid' && title.trim().length > 0 && !saving;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-iv-surface text-iv-text rounded-2xl shadow-2xl w-full max-w-lg my-8 border border-white/10">

        {/* Header */}
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Video className="text-iv-accent shrink-0" size={20} />
            <h2 id={titleId} className="text-base font-semibold">
              Registrar gravação externa
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 text-iv-muted transition-colors touch-target"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </header>

        <div className="p-4 space-y-4">

          {/* Sharing warning — persistent, not dismissible */}
          <div className="flex gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
            <AlertTriangle className="text-amber-400 shrink-0 mt-0.5" size={16} />
            <p className="text-xs text-amber-200 leading-relaxed">
              Antes de registrar, certifique-se de que o arquivo está compartilhado
              como <strong>"qualquer pessoa com o link pode visualizar"</strong> no
              Google Drive — caso contrário os alunos receberão erro de acesso.
            </p>
          </div>

          {/* Drive URL */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-iv-muted uppercase tracking-wide">
              Link do Google Drive <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Link2
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none"
              />
              <input
                type="url"
                value={driveUrl}
                onChange={e => setDriveUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/…"
                autoComplete="off"
                spellCheck={false}
                className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-iv-accent transition-colors"
              />
              {/* Real-time validation indicator */}
              {urlState !== 'empty' && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  {urlState === 'valid'
                    ? <CheckCircle2 size={15} className="text-emerald-400" />
                    : <XCircle     size={15} className="text-red-400" />
                  }
                </span>
              )}
            </div>
            {urlState === 'valid' && (
              <p className="text-xs text-emerald-400">
                ID extraído: <code className="font-mono">{fileId}</code>
              </p>
            )}
            {urlState === 'invalid' && (
              <p className="text-xs text-red-400">
                Link inválido — cole um link de compartilhamento do Google Drive.
              </p>
            )}
          </div>

          {/* Lesson selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-iv-muted uppercase tracking-wide">
              Aula relacionada <span className="text-white/30">(opcional)</span>
            </label>
            <select
              value={lessonId}
              onChange={e => handleLessonChange(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm focus:outline-none focus:ring-1 focus:ring-iv-accent transition-colors appearance-none"
            >
              <option value="">Selecionar aula concluída…</option>
              {lessons.map(l => (
                <option key={l.scheduledLessonId} value={l.scheduledLessonId}>
                  {l.classTitle} — {formatDate(l.scheduledAt)}
                </option>
              ))}
            </select>
            {lessons.length === 0 && (
              <p className="text-xs text-iv-muted">
                Nenhuma aula concluída encontrada.
              </p>
            )}
            {/* Warning when no link selected — the recording won't appear in Reposições */}
            {lessons.length > 0 && !lessonId && (
              <p className="text-xs text-amber-300/80 flex items-start gap-1.5">
                <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                <span>
                  Sem aula vinculada, esta gravação <strong>não aparecerá em "Reposições"</strong> para
                  alunos com falta justificada.
                </span>
              </p>
            )}
            {lessonId && classId && (
              <p className="text-xs text-emerald-400/90 flex items-center gap-1.5">
                <CheckCircle2 size={11} />
                Vinculada à turma e aula — visível em Reposições para FJs desta aula.
              </p>
            )}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-iv-muted uppercase tracking-wide">
              Título <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Ex.: Aula Python Avançado — 15/05/2026"
              maxLength={200}
              className="w-full px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-iv-accent transition-colors"
            />
          </div>

        </div>

        {/* Footer */}
        <footer className="flex flex-col-reverse sm:flex-row-reverse gap-2 p-4 border-t border-white/10">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Video size={15} />}
            {saving ? 'Registrando…' : 'Registrar gravação'}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 disabled:opacity-40 text-sm font-medium transition-colors"
          >
            Cancelar
          </button>
        </footer>

      </div>
    </div>
  );
}
