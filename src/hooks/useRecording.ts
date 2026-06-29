/**
 * useRecording.ts
 *
 * State machine for recording a live classroom session and uploading to GDrive.
 *
 * States:  idle → recording → stopping → uploading → done | error
 *
 * Recording strategy:
 *   1. TAB CAPTURE (Chrome 105+, preferred): `getDisplayMedia` with
 *      `preferCurrentTab: true` captures the full ClassroomView grid exactly
 *      as the professor sees it. Audio is mixed from all WebRTC peer streams
 *      via WebAudio API (reliable cross-browser, works even when tab audio
 *      capture is unavailable on Firefox/Safari).
 *
 *   2. AUDIO-ONLY COMPOSITE (fallback): if tab capture is denied or
 *      unavailable, records professor's camera + mixed audio of all peers.
 *      Requires no extra permissions beyond the camera/mic already granted.
 *
 * Video bitrate is intentionally capped at ~300 kbps (VP9) so a 90-min lesson
 * weighs ~200 MB — safe to buffer in memory before the resumable Drive upload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Peer } from './useWebRTC';
import {
  getSystemAccessToken,
  isSystemDriveReady,
  ensureRootFolder,
  uploadToDrive,
  createRecordingRow,
  updateRecordingRow,
  type UploadProgress,
} from '../services/recording.service';
import localforage from 'localforage';

// ── Types ────────────────────────────────────────────────────────────────────

export type RecordingStatus =
  | 'idle'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'done'
  | 'error';

export interface UseRecordingOptions {
  userId:             string;
  localStream:        MediaStream | null;
  localScreenStream?: MediaStream | null;
  peers:              Peer[];
  scheduledLessonId?: string | null;
  classId?:           string | null;
  lessonTitle?:       string;
  /** Called when the status reaches 'done' with the new recording ID. */
  onRecordingReady?:  (recordingId: string) => void;
}

