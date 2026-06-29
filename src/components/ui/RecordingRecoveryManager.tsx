import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import localforage from 'localforage';
import { AlertTriangle, HardDriveUpload, Trash2 } from 'lucide-react';
import {
  uploadToDrive,
  ensureRootFolder,
  getSystemAccessToken,
  createRecordingRow,
} from '../../services/recording.service';

interface DraftMetadata {
  scheduledLessonId?: string | null;
  classId?: string | null;
  lessonTitle?: string;
  userId: string;
  mimeType: string;
}

interface DraftData {
  // Chunks are stored as ArrayBuffers (IndexedDB serialization) or Blobs
  chunks: (Blob | ArrayBuffer)[];
  metadata: DraftMetadata;
}

export default function RecordingRecoveryManager() {
  const [draft, setDraft] = useState<DraftData | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverProgress, setRecoverProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localforage.getItem<DraftData>('iv_recording_draft').then((data) => {
      if (data && data.chunks && data.chunks.length > 0) {
        setDraft(data);
      }
    }).catch((err) => {
      console.error('[RecordingRecoveryManager] Error reading draft from IndexedDB', err);
    });
  }, []);

  const handleDiscard = async () => {
    await localforage.removeItem('iv_recording_draft');
    setDraft(null);
  };

  const handleRecover = async () => {
    if (!draft) return;
    setIsRecovering(true);
    setError(null);
    try {
      const { chunks, metadata } = draft;

      // Normalise: IndexedDB may return ArrayBuffers instead of Blobs
      const blobParts = chunks.map((c) =>
        c instanceof Blob ? c : new Blob([c], { type: metadata.mimeType || 'video/webm' })
      );
      const blob = new Blob(blobParts, { type: metadata.mimeType || 'video/webm' });

      const ext  = metadata.mimeType?.includes('mp4') ? 'mp4' : 'webm';
      const date = new Date().toISOString().slice(0, 10);
      const safe = (metadata.lessonTitle || 'Aula').replace(/[/\\:*?"<>|]/g, '').trim() || 'Aula';
      const fileName = `${date} - ${safe} (Recuperada).${ext}`;

      const accessToken = await getSystemAccessToken();
      const folderId    = await ensureRootFolder(accessToken);

      const { fileId, viewLink } = await uploadToDrive(
        blob,
        fileName,
        folderId,
        accessToken,
        (progress) => setRecoverProgress(progress.percent)
      );

      await createRecordingRow({
        scheduledLessonId: metadata.scheduledLessonId ?? null,
        classId:           metadata.classId ?? null,
        recordedBy:        metadata.userId,
        gdriveFileId:      fileId,
        gdriveViewLink:    viewLink,
        gdriveFolderId:    folderId,
        title:             fileName,
        durationS:         0,
        sizeBytes:         blob.size,
        mimeType:          metadata.mimeType || 'video/webm',
        status:            'ready',
        source:            'platform',
      });

      await localforage.removeItem('iv_recording_draft');
      setDraft(null);
    } catch (err) {
      console.error('[RecordingRecoveryManager] Error recovering draft', err);
      setError('Houve um erro ao tentar recuperar a gravação. Tente novamente ou descarte.');
    } finally {
      setIsRecovering(false);
      setRecoverProgress(0);
    }
  };

  if (!draft) return null;

  // Render via portal so it sits above any z-index in the app tree
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-modal-title"
    >
      {/* Backdrop — not clickable so the user MUST make a decision */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative bg-iv-card border border-amber-500/30 rounded-t-3xl sm:rounded-2xl shadow-2xl w-full max-w-md max-h-[90dvh] flex flex-col animate-in slide-in-from-bottom duration-300 sm:zoom-in-95">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/8 shrink-0">
          <div className="p-2 bg-amber-500/10 rounded-xl">
            <AlertTriangle size={20} className="text-amber-400" />
          </div>
          <h3 id="recovery-modal-title" className="text-base font-semibold text-iv-text">
            Gravação Interrompida Encontrada
          </h3>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <p className="text-sm text-iv-text/80 leading-relaxed">
            O sistema detectou um rascunho da aula{' '}
            <strong className="text-white">{draft.metadata.lessonTitle || 'não identificada'}</strong>{' '}
            que não foi enviado devido a um fechamento inesperado do navegador ou queda de energia.
          </p>
          <p className="text-sm text-iv-text/80">
            Você deseja enviar esta gravação agora ou descartá-la permanentemente?
          </p>

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400">
              {error}
            </div>
          )}

          {isRecovering ? (
            <div className="p-4 bg-iv-surface border border-white/5 rounded-xl space-y-3">
              <div className="flex justify-between text-xs font-medium text-iv-text">
                <span>Enviando para o Google Drive...</span>
                <span>{recoverProgress}%</span>
              </div>
              <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${recoverProgress}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row justify-end gap-3 pt-2">
              <button
                onClick={handleDiscard}
                className="px-4 py-2 text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <Trash2 size={16} />
                Descartar Permanentemente
              </button>
              <button
                onClick={handleRecover}
                className="px-4 py-2 text-sm font-semibold bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
              >
                <HardDriveUpload size={16} />
                Salvar na Nuvem
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
