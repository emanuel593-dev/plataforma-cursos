/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import {
  Mic, MicOff, Settings, Activity, Volume2, Info, Monitor, AlertCircle,
  CheckCircle2, Wifi, Zap, ShieldCheck, History, Trash2, ChevronRight, Clock,
  Download, HelpCircle, Copy, LayoutDashboard, Users, Folder, Menu, Video,
  Plus, Loader2, Globe, Key, Link, RefreshCw, Check, ExternalLink, Eye, EyeOff,
  X, LogOut,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from './lib/utils';

// Services
import { authService, AuthUser } from './services/auth.service';
import { dbService } from './services/database.service';

// Components
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { WaveformVisualizer } from './components/ui/WaveformVisualizer';
import { DashboardView } from './components/views/DashboardView';
import { WorkspaceView } from './components/views/WorkspaceView';
import { SettingsView } from './components/views/SettingsView';
import { AdminView } from './components/views/AdminView';
import { ConferenceView } from './components/ConferenceView';
import { Auth } from './components/Auth';
import { float32ToPcm16Base64, pcm16Base64ToFloat32 } from './lib/audio-utils';

// Types
import {
  UserProfile, HistorySession, SessionMode, UserRole, Organization, ApiKey,
  AppMode, SummaryTone, RecordingMode, ActiveView,
} from './types';

// ── Constants ────────────────────────────────────────────────────────────────

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const SUMMARY_MODEL = 'gemini-2.5-flash';

// ── Local types ──────────────────────────────────────────────────────────────

interface Transcription {
  id: string;
  text: string;
  type: 'user' | 'model';
  timestamp: Date;
}

// ── Root component ────────────────────────────────────────────────────────────

function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

// ── AppContent ────────────────────────────────────────────────────────────────

function AppContent() {
  // ── Auth state ────────────────────────────────────────────
  const [user, setUser] = useState<AuthUser | null>(authService.getCurrentUser());
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isGuestMode, setIsGuestMode] = useState(false);

  // ── Org / multi-tenant state ──────────────────────────────
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [orgKeys, setOrgKeys] = useState<ApiKey[]>([]);
  const [orgMembers, setOrgMembers] = useState<UserProfile[]>([]);

  // ── History ───────────────────────────────────────────────
  const [history, setHistory] = useState<HistorySession[]>([]);

  // ── Recording session state ───────────────────────────────
  const [externalId, setExternalId] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>('idle');
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [liveTranscription, setLiveTranscription] = useState('');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'active' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [latency, setLatency] = useState<number>(0);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryTone, setSummaryTone] = useState<SummaryTone>('executive');
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('hybrid');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [activeResultTab, setActiveResultTab] = useState<'summary' | 'transcription'>('summary');
  const [isCountingDown, setIsCountingDown] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [hasConsented, setHasConsented] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // ── UI state ──────────────────────────────────────────────
  const [activeView, setActiveView] = useState<ActiveView>('recording');
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [fluidAnimations, setFluidAnimations] = useState(true);
  const [showTooltips, setShowTooltips] = useState(true);

  // ── Refs ──────────────────────────────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const statusRef = useRef(status);
  const isRecordingRef = useRef(isRecording);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

  const API_KEY = (process.env.GEMINI_API_KEY as string) || '';
  const hasValidKey = Boolean(API_KEY) && API_KEY.length > 5 && !API_KEY.includes('TODO');

  // ── URL param parsing ─────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) {
      setIsGuestMode(true);
      setActiveView('conference');
    }
    setExternalId(params.get('externalId'));
  }, []);

  // ── Auth listener ─────────────────────────────────────────
  useEffect(() => {
    const unsub = authService.onAuthStateChanged((currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      if (!currentUser) {
        setUserProfile(null);
        setOrganization(null);
        setOrgKeys([]);
        setOrgMembers([]);
        setHistory([]);
      }
    });
    return unsub;
  }, []);

  // ── User profile subscription ─────────────────────────────
  useEffect(() => {
    if (!user) return;
    const unsub = dbService.watchUserProfile(user.uid, setUserProfile);
    return unsub;
  }, [user?.uid]);

  // ── Sessions subscription ─────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const unsub = dbService.watchSessions(user.uid, setHistory);
    return unsub;
  }, [user?.uid]);

  // ── Org subscription ──────────────────────────────────────
  useEffect(() => {
    if (!userProfile?.orgId) return;
    const unsub = dbService.watchOrganization(userProfile.orgId, setOrganization);
    return unsub;
  }, [userProfile?.orgId]);

  // ── API keys + members subscription ──────────────────────
  useEffect(() => {
    if (!userProfile?.orgId) return;
    if (userProfile.role !== 'admin' && userProfile.role !== 'owner') return;
    const keysUnsub = dbService.watchApiKeys(userProfile.orgId, setOrgKeys);
    const membersUnsub = dbService.watchOrgMembers(userProfile.orgId, setOrgMembers);
    return () => { keysUnsub(); membersUnsub(); };
  }, [userProfile?.orgId, userProfile?.role]);

  // ── Recording timer ───────────────────────────────────────
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording) {
      interval = setInterval(() => setRecordingDuration(prev => prev + 1), 1000);
    } else {
      setRecordingDuration(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  // ── Auto-scroll transcriptions ────────────────────────────
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptions]);

  // ── Video playback ────────────────────────────────────────
  useEffect(() => {
    if (videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [mode, status, isRecording]);

  // ── Helpers ───────────────────────────────────────────────

  const formatDuration = (seconds: number) =>
    `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

  const triggerSyncIndicator = () => {
    setIsSyncing(true);
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    syncTimeoutRef.current = setTimeout(() => setIsSyncing(false), 100);
  };

  const getFriendlyErrorMessage = (err: any): string => {
    const message = err?.message || String(err);
    const name = err?.name || '';

    if (name === 'NotAllowedError' || message.includes('denied'))
      return 'Acesso negado. Permita o uso do microfone/tela nas configurações do navegador.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
      return 'Dispositivo não encontrado. Verifique se o microfone está conectado.';
    if (name === 'NotReadableError' || name === 'TrackStartError')
      return 'O microfone ou a tela já estão sendo usados por outro aplicativo.';
    if (name === 'OverconstrainedError')
      return 'As configurações solicitadas não são suportadas pelo hardware.';
    if (name === 'AbortError')
      return 'A operação foi cancelada ou ocorreu um erro de hardware.';
    if (name === 'SecurityError')
      return 'Acesso ao microfone ou tela bloqueado por políticas de segurança do navegador.';
    if (name === 'NotSupportedError')
      return 'Seu navegador não suporta as funcionalidades necessárias.';
    if (message.includes('API_KEY_INVALID') || message.includes('invalid API key'))
      return 'Chave de API inválida. Verifique as configurações de Secrets.';
    if (message.includes('quota') || message.includes('429'))
      return 'Limite de uso atingido (Quota Exceeded). Tente novamente em alguns minutos.';
    if (message.includes('network') || message.includes('fetch') || message.includes('socket'))
      return 'Erro de conexão. Verifique sua internet.';
    if (message.includes('safety'))
      return 'Conteúdo bloqueado pelos filtros de segurança da IA.';
    return `Ocorreu um erro inesperado: ${message}`;
  };

  const addTranscription = useCallback((text: string, type: 'user' | 'model') => {
    setTranscriptions(prev => [
      ...prev,
      { id: Math.random().toString(36).substring(2, 9), text, type, timestamp: new Date() },
    ]);
  }, []);

  const deleteHistoryItem = async (id: string) => {
    if (!user) return;
    try {
      await dbService.deleteSession(id);
    } catch (err: any) {
      setError(getFriendlyErrorMessage(err));
    }
  };

  // ── Handlers: Organization/Admin ─────────────────────────────────────────

  const handleUpdateOrg = async (data: Partial<Organization>) => {
    if (!userProfile?.orgId) return;
    try {
      await dbService.setOrganization(userProfile.orgId, data);
    } catch (err: any) {
      setError(getFriendlyErrorMessage(err));
    }
  };

  const handleCreateKey = async (name: string): Promise<string | null> => {
    if (!userProfile?.orgId) return null;
    try {
      const secretPart = crypto.randomUUID().replace(/-/g, '');
      const rawKey = `vox_${userProfile.orgId}_${secretPart}`;

      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
      const hashedKey = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('');

      await dbService.createApiKey(userProfile.orgId, {
        id: crypto.randomUUID(),
        orgId: userProfile.orgId,
        name,
        keyPrefix: `vox_${userProfile.orgId}_${secretPart.substring(0, 4)}`,
        hashedKey,
        createdAt: dbService.serverTimestamp(),
      });
      return rawKey;
    } catch (err: any) {
      setError(getFriendlyErrorMessage(err));
      return null;
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!userProfile?.orgId) return;
    try {
      await dbService.deleteApiKey(userProfile.orgId, id);
    } catch (err: any) {
      setError(getFriendlyErrorMessage(err));
    }
  };

  const handleUpdateMemberRole = async (memberUid: string, newRole: UserRole) => {
    try {
      await dbService.updateUserRole(memberUid, newRole);
    } catch (err: any) {
      setError(getFriendlyErrorMessage(err));
    }
  };

  // ── Session lifecycle ─────────────────────────────────────

  const startSessionWithCountdown = (selectedMode: AppMode) => {
    if (!hasValidKey) { setError('A GEMINI_API_KEY não foi detectada.'); return; }
    if (isRecording || status === 'connecting' || isCountingDown) return;

    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setIsCountingDown(true);
    setCountdown(5);
    setMode(selectedMode);

    countdownTimerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          setIsCountingDown(false);
          startSession(selectedMode);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const cancelSession = () => {
    if (isCountingDown) {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      setIsCountingDown(false);
      setMode('idle');
      return;
    }
    setIsRecording(false);
    setMode('idle');
    setStatus('idle');
    statusRef.current = 'idle';
    setRecordingDuration(0);
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      audioChunksRef.current = [];
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    setAudioLevel(0);
    setTranscriptions([]);
    setLiveTranscription('');
    setSummary(null);
  };

  const startSession = async (selectedMode: AppMode, providedStream?: MediaStream) => {
    if (!hasValidKey) { setError('A GEMINI_API_KEY não foi detectada.'); return; }
    if (isRecording || status === 'connecting') return;

    setSummary(null);
    setTranscriptions([]);
    setRecordingDuration(0);

    try {
      setStatus('connecting');
      setError(null);

      if (recordingMode !== 'recorder') {
        const ai = new GoogleGenAI({ apiKey: API_KEY });
        const startTime = Date.now();

        const session = await ai.live.connect({
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: selectedMode === 'meeting'
              ? 'Você é um assistente de transcrição e análise comportamental para entrevistas de R&S. Transcreva, analise linguagem corporal e tom de voz. Seja OBJETIVO. Foque em sinais de confiança, nervosismo, clareza. Identifique os falantes. Responda em Português do Brasil.'
              : 'Você é um assistente de transcrição profissional. Transcreva o áudio com alta fidelidade. Responda em Português do Brasil.',
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
          callbacks: {
            onopen: () => setLatency(Date.now() - startTime),
            onmessage: async (message: LiveServerMessage) => {
              try {
                triggerSyncIndicator();
                if (!message.serverContent) return;
                if (message.serverContent.modelTurn?.parts) {
                  const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
                  if (textPart?.text) addTranscription(textPart.text, 'model');
                  const audioPart = message.serverContent.modelTurn.parts.find(p => p.inlineData);
                  if (audioPart?.inlineData?.data) playAudioChunk(audioPart.inlineData.data);
                }
                const transcription = (message.serverContent as any).inputAudioTranscription
                  || (message.serverContent as any).input_audio_transcription
                  || (message.serverContent as any).inputTranscription;
                if (transcription) {
                  const text = transcription.text || transcription.transcript || transcription.data;
                  const isFinal = transcription.isFinal || transcription.is_final || transcription.final;
                  if (text) {
                    if (isFinal) {
                      addTranscription(text, 'user');
                      setLiveTranscription('');
                    } else {
                      setLiveTranscription(prev => prev.endsWith(text.trim()) ? prev : prev + text);
                    }
                  }
                }
              } catch (err) {
                console.error('VoxTranscribe: onmessage error', err);
              }
            },
            onerror: (err: any) => { setError(getFriendlyErrorMessage(err)); setStatus('error'); },
            onclose: () => stopSession(),
          },
        });
        sessionRef.current = session;
      }

      setStatus('active');
      statusRef.current = 'active';
      setIsRecording(true);
      startMediaCapture(selectedMode, providedStream).catch(err => {
        setError(getFriendlyErrorMessage(err));
        setStatus('error');
      });
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
      setStatus('error');
    }
  };

  const generateSummary = async (
    transcriptionList: Transcription[],
    audioBlob?: Blob,
    finalDuration?: number,
    currentMode?: AppMode,
    participantsCount?: number,
  ) => {
    if (transcriptionList.length === 0 && !audioBlob) return;
    setIsSummarizing(true);
    setStatus('connecting');
    setActiveResultTab('summary');

    try {
      const ai = new GoogleGenAI({ apiKey: API_KEY });
      const toneInstructions: Record<SummaryTone, string> = {
        executive: 'Focado em decisões, ações imediatas e próximos passos. Use tópicos curtos e diretos.',
        technical: 'Detalhes de implementação, especificações técnicas. Use blocos de código se necessário.',
        educational: 'Explicações didáticas, conceitos fundamentais e analogias. Ideal para documentação.',
        full: 'Transcrição detalhada com contexto completo, mantendo a narrativa original.',
        interview: 'Parecer técnico de R&S: 1.Perfil, 2.Hard Skills, 3.Soft Skills, 4.Red Flags, 5.Veredito. Use tabelas Markdown se necessário.',
      };

      const meetingContext = currentMode === 'meeting'
        ? `Esta foi uma videoconferência com ${participantsCount || 'múltiplos'} participantes.`
        : '';

      let summaryText = '';

      if (audioBlob && (recordingMode === 'hybrid' || recordingMode === 'recorder')) {
        const reader = new FileReader();
        const base64Audio = await new Promise<string>(resolve => {
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(audioBlob);
        });

        const response = await ai.models.generateContent({
          model: SUMMARY_MODEL,
          contents: [{
            parts: [
              { inlineData: { mimeType: audioBlob.type || 'audio/webm', data: base64Audio } },
              {
                text: `Analise este áudio e forneça um resumo profissional em Português do Brasil.\n${meetingContext}\nESTILO: ${toneInstructions[summaryTone]}\nUse Markdown.`,
              },
            ],
          }],
        });
        summaryText = response.text || 'Não foi possível gerar um resumo refinado.';
      } else {
        const fullText = transcriptionList
          .map(t => `${t.type === 'user' ? 'Usuário' : 'Gemini'}: ${t.text}`)
          .join('\n');

        const response = await ai.models.generateContent({
          model: SUMMARY_MODEL,
          contents: [{
            parts: [{
              text: `Resuma a seguinte transcrição de forma profissional em Português do Brasil.\n${meetingContext}\nESTILO: ${toneInstructions[summaryTone]}\nUse Markdown:\n\n${fullText}`,
            }],
          }],
        });
        summaryText = response.text || 'Não foi possível gerar um resumo.';
      }

      setSummary(summaryText);

      if (user && isAuthReady) {
        await dbService.createSession({
          id: dbService.generateId(),
          userId: user.uid,
          orgId: userProfile?.orgId || null,
          timestamp: dbService.serverTimestamp(),
          mode: (currentMode === 'local' || currentMode === 'meeting') ? currentMode as SessionMode : 'local',
          transcriptions: transcriptionList,
          summary: summaryText,
          duration: finalDuration || 0,
          externalId: externalId || undefined,
        });
      }
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
      setStatus('error');
    } finally {
      setIsSummarizing(false);
      setStatus('idle');
    }
  };

  const stopSession = async (cancel = false, participantsCount?: number) => {
    if (isStopping) return;
    setIsStopping(true);

    try {
      const finalDuration = recordingDuration;
      const currentMode = mode;
      if (currentMode === 'idle') return;

      let finalTranscriptions = [...transcriptions];
      if (liveTranscription) {
        const entry: Transcription = {
          id: Math.random().toString(36).substring(2, 9),
          text: liveTranscription,
          type: 'user',
          timestamp: new Date(),
        };
        finalTranscriptions.push(entry);
        if (!cancel) setTranscriptions(finalTranscriptions);
        setLiveTranscription('');
      }

      setIsRecording(false);
      setMode('idle');
      setStatus('idle');
      statusRef.current = 'idle';

      if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }

      let audioBlob: Blob | undefined;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        audioBlob = await new Promise<Blob>(resolve => {
          mediaRecorderRef.current!.onstop = () =>
            resolve(new Blob(audioChunksRef.current, { type: 'audio/webm' }));
          mediaRecorderRef.current!.stop();
        });
        mediaRecorderRef.current = null;
        audioChunksRef.current = [];
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        (streamRef.current as any)._displayStream?.getTracks()
          .forEach((t: MediaStreamTrack) => t.stop());
        (streamRef.current as any)._micStream?.getTracks()
          .forEach((t: MediaStreamTrack) => t.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
      setAudioLevel(0);

      if (cancel) {
        setTranscriptions([]);
        setSummary(null);
        return;
      }
      if (finalTranscriptions.length > 0 || audioBlob) {
        await generateSummary(finalTranscriptions, audioBlob, finalDuration, currentMode, participantsCount);
      }
    } finally {
      setIsStopping(false);
    }
  };

  const startMediaCapture = async (selectedMode: AppMode, providedStream?: MediaStream) => {
    const isInIframe = window.self !== window.top;

    try {
      let stream: MediaStream;

      if (providedStream) {
        stream = providedStream;
        if (recordingMode === 'hybrid' || recordingMode === 'recorder') {
          audioChunksRef.current = [];
          const recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
          recorder.start();
          mediaRecorderRef.current = recorder;
        }
      } else if (selectedMode === 'meeting') {
        let micStream: MediaStream | null = null;
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch { /* optional mic */ }

        let displayStream: MediaStream;
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } },
            audio: true,
          });
        } catch (err: any) {
          if (micStream) micStream.getTracks().forEach(t => t.stop());
          if (err.name === 'NotAllowedError' && isInIframe)
            throw new Error('Compartilhamento de tela bloqueado no iframe. Abra em uma nova aba.');
          throw err;
        }

        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioContextRef.current = audioCtx;
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        const destination = audioCtx.createMediaStreamDestination();
        let hasAudio = false;

        if (displayStream.getAudioTracks().length > 0) {
          audioCtx.createMediaStreamSource(displayStream).connect(destination);
          hasAudio = true;
        } else {
          setError('Aviso: Áudio do sistema não detectado. Marque "Compartilhar áudio da guia" ao selecionar a tela.');
        }
        if (micStream) { audioCtx.createMediaStreamSource(micStream).connect(destination); hasAudio = true; }
        if (!hasAudio) throw new Error('Nenhuma fonte de áudio detectada.');

        stream = new MediaStream([
          ...displayStream.getVideoTracks(),
          ...destination.stream.getAudioTracks(),
        ]);
        (stream as any)._displayStream = displayStream;
        (stream as any)._micStream = micStream;

        if (recordingMode === 'hybrid' || recordingMode === 'recorder') {
          audioChunksRef.current = [];
          const mimeTypes = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
          const supportedType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t));
          try {
            const recorder = new MediaRecorder(
              stream, supportedType ? { mimeType: supportedType } : undefined,
            );
            recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
            recorder.start(1000);
            mediaRecorderRef.current = recorder;
          } catch { /* non-critical */ }
        }
      } else {
        // Local mic
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation,
              noiseSuppression,
              autoGainControl: true,
              sampleRate: 48000,
              channelCount: 1,
              sampleSize: 16,
            },
            video: false,
          });
        } catch (err: any) {
          if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')
            throw new Error('Microfone não encontrado.');
          if (err.name === 'NotAllowedError')
            throw new Error('Acesso ao microfone negado.');
          throw new Error('Erro ao acessar o microfone.');
        }

        if (recordingMode === 'hybrid' || recordingMode === 'recorder') {
          audioChunksRef.current = [];
          const recorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 128000,
          });
          recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
          recorder.start();
          mediaRecorderRef.current = recorder;
        }
      }

      // If session was cancelled while we were acquiring media, release and bail
      if (statusRef.current === 'idle') {
        stream.getTracks().forEach(t => t.stop());
        (stream as any)._displayStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        (stream as any)._micStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      audioContextRef.current = audioContextRef.current || new AudioContext({ sampleRate: 16000 });
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();

      const source = audioContextRef.current.createMediaStreamSource(stream);
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Audio level visualizer
      const updateVisualizer = () => {
        if (!analyserRef.current || statusRef.current !== 'active') return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        setAudioLevel(dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 128);
        requestAnimationFrame(updateVisualizer);
      };
      updateVisualizer();

      // AudioWorklet for PCM streaming
      const workletCode = `
        class AudioProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0]?.[0];
            if (ch) this.port.postMessage(ch);
            return true;
          }
        }
        try { registerProcessor('audio-processor', AudioProcessor); } catch {}
      `;
      const workletUrl = URL.createObjectURL(
        new Blob([workletCode], { type: 'application/javascript' }),
      );

      const setupFallback = () => {
        const processor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
        source.connect(processor);
        processor.connect(audioContextRef.current!.destination);
        processor.onaudioprocess = (e) => {
          if (sessionRef.current && statusRef.current === 'active') {
            sessionRef.current.sendRealtimeInput({
              audio: { data: float32ToPcm16Base64(e.inputBuffer.getChannelData(0)), mimeType: 'audio/pcm;rate=16000' },
            });
            triggerSyncIndicator();
          }
        };
      };

      if (!audioContextRef.current.audioWorklet) {
        setupFallback();
      } else {
        try {
          await audioContextRef.current.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);
          const workletNode = new AudioWorkletNode(audioContextRef.current, 'audio-processor');
          source.connect(workletNode);
          workletNode.connect(audioContextRef.current.destination);

          let audioBuffer: Float32Array[] = [];
          let bufferLength = 0;
          const BUFFER_THRESHOLD = 1600;

          workletNode.port.onmessage = (e) => {
            if (!sessionRef.current || statusRef.current !== 'active') return;
            audioBuffer.push(new Float32Array(e.data));
            bufferLength += e.data.length;
            if (bufferLength >= BUFFER_THRESHOLD) {
              const combined = new Float32Array(bufferLength);
              let offset = 0;
              for (const chunk of audioBuffer) { combined.set(chunk, offset); offset += chunk.length; }
              try {
                sessionRef.current.sendRealtimeInput({
                  audio: { data: float32ToPcm16Base64(combined), mimeType: 'audio/pcm;rate=16000' },
                });
              } catch { /* session may have closed */ }
              audioBuffer = [];
              bufferLength = 0;
              triggerSyncIndicator();
            }
          };
        } catch {
          setupFallback();
        }
      }

      // Video frame streaming (meeting mode)
      const captureFrame = () => {
        if (statusRef.current !== 'active') return;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const session = sessionRef.current;
        if (video && canvas && session && video.videoWidth > 0) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const base64Data = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
            session.sendRealtimeInput({ video: { data: base64Data, mimeType: 'image/jpeg' } });
            triggerSyncIndicator();
          }
        }
        setTimeout(captureFrame, 1000);
      };
      captureFrame();
    } catch (err: any) {
      setError(getFriendlyErrorMessage(err));
      stopSession();
    }
  };

  const playAudioChunk = (base64Data: string) => {
    if (!audioContextRef.current) return;
    const float32Data = pcm16Base64ToFloat32(base64Data);
    const buffer = audioContextRef.current.createBuffer(1, float32Data.length, 24000);
    buffer.getChannelData(0).set(float32Data);
    const src = audioContextRef.current.createBufferSource();
    src.buffer = buffer;
    src.connect(audioContextRef.current.destination);
    src.start();
  };

  const handleSignOut = () => authService.signOut();

  // ── Auth gate ─────────────────────────────────────────────

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-hw-accent animate-spin" />
      </div>
    );
  }

  if (!user && !isGuestMode) return <Auth />;

  if (!user && isGuestMode) {
    return (
      <div className="min-h-screen bg-[#050505] text-hw-text flex flex-col overflow-hidden font-sans">
        <header className="h-16 border-b border-white/5 bg-black/40 backdrop-blur-xl flex items-center justify-between px-6 z-50 shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-hw-accent rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(0,255,157,0.3)]">
              <Mic className="w-6 h-6 text-hw-bg" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight uppercase">VoxTranscribe <span className="text-hw-accent">Pro</span></h1>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-hw-accent animate-pulse" />
                <span className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">Guest Mode</span>
              </div>
            </div>
          </div>
          <button onClick={() => window.location.href = '/'} className="text-xs font-bold uppercase tracking-widest text-hw-muted hover:text-white transition-colors">
            Fazer Login
          </button>
        </header>
        <main className="flex-1 flex flex-col min-h-0 bg-black/40 relative">
          <ConferenceView
            onStartAI={(stream) => startSession('meeting', stream)}
            onStopAI={(cancel, count) => stopSession(cancel, count)}
            isAIActive={isRecording}
            user={null}
          />
        </main>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#050505] text-hw-text flex flex-col overflow-hidden font-sans selection:bg-hw-accent/30 selection:text-hw-accent">
      {/* Top bar */}
      <header className="h-16 border-b border-white/5 bg-black/40 backdrop-blur-xl flex items-center justify-between px-4 sm:px-6 z-50 shrink-0">
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
            className="md:hidden p-2 hover:bg-white/5 rounded-xl transition-colors text-hw-muted hover:text-white"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="w-8 h-8 sm:w-10 sm:h-10 bg-hw-accent rounded-lg sm:rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(0,255,157,0.3)]">
            <Mic className="w-5 h-5 sm:w-6 sm:h-6 text-hw-bg" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-lg font-bold text-white tracking-tight uppercase truncate">
              VoxTranscribe <span className="text-hw-accent">Pro</span>
            </h1>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <span className="w-1 h-1 sm:w-1.5 sm:h-1.5 rounded-full bg-hw-accent animate-pulse" />
              <span className="text-[8px] sm:text-[10px] font-mono text-hw-muted uppercase tracking-widest truncate">
                System Online
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-6">
          <div className="hidden sm:flex items-center gap-4 px-4 py-2 bg-white/5 rounded-full border border-white/10">
            <div className="flex items-center gap-2">
              <div className={cn('w-2 h-2 rounded-full', isRecording ? 'bg-red-500 animate-pulse' : 'bg-hw-muted/30')} />
              <span className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">
                {isRecording ? `Gravando: ${formatDuration(recordingDuration)}` : 'Standby'}
              </span>
            </div>
            <div className="w-px h-3 bg-white/10" />
            <div className="flex items-center gap-2">
              <Activity className="w-3 h-3 text-hw-accent" />
              <span className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">
                Sync: {latency}ms
              </span>
            </div>
          </div>
          <button
            onClick={() => setActiveView('settings')}
            className="p-2 hover:bg-white/5 rounded-xl transition-colors text-hw-muted hover:text-white"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar overlay (mobile) */}
        <AnimatePresence>
          {isSidebarExpanded && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setIsSidebarExpanded(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden"
            />
          )}
        </AnimatePresence>

        {/* Sidebar */}
        <aside className={cn(
          'border-r border-white/5 bg-black/20 backdrop-blur-md flex flex-col shrink-0 transition-all duration-300 z-40',
          'fixed inset-y-0 left-0 md:relative',
          isSidebarExpanded ? 'w-64 translate-x-0' : 'w-20 -translate-x-full md:translate-x-0',
        )}>
          <div className="p-4 flex flex-col h-full">
            <button
              onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
              className="mb-8 p-2 hover:bg-white/5 rounded-xl transition-colors text-hw-muted hover:text-white self-end"
            >
              <Menu className="w-5 h-5" />
            </button>

            <nav className="space-y-1 sm:space-y-2 flex-1">
              {([
                { view: 'recording' as ActiveView, label: 'Gravação', Icon: Mic },
                { view: 'workspace' as ActiveView, label: 'Workspace', Icon: Monitor },
                { view: 'dashboard' as ActiveView, label: 'Dashboard', Icon: LayoutDashboard },
                { view: 'conference' as ActiveView, label: 'Videoconferência', Icon: Users },
                { view: 'settings' as ActiveView, label: 'Configurações', Icon: Settings },
              ]).map(({ view, label, Icon }) => (
                <button
                  key={view}
                  onClick={() => {
                    setActiveView(view);
                    if (window.innerWidth < 768) setIsSidebarExpanded(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-4 p-4 sm:p-3 rounded-xl transition-all',
                    activeView === view
                      ? 'bg-hw-accent/10 text-hw-accent border border-hw-accent/20'
                      : 'text-hw-muted hover:bg-white/5',
                    !isSidebarExpanded && 'justify-center',
                  )}
                  title={!isSidebarExpanded ? label : undefined}
                >
                  <Icon className="w-6 h-6 sm:w-5 sm:h-5 shrink-0" />
                  {isSidebarExpanded && (
                    <span className="text-xs sm:text-[10px] font-bold uppercase tracking-widest truncate">
                      {label}
                    </span>
                  )}
                </button>
              ))}

              {(userProfile?.role === 'owner' || userProfile?.role === 'admin') && (
                <button
                  onClick={() => {
                    setActiveView('admin');
                    if (window.innerWidth < 768) setIsSidebarExpanded(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-4 p-4 sm:p-3 rounded-xl transition-all',
                    activeView === 'admin'
                      ? 'bg-hw-accent/10 text-hw-accent border border-hw-accent/20'
                      : 'text-hw-muted hover:bg-white/5',
                    !isSidebarExpanded && 'justify-center',
                  )}
                  title={!isSidebarExpanded ? 'Admin' : undefined}
                >
                  <ShieldCheck className="w-6 h-6 sm:w-5 sm:h-5 shrink-0" />
                  {isSidebarExpanded && (
                    <span className="text-xs sm:text-[10px] font-bold uppercase tracking-widest truncate">Admin</span>
                  )}
                </button>
              )}
            </nav>
          </div>

          {/* User section */}
          <div className="p-4 border-t border-white/5">
            <div className="flex items-center gap-3 mb-4 px-2">
              {user!.photoURL ? (
                <img
                  src={user!.photoURL}
                  alt="Profile"
                  className="w-8 h-8 rounded-full border border-white/10"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-hw-accent/20 flex items-center justify-center border border-hw-accent/30">
                  <span className="text-hw-accent font-bold text-xs">
                    {user!.email?.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              {isSidebarExpanded && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{user!.displayName || 'Usuário'}</p>
                  <p className="text-[10px] text-hw-muted truncate">{user!.email}</p>
                </div>
              )}
            </div>
            <button
              onClick={handleSignOut}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-xl transition-all',
                'text-hw-muted hover:bg-red-500/10 hover:text-red-500',
                !isSidebarExpanded && 'justify-center',
              )}
              title={!isSidebarExpanded ? 'Sair' : undefined}
            >
              <LogOut className="w-5 h-5 shrink-0" />
              {isSidebarExpanded && (
                <span className="text-[10px] font-bold uppercase tracking-widest truncate">Sair</span>
              )}
            </button>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0 bg-black/40 relative">
          <AnimatePresence mode="wait">

            {/* ── Recording view ──────────────────────────────────── */}
            {activeView === 'recording' && (
              <motion.div
                key="recording"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="flex-1 flex min-h-0"
              >
                {/* Left controls panel */}
                <aside className="w-80 border-r border-white/5 bg-black/20 backdrop-blur-md flex flex-col shrink-0 overflow-y-auto scrollbar-hide">
                  <div className="p-6 space-y-8">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">
                          Interface de Controle
                        </h2>
                        <Zap className="w-3 h-3 text-hw-accent" />
                      </div>

                      <div className="grid gap-3">
                        {/* Consent checkbox */}
                        <div className="flex items-start gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
                          <input
                            type="checkbox"
                            id="consent"
                            checked={hasConsented}
                            onChange={(e) => setHasConsented(e.target.checked)}
                            className="mt-0.5 w-3 h-3 rounded border-white/20 bg-black/50 text-hw-accent focus:ring-hw-accent focus:ring-offset-0 cursor-pointer"
                          />
                          <label htmlFor="consent" className="text-[9px] text-hw-muted leading-tight cursor-pointer">
                            Confirmo que todos os participantes consentiram com a gravação e transcrição (LGPD).
                          </label>
                        </div>

                        {/* Mic / local recording */}
                        <button
                          disabled={(!hasConsented && !isRecording && !isCountingDown) || ((isRecording || isCountingDown) && mode !== 'local')}
                          onClick={() => {
                            if (!hasValidKey) { setError('A GEMINI_API_KEY não foi detectada.'); return; }
                            if (isRecording) stopSession();
                            else if (isCountingDown) cancelSession();
                            else startSessionWithCountdown('local');
                          }}
                          className={cn(
                            'group relative w-full flex items-center gap-4 p-4 rounded-2xl border transition-all overflow-hidden',
                            mode === 'local'
                              ? 'bg-hw-accent border-hw-accent text-hw-bg'
                              : 'bg-white/5 border-white/10 text-hw-muted hover:border-hw-accent/50 hover:text-hw-accent',
                          )}
                        >
                          <div className={cn('p-2.5 rounded-xl', mode === 'local' ? 'bg-hw-bg/20' : 'bg-white/5 group-hover:bg-hw-accent/10')}>
                            <Mic className="w-5 h-5" />
                          </div>
                          <div className="text-left">
                            <div className="text-xs font-bold uppercase tracking-tight">
                              {mode === 'local' && (isRecording || isCountingDown)
                                ? (isCountingDown ? `Cancelar (${countdown}s)` : 'Finalizar')
                                : 'Instantâneo'}
                            </div>
                            <div className="text-[9px] opacity-60 font-medium">Notas rápidas e ditado.</div>
                          </div>
                        </button>

                        {/* Meeting / screen recording */}
                        <button
                          disabled={(!hasConsented && !isRecording && !isCountingDown) || ((isRecording || isCountingDown) && mode !== 'meeting')}
                          onClick={() => {
                            if (!hasValidKey) { setError('A GEMINI_API_KEY não foi detectada.'); return; }
                            if (isRecording) stopSession();
                            else if (isCountingDown) cancelSession();
                            else startSessionWithCountdown('meeting');
                          }}
                          className={cn(
                            'group relative w-full flex items-center gap-4 p-4 rounded-2xl border transition-all overflow-hidden',
                            mode === 'meeting'
                              ? 'bg-blue-500 border-blue-500 text-white'
                              : 'bg-white/5 border-white/10 text-hw-muted hover:border-blue-500/50 hover:text-blue-500',
                          )}
                        >
                          <div className={cn('p-2.5 rounded-xl', mode === 'meeting' ? 'bg-white/20' : 'bg-white/5 group-hover:bg-blue-500/10')}>
                            <Monitor className="w-5 h-5" />
                          </div>
                          <div className="text-left">
                            <div className="text-xs font-bold uppercase tracking-tight">
                              {mode === 'meeting' && (isRecording || isCountingDown)
                                ? (isCountingDown ? `Cancelar (${countdown}s)` : 'Finalizar')
                                : 'Reunião'}
                            </div>
                            <div className="text-[9px] opacity-60 font-medium">Tela/Aba • Entrevistas R&S.</div>
                          </div>
                        </button>
                      </div>
                    </div>

                    {/* Video feed (meeting mode) */}
                    {mode === 'meeting' && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h2 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">Monitor de Vídeo</h2>
                          <div className="flex items-center gap-1">
                            <div className="w-1 h-1 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-[8px] font-mono text-red-500 uppercase">Live</span>
                          </div>
                        </div>
                        <div className="relative aspect-video rounded-2xl overflow-hidden bg-black border border-white/10 shadow-2xl">
                          <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-contain bg-black/20" />
                          <canvas ref={canvasRef} className="hidden" width="640" height="480" />
                        </div>
                      </div>
                    )}

                    {/* Waveform */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">Sinal de Áudio</h2>
                        <span className="text-[9px] font-mono text-hw-accent">{Math.round(audioLevel * 100)}%</span>
                      </div>
                      <WaveformVisualizer audioLevel={audioLevel} isRecording={isRecording} />
                    </div>

                    {/* Summary tone */}
                    <div className="space-y-6">
                      <div className="space-y-3">
                        <label className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
                          <Settings className="w-3 h-3" /> Tom do Resumo
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          {(['executive', 'technical', 'educational', 'full', 'interview'] as SummaryTone[]).map((t) => (
                            <button
                              key={t}
                              onClick={() => setSummaryTone(t)}
                              className={cn(
                                'py-2 px-1 rounded-xl border text-[9px] font-mono uppercase transition-all',
                                summaryTone === t
                                  ? 'border-hw-accent bg-hw-accent/10 text-hw-accent'
                                  : 'border-white/5 bg-white/5 text-hw-muted hover:border-white/20',
                              )}
                            >
                              {t === 'executive' ? 'Executivo' : t === 'technical' ? 'Técnico' : t === 'educational' ? 'Educação' : t === 'full' ? 'Completo' : 'Entrevista'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Capture mode */}
                      <div className="space-y-3">
                        <label className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
                          <Monitor className="w-3 h-3" /> Modo de Captura
                        </label>
                        <div className="flex gap-2">
                          {(['live', 'hybrid', 'recorder'] as RecordingMode[]).map((m) => (
                            <button
                              key={m}
                              onClick={() => setRecordingMode(m)}
                              className={cn(
                                'flex-1 py-2 rounded-xl border text-[9px] font-mono uppercase transition-all',
                                recordingMode === m
                                  ? 'border-hw-accent bg-hw-accent/10 text-hw-accent'
                                  : 'border-white/5 bg-white/5 text-hw-muted hover:border-white/20',
                              )}
                            >
                              {m === 'live' ? 'Live' : m === 'hybrid' ? 'Híbrido' : 'Rec'}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Recent sessions */}
                    <div className="space-y-4 pt-4 border-t border-white/5">
                      <div className="flex items-center justify-between">
                        <h2 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">Sessões Recentes</h2>
                        <History className="w-3 h-3 text-hw-muted" />
                      </div>
                      <div className="space-y-2">
                        {history.length === 0 ? (
                          <div className="py-8 text-center text-[10px] font-mono text-hw-muted/30 uppercase tracking-widest">Vazio</div>
                        ) : (
                          history.slice(0, 5).map((session) => (
                            <button
                              key={session.id}
                              onClick={() => {
                                setTranscriptions(session.transcriptions || []);
                                setSummary(session.summary || null);
                                setMode(session.mode);
                                setActiveResultTab('summary');
                              }}
                              className="w-full text-left p-3 rounded-xl bg-white/5 border border-white/5 hover:border-hw-accent/30 hover:bg-hw-accent/5 transition-all group"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[9px] font-bold text-hw-accent uppercase">{session.mode}</span>
                                <span className="text-[8px] text-hw-muted font-mono">
                                  {session.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              <div className="text-[10px] text-hw-muted line-clamp-1 group-hover:text-hw-text transition-colors">
                                {session.summary || 'Sem resumo disponível'}
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </aside>

                {/* Right: results area */}
                <div className="flex-1 flex flex-col min-h-0">
                  {/* Result tabs */}
                  <div className="h-14 border-b border-white/5 flex items-center justify-between px-8 shrink-0">
                    <div className="flex gap-8">
                      {(['summary', 'transcription'] as const).map(tab => (
                        <button
                          key={tab}
                          onClick={() => setActiveResultTab(tab)}
                          className={cn(
                            'h-14 px-2 text-[10px] font-bold uppercase tracking-[0.2em] transition-all border-b-2',
                            activeResultTab === tab
                              ? 'border-hw-accent text-hw-accent'
                              : 'border-transparent text-hw-muted hover:text-hw-text',
                          )}
                        >
                          {tab === 'summary' ? 'Inteligência' : 'Transcrição'}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-4">
                      {isRecording && (
                        <div className="flex items-center gap-3 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg">
                          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                          <span className="text-[10px] font-mono text-red-500 font-bold uppercase tracking-widest">Recording</span>
                        </div>
                      )}
                      {summary && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setTranscriptions([]); setSummary(null); setLiveTranscription(''); }}
                            className="flex items-center gap-2 px-3 py-1.5 bg-hw-accent/10 hover:bg-hw-accent/20 text-hw-accent rounded-lg transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                            <span className="text-[10px] font-bold uppercase tracking-widest">Nova Sessão</span>
                          </button>
                          <button
                            onClick={() => {
                              const content = activeResultTab === 'summary'
                                ? (summary || '')
                                : transcriptions.map(t => `[${t.timestamp.toLocaleTimeString()}] ${t.type === 'user' ? 'Usuário' : 'Gemini'}: ${t.text}`).join('\n');
                              navigator.clipboard.writeText(content);
                            }}
                            className="p-2 hover:bg-white/5 rounded-lg transition-colors text-hw-muted hover:text-hw-accent"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              const content = activeResultTab === 'summary'
                                ? (summary || '')
                                : transcriptions.map(t => `[${t.timestamp.toLocaleTimeString()}] ${t.type === 'user' ? 'Usuário' : 'Gemini'}: ${t.text}`).join('\n');
                              const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `vox-${activeResultTab}.md`;
                              a.click();
                            }}
                            className="p-2 hover:bg-white/5 rounded-lg transition-colors text-hw-muted hover:text-hw-accent"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                      <button
                        onClick={() => { setTranscriptions([]); setSummary(null); setLiveTranscription(''); }}
                        className="p-2 hover:bg-white/5 rounded-lg transition-colors text-hw-muted hover:text-red-500"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Content area */}
                  <div className="flex-1 overflow-y-auto p-8 scrollbar-hide">
                    <div className="max-w-4xl mx-auto">
                      <AnimatePresence mode="wait">
                        {isSummarizing ? (
                          <motion.div
                            key="loading"
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="h-[60vh] flex flex-col items-center justify-center gap-6"
                          >
                            <div className="w-16 h-16 border-4 border-hw-accent border-t-transparent rounded-full animate-spin" />
                            <div className="text-center space-y-2">
                              <h3 className="text-sm font-bold uppercase tracking-widest text-hw-accent">Sincronizando Insights</h3>
                              <p className="text-[10px] font-mono text-hw-muted">A IA está processando a sessão...</p>
                            </div>
                          </motion.div>
                        ) : activeResultTab === 'summary' ? (
                          <motion.div key="summary" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
                            {summary ? (
                              <div className="glass-panel p-10 relative overflow-hidden group border-hw-accent/20">
                                <div className="absolute top-0 left-0 w-1 h-full bg-hw-accent" />
                                <div className="absolute top-6 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300">
                                  <button
                                    onClick={() => navigator.clipboard.writeText(summary)}
                                    className="p-2.5 bg-black/60 hover:bg-hw-accent/20 text-hw-muted hover:text-hw-accent rounded-xl border border-white/10 backdrop-blur-xl transition-all shadow-2xl"
                                  >
                                    <Copy className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      const url = URL.createObjectURL(new Blob([summary], { type: 'text/markdown' }));
                                      const a = document.createElement('a');
                                      a.href = url;
                                      a.download = `resumo-vox-${new Date().toISOString().split('T')[0]}.md`;
                                      a.click();
                                    }}
                                    className="p-2.5 bg-black/60 hover:bg-hw-accent/20 text-hw-muted hover:text-hw-accent rounded-xl border border-white/10 backdrop-blur-xl transition-all shadow-2xl"
                                  >
                                    <Download className="w-4 h-4" />
                                  </button>
                                </div>
                                <div className="prose prose-invert max-w-none">
                                  <div className="text-hw-text leading-relaxed whitespace-pre-wrap font-medium text-lg markdown-content">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="h-[60vh] flex flex-col items-center justify-center text-hw-muted/20 gap-6">
                                <Zap className="w-20 h-20" />
                                <div className="text-center space-y-2">
                                  <h3 className="text-sm font-bold uppercase tracking-widest">Aguardando Processamento</h3>
                                  <p className="text-[10px] font-mono">Inicie uma gravação para gerar insights automáticos.</p>
                                </div>
                              </div>
                            )}
                          </motion.div>
                        ) : (
                          <motion.div key="transcription" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                            {transcriptions.length === 0 && !liveTranscription ? (
                              <div className="h-[60vh] flex flex-col items-center justify-center text-hw-muted/20 gap-6">
                                <Mic className="w-20 h-20" />
                                <div className="text-center space-y-2">
                                  <h3 className="text-sm font-bold uppercase tracking-widest">Stream de Áudio Vazio</h3>
                                  <p className="text-[10px] font-mono">O sistema está pronto para capturar áudio em tempo real.</p>
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-6 relative group">
                                <div className="absolute top-0 right-0 z-10 opacity-0 group-hover:opacity-100 transition-all duration-300">
                                  <button
                                    onClick={() => navigator.clipboard.writeText(
                                      transcriptions.map(t => `[${t.timestamp.toLocaleTimeString()}] ${t.type === 'user' ? 'Usuário' : 'Gemini'}: ${t.text}`).join('\n'),
                                    )}
                                    className="flex items-center gap-2 px-4 py-2 bg-black/60 hover:bg-hw-accent/20 text-hw-muted hover:text-hw-accent rounded-xl border border-white/10 backdrop-blur-xl transition-all shadow-2xl text-[10px] font-bold uppercase tracking-widest"
                                  >
                                    <Copy className="w-3 h-3" /> Copiar Tudo
                                  </button>
                                </div>
                                {transcriptions.map((t) => (
                                  <div
                                    key={t.id}
                                    className={cn('flex flex-col gap-2 max-w-[85%]', t.type === 'user' ? 'ml-auto items-end' : 'mr-auto items-start')}
                                  >
                                    <div className={cn(
                                      'px-6 py-4 rounded-2xl text-sm leading-relaxed shadow-xl',
                                      t.type === 'user'
                                        ? 'bg-hw-accent text-hw-bg font-bold rounded-tr-none'
                                        : 'bg-white/5 border border-white/10 text-hw-text rounded-tl-none backdrop-blur-sm',
                                    )}>
                                      {t.text}
                                    </div>
                                    <div className="flex items-center gap-2 px-2 opacity-40">
                                      <span className="text-[8px] font-mono uppercase tracking-widest">
                                        {t.type === 'user' ? 'Input' : 'Gemini'}
                                      </span>
                                      <span className="text-[8px] font-mono">{t.timestamp.toLocaleTimeString()}</span>
                                    </div>
                                  </div>
                                ))}
                                {liveTranscription && (
                                  <div className="flex flex-col gap-2 max-w-[85%] ml-auto items-end opacity-60">
                                    <div className="px-6 py-4 rounded-2xl text-sm bg-hw-accent/20 border border-hw-accent/30 text-hw-accent italic rounded-tr-none animate-pulse">
                                      {liveTranscription}...
                                    </div>
                                  </div>
                                )}
                                <div ref={transcriptEndRef} />
                              </div>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ── Workspace view ────────────────────────────────── */}
            {activeView === 'workspace' && (
              <motion.div
                key="workspace"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="flex-1 flex flex-col min-h-0 p-8 overflow-y-auto"
              >
                <WorkspaceView
                  history={history}
                  onSelectSession={(session) => {
                    setTranscriptions(session.transcriptions || []);
                    setSummary(session.summary || null);
                    setMode(session.mode);
                    setActiveResultTab('summary');
                    setActiveView('recording');
                  }}
                  onDeleteSession={deleteHistoryItem}
                />
              </motion.div>
            )}

            {/* ── Dashboard view ────────────────────────────────── */}
            {activeView === 'dashboard' && (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
                className="flex-1 overflow-y-auto scrollbar-hide"
              >
                <DashboardView
                  history={history}
                  onNavigateToWorkspace={() => setActiveView('workspace')}
                  userProfile={userProfile}
                  organization={organization}
                />
              </motion.div>
            )}

            {/* ── Conference view ───────────────────────────────── */}
            {activeView === 'conference' && (
              <motion.div
                key="conference"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="flex-1 flex flex-col min-h-0"
              >
                <ConferenceView
                  onStartAI={(stream) => startSession('meeting', stream)}
                  onStopAI={(cancel, count) => stopSession(cancel, count)}
                  isAIActive={isRecording}
                  user={user}
                />
              </motion.div>
            )}

            {/* ── Settings view ─────────────────────────────────── */}
            {activeView === 'settings' && (
              <motion.div
                key="settings"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="flex-1 overflow-y-auto p-8"
              >
                <SettingsView
                  settings={{ echoCancellation, noiseSuppression, fluidAnimations, showTooltips }}
                  setSettings={{ setEchoCancellation, setNoiseSuppression, setFluidAnimations, setShowTooltips }}
                  summaryTone={summaryTone}
                  setSummaryTone={setSummaryTone}
                  recordingMode={recordingMode}
                  setRecordingMode={setRecordingMode}
                />
              </motion.div>
            )}

            {/* ── Admin view ────────────────────────────────────── */}
            {activeView === 'admin' && (
              <motion.div
                key="admin"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="flex-1 overflow-y-auto p-8"
              >
                <AdminView
                  organization={organization}
                  orgKeys={orgKeys}
                  orgMembers={orgMembers}
                  currentUserId={user?.uid || null}
                  onUpdateOrg={handleUpdateOrg}
                  onCreateKey={handleCreateKey}
                  onDeleteKey={handleDeleteKey}
                  onUpdateMemberRole={handleUpdateMemberRole}
                />
              </motion.div>
            )}

          </AnimatePresence>

          {/* Status bar */}
          <div className="h-12 border-t border-white/5 bg-black/40 backdrop-blur-xl flex items-center justify-between px-8 shrink-0">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <div className={cn('w-1.5 h-1.5 rounded-full', status === 'active' ? 'bg-hw-accent led-glow' : 'bg-hw-muted/30')} />
                <span className="text-[9px] font-mono text-hw-muted uppercase tracking-widest">Status: {status}</span>
              </div>
              <div className="w-px h-3 bg-white/10" />
              <div className="flex items-center gap-2">
                <Wifi className="w-3 h-3 text-hw-muted" />
                <span className="text-[9px] font-mono text-hw-muted uppercase tracking-widest">Latency: {latency}ms</span>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <span className="text-[9px] font-mono text-hw-muted uppercase tracking-widest">VoxTranscribe Systems © 2026</span>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-3 h-3 text-hw-accent" />
                <span className="text-[9px] font-mono text-hw-muted uppercase tracking-widest">Secure Link</span>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Mobile FAB */}
      <div className="md:hidden fixed bottom-6 right-6 z-50">
        <button
          onClick={() => isRecording ? stopSession() : startSessionWithCountdown('local')}
          className={cn(
            'w-14 h-14 rounded-full flex items-center justify-center shadow-2xl transition-all',
            isRecording ? 'bg-red-500 text-white' : 'bg-hw-accent text-hw-bg',
          )}
        >
          {isRecording ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>
      </div>

      {/* Error toast */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-6 py-4 bg-red-500/10 border border-red-500/20 rounded-2xl backdrop-blur-xl shadow-2xl max-w-md w-full mx-4"
          >
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-400 font-mono flex-1">{error}</p>
            <button
              onClick={() => setError(null)}
              className="p-1 hover:bg-white/10 rounded-lg transition-colors text-hw-muted hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;