export interface UseRecordingReturn {
  /** Whether the central Google Drive account is configured and ready. */
  systemReady:      boolean;
  /** Loading state while checking system Drive status. */
  systemChecking:   boolean;
  status:           RecordingStatus;
  /** Recording duration in seconds (updates every second while recording). */
  elapsed:          number;
  uploadProgress:   UploadProgress | null;
  error:            string | null;
  startRecording:   () => Promise<void>;
  stopRecording:    () => void;
  /** Reset from error state back to idle. */
  clearError:       () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSupportedMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function buildRecordingFileName(title: string, mimeType: string): string {
  const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  // Strip only chars that are unsafe in filenames; preserve accented letters (ã,ç,õ…)
  const safe = title.replace(/[/\\:*?"<>|]/g, '').trim() || 'Aula';
  return `${date} - ${safe}.${ext}`;
}

/** Mix local + peer audio tracks into a single composite AudioNode destination. */
function mixAudioTracks(
  audioCtx: AudioContext,
  localStream: MediaStream | null,
  peers: Peer[],
): MediaStreamAudioDestinationNode {
  const destination = audioCtx.createMediaStreamDestination();

  const connect = (stream: MediaStream | null) => {
    if (!stream) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;
    try {
      const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
      source.connect(destination);
    } catch { /* noop — stream might have been stopped */ }
  };

  connect(localStream);
  for (const peer of peers) connect(peer.stream);

  return destination;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useRecording({
  userId,
  localStream,
  localScreenStream,
  peers,
  scheduledLessonId,
  classId,
  lessonTitle = 'Aula',
  onRecordingReady,
}: UseRecordingOptions): UseRecordingReturn {

  const [systemReady,    setSystemReady]    = useState(false);
  const [systemChecking, setSystemChecking] = useState(true);
  const [status,         setStatus]         = useState<RecordingStatus>('idle');
  const [elapsed,        setElapsed]        = useState(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error,          setError]          = useState<string | null>(null);

  const recorderRef      = useRef<MediaRecorder | null>(null);
  const chunksRef        = useRef<Blob[]>([]);
  const audioCtxRef      = useRef<AudioContext | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const startTimeRef     = useRef<number>(0);
  const elapsedTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const rowIdRef         = useRef<string | null>(null);

  // ── Check system Drive readiness on mount ───────────────────────────────

  useEffect(() => {
    isSystemDriveReady()
      .then(setSystemReady)
      .catch(() => setSystemReady(false))
      .finally(() => setSystemChecking(false));
  }, []);

  // ── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      audioCtxRef.current?.close().catch(() => {});
      captureStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── Start recording ──────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;
    if (!systemReady) {
      setError('Drive central não configurado. Contate a coordenação.');
      return;
    }

    setError(null);

    const mimeType = getSupportedMimeType();

    // ── Acquire capture stream ──────────────────────────────────────────────

    // AudioContext for mixing all participant audio.
    // `sampleRate: 48000` avoids cross-browser resampling (Opus native rate);
    // `latencyHint: 'playback'` tells the scheduler to optimise for quality
    // over low-latency, reducing buffer under-runs in the mix.
    const audioCtx   = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    audioCtxRef.current = audioCtx;
    const audioMix   = mixAudioTracks(audioCtx, localStream, peers);

    let videoTracks: MediaStreamTrack[] = [];

    if (localScreenStream && localScreenStream.getVideoTracks().length > 0) {
      // Re-use the existing screen share stream to avoid a second permission prompt
      videoTracks = localScreenStream.getVideoTracks().map((t) => t.clone());
    } else {
      // Attempt tab capture (Chrome 105+)
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // Cap source resolution: on 4K monitors the browser may return
            // 3840×2160 which, when compressed to 300 kbps, is extremely blocky.
            // 1280×720 gives the encoder a reasonable source to work with.
            width:     { ideal: 1280, max: 1920 },
            height:    { ideal: 720,  max: 1080 },
            frameRate: { ideal: 24,   max: 30   },
          },
          audio: false, // We handle audio via WebAudio to ensure cross-browser mix
          // @ts-expect-error — Chrome 105+ non-standard hint
          preferCurrentTab: true,
        });
        videoTracks = displayStream.getVideoTracks();
        captureStreamRef.current = displayStream;
      } catch {
        // Fallback: use the professor's own camera track only
        if (localStream) {
          videoTracks = localStream.getVideoTracks().map((t) => t.clone());
        }
      }
    }

    const compositeStream = new MediaStream([
      ...videoTracks,
      ...audioMix.stream.getAudioTracks(),
    ]);

