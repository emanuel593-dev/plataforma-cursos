/**
 * RecordingsView.tsx
 *
 * Lists all class recordings accessible by the current user.
 * - Professor/Coordenacao: sees their own + any class they belong to
 * - Aluno: sees recordings from their enrolled classes
 * - Clicking "Assistir" opens the Google Drive webViewLink in a new tab
 * - Coordenacao / recording author can delete entries
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Video, ExternalLink, Trash2, Loader2, Search,
  Clock, HardDrive, RefreshCw, Film, PlusCircle,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  listRecordings,
  deleteRecordingRow,
  deleteFromDrive,
  getSystemAccessToken,
  type RecordingMeta,
} from '../../services/recording.service';
import RegisterExternalRecordingModal from './RegisterExternalRecordingModal';
import EmptyState from '../ui/EmptyState';
import ConfirmModal from '../ui/ConfirmModal';
import PageLoader from '../ui/PageLoader';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_LABELS: Record<RecordingMeta['status'], { label: string; className: string }> = {
  recording:  { label: 'Gravando…',    className: 'text-red-400' },
  uploading:  { label: 'Enviando…',    className: 'text-yellow-400 animate-pulse' },
  ready:      { label: 'Disponível',   className: 'text-emerald-400' },
  error:      { label: 'Erro',         className: 'text-red-400' },
};

// ── Component ────────────────────────────────────────────────────────────────

export default function RecordingsView() {
  const { profile } = useAuth();
  const { showToast } = useToast();

  const [recordings,    setRecordings]    = useState<RecordingMeta[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState('');
  const [deleteTarget,  setDeleteTarget]  = useState<RecordingMeta | null>(null);
  const [deleting,      setDeleting]      = useState(false);
  const [registerOpen,  setRegisterOpen]  = useState(false);

  const isAuthorOrCoord = useCallback(
    (rec: RecordingMeta) =>
      profile?.id === rec.recordedBy || profile?.role === 'coordenacao',
    [profile],
  );

  // ── Load ─────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      const recs = await listRecordings({ limit: 200 });
      setRecordings(recs);
    } catch (e) {
      showToast('Erro ao carregar gravações.', 'error');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [profile, showToast]);

  useEffect(() => { void load(); }, [load]);

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (rec: RecordingMeta, removeDrive: boolean) => {
    setDeleting(true);
    try {
      // Remove from Supabase first
      await deleteRecordingRow(rec.id);

      // Optionally remove from Google Drive using central account token
      if (removeDrive && rec.gdriveFileId && rec.gdriveFileId !== 'pending') {
        try {
          const at = await getSystemAccessToken();
          await deleteFromDrive(rec.gdriveFileId, at);
        } catch {
          showToast('Metadados removidos, mas não foi possível remover o arquivo do Drive.', 'warning');
        }
      }

      setRecordings((prev) => prev.filter((r) => r.id !== rec.id));
      showToast('Gravação removida.', 'success');
    } catch (e) {
      showToast('Erro ao remover gravação.', 'error');
      console.error(e);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [profile, showToast]);

  // ── Filter ───────────────────────────────────────────────────────────────

  const filtered = recordings.filter((r) =>
    !search || r.title.toLowerCase().includes(search.toLowerCase()),
  );

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) return <PageLoader />;

  return (
    <div className="space-y-5 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Film size={22} className="text-iv-accent" />
          <h1 className="text-xl font-semibold text-white">Gravações de Aulas</h1>
        </div>
        <div className="flex items-center gap-2">
          {profile?.role === 'coordenacao' && (
            <button
              onClick={() => setRegisterOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-iv-accent/20 hover:bg-iv-accent/30 text-iv-accent text-xs font-medium transition-colors"
            >
              <PlusCircle size={14} />
              Registrar externa
            </button>
          )}
          <button
            onClick={load}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            title="Atualizar"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
        <input
          type="text"
          placeholder="Buscar por título…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/80 placeholder:text-white/25 text-sm focus:outline-none focus:ring-1 focus:ring-iv-accent"
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Video size={28} />}
          title="Nenhuma gravação encontrada"
          description={
            search
              ? 'Nenhuma gravação corresponde à sua busca.'
              : 'Quando uma aula for gravada, ela aparecerá aqui.'
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((rec) => {
            const { label, className } = STATUS_LABELS[rec.status] ?? { label: rec.status, className: 'text-white/40' };
            return (
              <div
                key={rec.id}
                className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-xl bg-white/5 border border-white/8 hover:bg-white/[0.07] transition-colors"
              >
                {/* Icon */}
                <div className="shrink-0 w-9 h-9 rounded-lg bg-iv-accent/15 flex items-center justify-center">
                  <Video size={17} className="text-iv-accent" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{rec.title.replace(/\.(webm|mp4|mkv|ogg|avi)$/i, '')}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs text-white/40">
                    <span className={className}>{label}</span>
                    {rec.source === 'external' && (
                      <span className="px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium">
                        Externa
                      </span>
                    )}
                    {rec.durationS != null && (
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {formatDuration(rec.durationS)}
                      </span>
                    )}
                    {rec.sizeBytes != null && (
                      <span className="flex items-center gap-1">
                        <HardDrive size={11} />
                        {formatBytes(rec.sizeBytes)}
                      </span>
                    )}
                    <span>{formatDate(rec.createdAt)}</span>
                    {rec.errorMessage && (
                      <span className="text-red-400 truncate max-w-[200px]" title={rec.errorMessage}>
                        {rec.errorMessage}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {rec.status === 'ready' && rec.gdriveViewLink && (
                    <a
                      href={rec.gdriveViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-iv-accent/20 hover:bg-iv-accent/30 text-iv-accent text-xs font-medium transition-colors"
                    >
                      <ExternalLink size={12} />
                      Assistir
                    </a>
                  )}
                  {isAuthorOrCoord(rec) && (
                    <button
                      onClick={() => setDeleteTarget(rec)}
                      className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Remover gravação"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <ConfirmModal
          open
          title="Remover gravação"
          message={
            <div className="space-y-2">
              <p>
                Tem certeza que deseja remover <strong>{deleteTarget.title}</strong>?
              </p>
              {deleteTarget.source === 'external' ? (
                <p className="text-sm text-white/60">
                  O arquivo no Google Drive não será afetado.
                </p>
              ) : (
                deleteTarget.gdriveFileId && deleteTarget.gdriveFileId !== 'pending' && (
                  <p className="text-sm text-white/60">
                    O arquivo também será excluído do Google Drive central.
                  </p>
                )
              )}
            </div>
          }
          confirmLabel={deleting ? 'Removendo…' : 'Remover'}
          variant="danger"
          onConfirm={() => handleDelete(deleteTarget, deleteTarget.source !== 'external' && !!deleteTarget.gdriveFileId)}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {/* Register external recording modal */}
      <RegisterExternalRecordingModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onSuccess={load}
      />
    </div>
  );
}
