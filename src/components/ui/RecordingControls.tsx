/**
 * RecordingControls.tsx
 *
 * Self-contained recording widget rendered inside ClassroomView (host only).
 * Uses the central coordinator Drive account — no per-user OAuth needed.
 * All logic lives in useRecording + recording.service — this file is pure UI.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  Circle, Square, Upload, CheckCircle2, AlertCircle,
  HardDriveDownload, Loader2,
} from 'lucide-react';
import type { Peer } from '../../hooks/useWebRTC';
import { useRecording, type RecordingStatus } from '../../hooks/useRecording';

interface RecordingControlsProps {
  userId:             string;
  localStream:        MediaStream | null;
  localScreenStream?: MediaStream | null;
  peers:              Peer[];
  scheduledLessonId?: string | null;
  classId?:           string | null;
  lessonTitle?:       string;
  /** Called when recording state changes (true = started, false = stopped). */
  onStatusChange?:    (isActive: boolean) => void;
  /** When true, another participant (professor or monitor) is already
   *  recording. Blocks the idle "Gravar" button to prevent a second
   *  parallel recording session in the same room. */
  alreadyRecordingRemotely?: boolean;
  /** Ref populated with the `stopRecording` function so the parent (ClassroomView)
   *  can trigger a graceful stop before closing the room. Cleared on unmount. */
  stopRef?: React.MutableRefObject<(() => void) | null>;
  /** Called on every status transition so ClassroomView can gate room-close
   *  until the upload finishes (status 'done' or 'error'). */
  onStatusUpdate?: (status: RecordingStatus) => void;
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function RecordingControls({
  userId,
  localStream,
  localScreenStream,
  peers,
  scheduledLessonId,
  classId,
  lessonTitle,
  onStatusChange,
  alreadyRecordingRemotely = false,
  stopRef,
  onStatusUpdate,
}: RecordingControlsProps) {
  const {
    systemReady,
    systemChecking,
    status,
    elapsed,
    uploadProgress,
    error,
    startRecording,
    stopRecording,
    clearError,
  } = useRecording({ userId, localStream, localScreenStream, peers, scheduledLessonId, classId, lessonTitle });

  const handleStopClick = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  // Notify parent when recording starts or stops so it can broadcast the
  // state change to all room participants via useWebRTC.broadcastRecordingEvent.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev !== 'recording' && status === 'recording') {
      onStatusChange?.(true);
    } else if (prev === 'recording' && status !== 'recording') {
      onStatusChange?.(false);
    }
  }, [status, onStatusChange]);

  // Expose stopRecording to the parent so it can gracefully stop the recording
  // before closing the room (prevents the "stuck Gravando…" stuck-row problem).
  useEffect(() => {
    if (stopRef) stopRef.current = stopRecording;
    return () => { if (stopRef) stopRef.current = null; };
  }, [stopRef, stopRecording]);

  // Forward full status to parent so it can gate room-close until settled.
  useEffect(() => {
    onStatusUpdate?.(status);
  }, [status, onStatusUpdate]);

  // ── Drive not configured ─────────────────────────────────────────────────
  if (systemChecking) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <Loader2 size={13} className="animate-spin" />
        <span>Verificando Drive…</span>
      </div>
    );
  }

  if (!systemReady) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-white/40" title="Acesse Gestão → Google Drive para conectar a conta central">
        <HardDriveDownload size={13} />
        <span>Drive não configurado</span>
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-red-400 max-w-[180px] truncate" title={error ?? ''}>
          <AlertCircle size={13} className="shrink-0" />
          <span className="truncate">{error ?? 'Erro na gravação'}</span>
        </div>
        <button
          onClick={clearError}
          className="text-xs text-white/50 hover:text-white underline"
        >
          Limpar
        </button>
      </div>
    );
  }

  // ── Upload in progress ───────────────────────────────────────────────────
  if (status === 'uploading') {
    const pct = uploadProgress?.percent ?? 0;
    return (
      <div className="flex items-center gap-2 min-w-[160px]">
        <Upload size={13} className="shrink-0 text-iv-accent animate-pulse" />
        <div className="flex-1">
          <div className="flex justify-between text-[10px] text-white/50 mb-0.5">
            <span>Enviando…</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-iv-accent rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  if (status === 'done') {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-400">
        <CheckCircle2 size={13} />
        <span>Gravação salva no Drive</span>
        <button
          onClick={clearError} // clearError also resets to idle
          className="text-white/40 hover:text-white/70 underline ml-1"
        >
          Nova
        </button>
      </div>
    );
  }

  // ── Stopping ─────────────────────────────────────────────────────────────
  if (status === 'stopping') {
    return (
      <div className="flex items-center gap-2 text-xs text-white/50">
        <Loader2 size={13} className="animate-spin" />
        <span>Finalizando…</span>
      </div>
    );
  }

  // ── Recording in progress ────────────────────────────────────────────────
  if (status === 'recording') {
    return (
      <div className="flex items-center gap-2">
        {/* Pulsing red dot */}
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
        </span>
        <span className="text-xs font-mono text-red-400 tabular-nums">
          {formatElapsed(elapsed)}
        </span>
        <button
          onClick={handleStopClick}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-600/80 hover:bg-red-600 transition-colors text-xs text-white font-medium"
          title="Parar gravação e enviar para o Drive"
        >
          <Square size={11} />
          Parar
        </button>
      </div>
    );
  }

  // ── Idle — ready to record ───────────────────────────────────────────────

  // Another participant (professor or monitor) is already recording — prevent
  // a second parallel recording session. Show a read-only indicator instead.
  if (alreadyRecordingRemotely) {
    return (
      <div
        className="flex items-center gap-1.5 text-xs text-red-400/70"
        title="Outra gravação já está em andamento nesta sala"
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        <span>Gravação em andamento</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={startRecording}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-red-600/80 transition-colors text-xs text-white/70 hover:text-white group"
        title="Gravar aula e salvar no Google Drive"
      >
        <Circle size={11} className="text-red-400 group-hover:text-white" />
        Gravar
      </button>
    </div>
  );
}