    // ── Set up MediaRecorder ────────────────────────────────────────────────

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(compositeStream, {
        mimeType:   mimeType || undefined,
        // Video: 300 kbps VP9 keeps a 90-min recording ≈ 246 MB — safe to buffer
        // in memory before the resumable Drive upload.
        videoBitsPerSecond: 300_000,
        // Audio: 64 kbps Opus mono — clearly intelligible speech with minimal
        // artefacts. 32 kbps (previous) caused audible distortion on consonants.
        audioBitsPerSecond:  64_000,
      });
    } catch (e) {
      audioCtx.close().catch(() => {});
      captureStreamRef.current?.getTracks().forEach((t) => t.stop());
      setError(`MediaRecorder não suportado: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    chunksRef.current   = [];
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data);
        
        // Persist to IndexedDB immediately to prevent RAM loss on crash
        localforage.setItem('iv_recording_draft', {
          chunks: chunksRef.current,
          metadata: {
            scheduledLessonId,
            classId,
            lessonTitle,
            userId,
            mimeType: mimeType || 'video/webm'
          }
        }).catch(err => {
          console.warn('[useRecording] Failed to persist chunk to IndexedDB', err);
        });
      }
    };

    recorder.onerror = (e) => {
      console.error('[useRecording] MediaRecorder error:', e);
      setStatus('error');
      setError('Erro durante a gravação.');
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };

    recorder.onstop = () => {
      void handleUpload(mimeType || 'video/webm');
    };

    // ── Reserve a Supabase row immediately (status = 'recording') ──────────

    try {
      const rowId = await createRecordingRow({
        scheduledLessonId: scheduledLessonId ?? null,
        classId:           classId ?? null,
        recordedBy:        userId,
        gdriveFileId:      'pending',
        title:             buildRecordingFileName(lessonTitle, mimeType),
        mimeType:          mimeType || 'video/webm',
        status:            'recording',
        source:            'platform',
      });
      rowIdRef.current = rowId;
    } catch {
      // Non-fatal — we'll retry on upload completion
    }

    // ── Start ───────────────────────────────────────────────────────────────

    // Collect a new chunk every 5 s (was 10 s): halves worst-case data loss
    // if the tab crashes or the user navigates away unexpectedly.
    recorder.start(5_000);
    startTimeRef.current = Date.now();
    setStatus('recording');
    setElapsed(0);

    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  }, [status, localStream, peers, userId, scheduledLessonId, classId, lessonTitle, systemReady]);

  // ── Stop recording ───────────────────────────────────────────────────────

  const stopRecording = useCallback(() => {
    if (status !== 'recording') return;
    setStatus('stopping');
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    recorderRef.current?.stop();
  }, [status]);

  // ── Upload to Google Drive ───────────────────────────────────────────────

  const handleUpload = useCallback(async (mimeType: string) => {
    setStatus('uploading');
    setUploadProgress({ loaded: 0, total: 0, percent: 0 });

    // Tear down capture streams — they're no longer needed
    audioCtxRef.current?.close().catch(() => {});
    captureStreamRef.current?.getTracks().forEach((t) => t.stop());
    captureStreamRef.current = null;

    const durationS = Math.floor((Date.now() - startTimeRef.current) / 1000);

    try {
      const accessToken = await getSystemAccessToken();
      const folderId    = await ensureRootFolder(accessToken);

      const blob      = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = []; // free memory

      const fileName  = buildRecordingFileName(lessonTitle, mimeType);

      const { fileId, viewLink } = await uploadToDrive(
        blob,
        fileName,
        folderId,
        accessToken,
        (p) => setUploadProgress(p),
      );

      // Draft cleared only AFTER a successful upload — preserving recovery
      // capability in case of a mid-upload network failure.
      localforage.removeItem('iv_recording_draft').catch(() => {});

      // Persist/update row
      if (rowIdRef.current) {
        await updateRecordingRow(rowIdRef.current, {
          gdriveFileId:   fileId,
          gdriveViewLink: viewLink,
          title:          fileName,
          durationS,
          sizeBytes:      blob.size,
          status:         'ready',
        });
      } else {
        const newId = await createRecordingRow({
          scheduledLessonId: scheduledLessonId ?? null,
          classId:           classId ?? null,
          recordedBy:        userId,
          gdriveFileId:      fileId,
          gdriveViewLink:    viewLink,
          gdriveFolderId:    folderId,
          title:             fileName,
          durationS,
          sizeBytes:         blob.size,
          mimeType,
          status:            'ready',
          source:            'platform',
        });
        rowIdRef.current = newId;
      }

      setStatus('done');
      if (rowIdRef.current) onRecordingReady?.(rowIdRef.current);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro ao fazer upload da gravação.';
      console.error('[useRecording] Upload error:', e);
      setError(msg);
      setStatus('error');

      if (rowIdRef.current) {
        updateRecordingRow(rowIdRef.current, {
          status:       'error',
          errorMessage: msg,
        }).catch(() => {});
      }
    } finally {
      setUploadProgress(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, lessonTitle, scheduledLessonId, classId, onRecordingReady]);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
    rowIdRef.current = null;
  }, []);

  return {
    systemReady,
    systemChecking,
    status,
    elapsed,
    uploadProgress,
    error,
    startRecording,
    stopRecording,
    clearError,
  };
}
