import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { Video, Mic, MicOff, VideoOff, Copy, PhoneOff, Users, Link as LinkIcon, AlertCircle, Share2, Shield, UserMinus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { AuthUser } from '../services/auth.service';

const useAudioLevel = (stream: MediaStream | null) => {
  const [level, setLevel] = useState(0);
  const [trackCount, setTrackCount] = useState(stream?.getAudioTracks().length || 0);

  useEffect(() => {
    if (!stream) return;
    const updateCount = () => setTrackCount(stream.getAudioTracks().length);
    stream.addEventListener('addtrack', updateCount);
    stream.addEventListener('removetrack', updateCount);
    return () => {
      stream.removeEventListener('addtrack', updateCount);
      stream.removeEventListener('removetrack', updateCount);
    };
  }, [stream]);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return;
    }

    let audioContext: AudioContext;
    let analyser: AnalyserNode;
    let source: MediaStreamAudioSourceNode;
    let animationFrame: number;

    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setLevel(average / 255);
        animationFrame = requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch (err) {
      console.error("Audio level error:", err);
    }

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (source) source.disconnect();
      if (audioContext && audioContext.state !== 'closed') audioContext.close();
    };
  }, [stream, trackCount]);

  return level;
};

interface Peer {
  id: string;
  name: string;
  stream: MediaStream;
  pc: RTCPeerConnection;
  isMuted?: boolean;
  isVideoOff?: boolean;
}

interface ConferenceViewProps {
  onStartAI: (stream: MediaStream) => void;
  onStopAI: (cancel?: boolean, participantsCount?: number) => void;
  isAIActive: boolean;
  user?: AuthUser | null;
}

export const ConferenceView = ({ onStartAI, onStopAI, isAIActive, user }: ConferenceViewProps) => {
  const [roomId, setRoomId] = useState<string>('');
  const [userName, setUserName] = useState<string>(user?.displayName || user?.email?.split('@')[0] || '');
  const [inRoom, setInRoom] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [isRoomLocked, setIsRoomLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localAudioLevel = useAudioLevel(localStream || previewStream);
  
  const socketRef = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const userIdRef = useRef(user?.uid || uuidv4());
  const peersRef = useRef<Peer[]>([]);
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const mixedStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  const [isAIActiveLocal, setIsAIActiveLocal] = useState(isAIActive);

  // Sync state with ref for callbacks
  useEffect(() => {
    peersRef.current = peers;
    
    // Update AI audio mix if active
    if (isAIActiveLocal && audioContextRef.current && audioDestinationRef.current) {
      const ctx = audioContextRef.current;
      const dest = audioDestinationRef.current;
      
      // Add new peers to mix
      peers.forEach(peer => {
        if (peer.stream && peer.stream.getAudioTracks().length > 0 && !audioSourcesRef.current.has(peer.id)) {
          try {
            const source = ctx.createMediaStreamSource(peer.stream);
            source.connect(dest);
            audioSourcesRef.current.set(peer.id, source);
            console.log(`VoxTranscribe Pro: Added peer ${peer.id} to AI mix`);
          } catch (err) {
            console.error(`VoxTranscribe Pro: Error adding peer ${peer.id} to mix:`, err);
          }
        }
      });
      
      // Remove disconnected peers from mix
      audioSourcesRef.current.forEach((source, id) => {
        if (!peers.find(p => p.id === id)) {
          source.disconnect();
          audioSourcesRef.current.delete(id);
          console.log(`VoxTranscribe Pro: Removed peer ${id} from AI mix`);
        }
      });
    }
  }, [peers, isAIActiveLocal]);

  useEffect(() => {
    setIsAIActiveLocal(isAIActive);
  }, [isAIActive]);

  // Handle URL parameters for auto-joining
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam);
      setIsRoomLocked(true);
    }
  }, []);

  // Initialize preview stream for join screen
  useEffect(() => {
    let active = true;
    let currentStream: MediaStream | null = null;
    
    if (!inRoom) {
      const startPreview = async () => {
        try {
          // Check for available devices first
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasVideo = devices.some(d => d.kind === 'videoinput');
          const hasAudio = devices.some(d => d.kind === 'audioinput');

          if (!active) return;

          if (hasVideo || hasAudio) {
            const stream = await navigator.mediaDevices.getUserMedia({ 
              video: hasVideo ? { 
                width: { ideal: 1280 }, 
                height: { ideal: 720 },
                aspectRatio: { ideal: 1.7777777778 },
                facingMode: "user"
              } : false, 
              audio: hasAudio ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                channelCount: 1
              } : false 
            });
            if (!active) {
              stream.getTracks().forEach(t => t.stop());
              return;
            }
            currentStream = stream;
            setPreviewStream(stream);
            if (previewVideoRef.current) {
              previewVideoRef.current.srcObject = stream;
            }
          }
        } catch (err) {
          console.error("VoxTranscribe Pro: Preview failed:", err);
        }
      };
      startPreview();
    }
    
    return () => {
      active = false;
      if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
      }
      setPreviewStream(null);
    };
  }, [inRoom]);

  // Ensure local video is attached when in room
  useEffect(() => {
    if (inRoom && localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [inRoom, localStream]);

  const initLocalStream = async () => {
    console.log("VoxTranscribe Pro: Initializing local stream...");
    
    // Helper to check what's available
    const getAvailableDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return {
          hasAudio: devices.some(d => d.kind === 'audioinput'),
          hasVideo: devices.some(d => d.kind === 'videoinput')
        };
      } catch (e) {
        return { hasAudio: true, hasVideo: true }; // Assume both if blocked
      }
    };

    const { hasAudio, hasVideo } = await getAvailableDevices();
    console.log(`VoxTranscribe Pro: Hardware detected - Audio: ${hasAudio}, Video: ${hasVideo}`);

    try {
      // Try to get what's available
      const constraints: MediaStreamConstraints = {
        audio: hasAudio ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
          sampleSize: 16
        } : false,
        video: hasVideo ? {
          facingMode: "user",
          aspectRatio: { ideal: 1.7777777778, min: 1.3333333333 },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } : false
      };

      // If nothing is available, return an empty stream so we can still join as viewer
      if (!hasAudio && !hasVideo) {
        console.warn("VoxTranscribe Pro: No media devices found. Joining as viewer only.");
        const emptyStream = new MediaStream();
        setLocalStream(emptyStream);
        setIsVideoOff(true);
        setIsMuted(true);
        return emptyStream;
      }

      // Stop preview stream if it exists to free up devices
      if (previewStream) {
        previewStream.getTracks().forEach(t => t.stop());
        setPreviewStream(null);
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setLocalStream(stream);
      
      if (hasVideo && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      } else {
        setIsVideoOff(true);
      }

      if (!hasAudio) setIsMuted(true);

      return stream;
    } catch (err: any) {
      console.error("VoxTranscribe Pro: getUserMedia failed:", err);
      
      // Final fallback: try just audio if combined failed
      if (hasAudio) {
        try {
          console.log("VoxTranscribe Pro: Attempting audio-only fallback...");
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          setLocalStream(audioStream);
          setIsVideoOff(true);
          return audioStream;
        } catch (audioErr) {
          console.error("VoxTranscribe Pro: Audio fallback also failed:", audioErr);
        }
      }

      // If all else fails, join with empty stream
      const emptyStream = new MediaStream();
      setLocalStream(emptyStream);
      setIsVideoOff(true);
      setIsMuted(true);
      setError("Aviso: Não foi possível acessar sua câmera ou microfone. Você entrará apenas como ouvinte.");
      return emptyStream;
    }
  };

  const createPeerConnection = (targetId: string, targetName: string, stream: MediaStream) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          target: targetId,
          candidate: event.candidate,
          userId: userIdRef.current
        });
      }
    };

    pc.ontrack = (event) => {
      console.log(`VoxTranscribe Pro: Received track from ${targetId}:`, event.track.kind);
      
      const remoteStream = event.streams[0] || new MediaStream([event.track]);

      setPeers(prev => {
        const existing = prev.find(p => p.id === targetId);
        if (existing) {
          // If it's a new stream object, replace it
          if (event.streams[0] && event.streams[0] !== existing.stream) {
            return prev.map(p => p.id === targetId ? { ...p, stream: event.streams[0] } : p);
          }
          
          // Otherwise, ensure the track is added to the existing stream
          if (!existing.stream.getTracks().find(t => t.id === event.track.id)) {
            existing.stream.addTrack(event.track);
          }
          
          // Force re-render by creating a new peer object reference
          return prev.map(p => p.id === targetId ? { ...p } : p);
        }
        
        return [...prev, { 
          id: targetId, 
          name: targetName, 
          stream: remoteStream, 
          pc, 
          isMuted: false, 
          isVideoOff: false 
        }];
      });
    };

    pc.onconnectionstatechange = () => {
      console.log(`VoxTranscribe Pro: Connection state with ${targetId}:`, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // Handle reconnection or cleanup if needed
      }
    };

    // Add local tracks to the connection
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    return pc;
  };

  const joinRoom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!roomId || !userName) return;

    const stream = await initLocalStream();
    if (!stream) return;

    // Update URL without reloading
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url);

    socketRef.current = io(window.location.origin);
    const socket = socketRef.current;

    socket.on('connect', () => {
      socket.emit('join-room', roomId, userIdRef.current, userName);
    });

    socket.on('is-host', (hostStatus: boolean) => {
      setIsHost(hostStatus);
    });

    socket.on('ai-state-change', (active: boolean) => {
      console.log("VoxTranscribe Pro: AI state changed remotely:", active);
      setIsAIActiveLocal(active);
    });

    socket.on('mute-remote', () => {
      if (localStream) {
        localStream.getAudioTracks().forEach(t => t.enabled = false);
        setIsMuted(true);
        if (socketRef.current) {
          socketRef.current.emit('peer-state-change', { userId: userIdRef.current, isMuted: true, isVideoOff });
        }
      }
    });

    socket.on('kicked', () => {
      leaveRoom();
      setError("Você foi removido da sala pelo anfitrião.");
    });

    socket.on('user-connected', async (newUserId: string, newUserName: string) => {
      console.log('VoxTranscribe Pro: User connected (initiating offer):', newUserId);
      try {
        const pc = createPeerConnection(newUserId, newUserName, stream);
        
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        
        socket.emit('offer', {
          target: newUserId,
          caller: userIdRef.current,
          callerName: userName,
          sdp: offer,
          isMuted,
          isVideoOff
        });

        setPeers(prev => [...prev.filter(p => p.id !== newUserId), { 
          id: newUserId, 
          name: newUserName, 
          stream: new MediaStream(), 
          pc, 
          isMuted: false, 
          isVideoOff: false 
        }]);
      } catch (err) {
        console.error("VoxTranscribe Pro: Error creating offer:", err);
      }
    });

    socket.on('offer', async (payload: any) => {
      console.log('VoxTranscribe Pro: Received offer from (responding with answer):', payload.caller);
      try {
        let peer = peersRef.current.find(p => p.id === payload.caller);
        let pc: RTCPeerConnection;

        if (!peer) {
          pc = createPeerConnection(payload.caller, payload.callerName, stream);
          peer = { 
            id: payload.caller, 
            name: payload.callerName, 
            stream: new MediaStream(), 
            pc, 
            isMuted: payload.isMuted, 
            isVideoOff: payload.isVideoOff 
          };
          setPeers(prev => [...prev.filter(p => p.id !== payload.caller), peer!]);
        } else {
          pc = peer.pc;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        
        // Process any buffered ICE candidates
        const candidates = pendingCandidates.current.get(payload.caller) || [];
        for (const candidate of candidates) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidates.current.delete(payload.caller);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        socket.emit('answer', {
          target: payload.caller,
          caller: userIdRef.current,
          sdp: answer,
          isMuted,
          isVideoOff
        });
      } catch (err) {
        console.error("VoxTranscribe Pro: Error handling offer:", err);
      }
    });

    socket.on('answer', async (payload: any) => {
      console.log('VoxTranscribe Pro: Received answer from:', payload.caller);
      try {
        const peer = peersRef.current.find(p => p.id === payload.caller);
        if (peer) {
          if (peer.pc.signalingState === 'have-local-offer') {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            
            // Process any buffered ICE candidates
            const candidates = pendingCandidates.current.get(payload.caller) || [];
            for (const candidate of candidates) {
              await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pendingCandidates.current.delete(payload.caller);
            
            setPeers(prev => prev.map(p => p.id === payload.caller ? { ...p, isMuted: payload.isMuted, isVideoOff: payload.isVideoOff } : p));
          } else if (peer.pc.signalingState === 'stable') {
            console.log(`VoxTranscribe Pro: Connection already stable for ${payload.caller}, ignoring duplicate answer.`);
          } else {
            console.warn(`VoxTranscribe Pro: Received answer in wrong state: ${peer.pc.signalingState}`);
          }
        }
      } catch (err) {
        console.error("VoxTranscribe Pro: Error setting remote description (answer):", err);
      }
    });

    socket.on('ice-candidate', async (candidate: any, senderId: string) => {
      try {
        const peer = peersRef.current.find(p => p.id === senderId);
        if (peer && peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          // Buffer candidate until remote description is set
          const candidates = pendingCandidates.current.get(senderId) || [];
          candidates.push(candidate);
          pendingCandidates.current.set(senderId, candidates);
        }
      } catch (err) {
        console.error("VoxTranscribe Pro: Error adding ICE candidate:", err);
      }
    });

    socket.on('user-disconnected', (disconnectedId: string) => {
      setPeers(prev => {
        const peer = prev.find(p => p.id === disconnectedId);
        if (peer) peer.pc.close();
        return prev.filter(p => p.id !== disconnectedId);
      });
    });

    socket.on('peer-state-change', (payload: any) => {
      setPeers(prev => prev.map(p => p.id === payload.userId ? { ...p, isMuted: payload.isMuted, isVideoOff: payload.isVideoOff } : p));
    });

    setInRoom(true);
  };

  const localStreamRef = useRef<MediaStream | null>(null);

  // Sync localStream to ref
  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const leaveRoom = (cancel: boolean = false) => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
    }
    peersRef.current.forEach(peer => peer.pc.close());
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    if (isAIActiveLocal && isHost) {
      onStopAI(cancel, peersRef.current.length + 1);
    }
    
    // Cleanup audio context and sources
    audioSourcesRef.current.forEach(source => source.disconnect());
    audioSourcesRef.current.clear();
    if (audioDestinationRef.current) audioDestinationRef.current.disconnect();
    audioDestinationRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;

    setLocalStream(null);
    localStreamRef.current = null;
    setPeers([]);
    peersRef.current = [];
    setInRoom(false);
    
    // Clear URL
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);
  };

  const toggleMute = () => {
    if (localStream) {
      const newMutedState = !isMuted;
      localStream.getAudioTracks().forEach(t => t.enabled = !newMutedState);
      setIsMuted(newMutedState);
      if (socketRef.current) {
        socketRef.current.emit('peer-state-change', { userId: userIdRef.current, isMuted: newMutedState, isVideoOff });
      }
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const newVideoState = !isVideoOff;
      localStream.getVideoTracks().forEach(t => t.enabled = !newVideoState);
      setIsVideoOff(newVideoState);
      if (socketRef.current) {
        socketRef.current.emit('peer-state-change', { userId: userIdRef.current, isMuted, isVideoOff: newVideoState });
      }
    }
  };

  const muteParticipant = (targetId: string) => {
    if (isHost && socketRef.current) {
      socketRef.current.emit('mute-participant', targetId);
    }
  };

  const kickParticipant = (targetId: string) => {
    if (isHost && socketRef.current) {
      socketRef.current.emit('kick-participant', targetId);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
  };

  const shareLink = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'VoxTranscribe Pro - Videoconferência',
          text: 'Junte-se a mim nesta videoconferência:',
          url: url,
        });
      } catch (err) {
        console.error('Erro ao compartilhar:', err);
      }
    } else {
      // Fallback to copy if Web Share API is not supported
      copyLink();
      alert('Link copiado para a área de transferência!');
    }
  };

  const toggleAI = () => {
    if (!isHost) return; // Only host can toggle AI

    if (isAIActive) {
      onStopAI(false, peers.length + 1);
      if (socketRef.current) {
        socketRef.current.emit('ai-state-change', false);
      }
      
      // Cleanup audio sources
      audioSourcesRef.current.forEach(source => source.disconnect());
      audioSourcesRef.current.clear();
      if (audioDestinationRef.current) audioDestinationRef.current.disconnect();
      audioDestinationRef.current = null;
    } else {
      // Mix local and remote audio streams for Gemini
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const dest = ctx.createMediaStreamDestination();
      audioDestinationRef.current = dest;

      // Connect local stream
      if (localStream && localStream.getAudioTracks().length > 0) {
        try {
          const localSource = ctx.createMediaStreamSource(localStream);
          localSource.connect(dest);
          audioSourcesRef.current.set('local', localSource);
        } catch (err) {
          console.error("VoxTranscribe Pro: Error adding local stream to mix:", err);
        }
      }

      // Remote streams will be connected via the useEffect on peers
      mixedStreamRef.current = dest.stream;
      onStartAI(mixedStreamRef.current);
      if (socketRef.current) {
        socketRef.current.emit('ai-state-change', true);
      }
    }
  };

  useEffect(() => {
    return () => {
      if (inRoom) leaveRoom();
    };
  }, [inRoom]);

  if (!inRoom) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 sm:p-8 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/20 via-black to-black">
        <div className="bg-white/5 border border-white/10 p-6 sm:p-8 max-w-4xl w-full grid grid-cols-1 md:grid-cols-2 gap-8 rounded-3xl backdrop-blur-xl shadow-2xl relative overflow-hidden">
          {/* Decorative background elements */}
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 via-hw-accent to-blue-600 opacity-50"></div>
          
          {/* Left Side: Preview */}
          <div className="space-y-6">
            <div className="relative aspect-video bg-black/60 rounded-2xl border border-white/10 overflow-hidden shadow-inner group">
              <video
                ref={previewVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain bg-black/20"
              />
              {!previewStream?.getVideoTracks().some(t => t.enabled) && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                  <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center border border-white/10">
                    <VideoOff className="w-8 h-8 text-white/20" />
                  </div>
                </div>
              )}
              <div className="absolute bottom-4 left-4 right-4 flex justify-center gap-4">
                <div className="px-3 py-1.5 bg-black/60 backdrop-blur-md rounded-full border border-white/10 flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full", localAudioLevel > 0.05 ? "bg-hw-accent animate-pulse" : "bg-white/20")} />
                  <span className="text-[10px] font-mono uppercase text-white/70">Mic Check</span>
                </div>
              </div>
            </div>
            <div className="text-center md:text-left space-y-2">
              <h2 className="text-xl font-bold text-white tracking-tight">Pronto para entrar?</h2>
              <p className="text-xs text-hw-muted">Verifique sua câmera e microfone antes de começar.</p>
            </div>
          </div>

          {/* Right Side: Form */}
          <div className="space-y-6 flex flex-col justify-center">
            <div className="text-center md:text-left space-y-1 mb-2">
              <h3 className="text-lg font-bold text-blue-400">Videoconferência</h3>
              <p className="text-[10px] text-hw-muted uppercase tracking-widest">VoxTranscribe Pro</p>
            </div>

            {error && (
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-start gap-3 text-red-400">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-xs leading-relaxed">{error}</p>
              </div>
            )}

            <form onSubmit={joinRoom} className="space-y-6">
              {/* User Profile Preview */}
              <div className="flex items-center gap-4 p-4 bg-black/40 border border-white/5 rounded-2xl">
                {user?.photoURL ? (
                  <img src={user.photoURL} alt="Profile" className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border border-white/10" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-hw-accent/20 flex items-center justify-center border border-hw-accent/30">
                    <span className="text-hw-accent font-bold text-base sm:text-lg">{userName?.charAt(0).toUpperCase() || 'U'}</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <label className="text-[10px] font-bold uppercase text-hw-muted tracking-widest mb-1 block">Seu Nome</label>
                  <input
                    type="text"
                    required
                    value={userName}
                    onChange={e => setUserName(e.target.value)}
                    className="w-full bg-transparent text-white font-medium focus:outline-none focus:text-hw-accent transition-colors truncate text-sm sm:text-base"
                    placeholder="Como deseja ser chamado?"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase text-hw-muted tracking-widest ml-1">ID da Sala</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Users className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-hw-muted" />
                    <input
                      type="text"
                      required
                      readOnly={isRoomLocked}
                      value={roomId}
                      onChange={e => setRoomId(e.target.value)}
                      className={cn(
                        "w-full bg-black/40 border border-white/10 rounded-2xl py-3 sm:py-4 pl-12 pr-4 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all placeholder:text-white/20 text-sm sm:text-base",
                        isRoomLocked && "opacity-60 cursor-not-allowed"
                      )}
                      placeholder="Ex: sala-123"
                    />
                  </div>
                  {!isRoomLocked && (
                    <button
                      type="button"
                      onClick={() => setRoomId(Math.random().toString(36).substring(2, 8))}
                      className="px-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-xs font-medium text-white transition-colors"
                    >
                      Gerar
                    </button>
                  )}
                </div>
              </div>
              
              <button
                type="submit"
                className="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white rounded-2xl font-bold tracking-wide transition-all shadow-[0_0_30px_rgba(37,99,235,0.3)] hover:shadow-[0_0_40px_rgba(37,99,235,0.5)] flex items-center justify-center gap-2 text-sm sm:text-base"
              >
                <Video className="w-5 h-5" />
                Entrar na Reunião
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-black">
      {/* Top Bar */}
      <div className="h-14 bg-black/40 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-4 sm:px-6 shrink-0 z-10">
        <div className="flex items-center gap-2 sm:gap-4 overflow-hidden">
          <div className="flex items-center gap-2 text-white shrink-0">
            <Users className="w-4 h-4 text-blue-500" />
            <span className="font-bold text-xs sm:text-sm truncate max-w-[80px] sm:max-w-none">{roomId}</span>
          </div>
          <div className="w-px h-4 bg-white/10 shrink-0" />
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            <button 
              onClick={shareLink}
              className="flex items-center gap-2 text-[8px] sm:text-[10px] font-mono uppercase text-hw-muted hover:text-white transition-colors whitespace-nowrap"
            >
              <Share2 className="w-3 h-3" />
              <span className="hidden xs:inline">Compartilhar</span>
            </button>
            <button 
              onClick={copyLink}
              className="flex items-center gap-2 text-[8px] sm:text-[10px] font-mono uppercase text-hw-muted hover:text-white transition-colors whitespace-nowrap"
            >
              <LinkIcon className="w-3 h-3" />
              <span className="hidden xs:inline">Copiar Link</span>
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-3">
          {isHost && (
            <div className="flex items-center gap-1 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <Shield className="w-3 h-3 text-blue-400" />
              <span className="text-[8px] font-bold uppercase text-blue-400 tracking-widest hidden xs:inline">Host</span>
            </div>
          )}
          <button
            onClick={toggleAI}
            disabled={!isHost && !isAIActiveLocal}
            className={cn(
              "flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-lg text-[8px] sm:text-[10px] font-bold uppercase tracking-widest transition-all border",
              isAIActiveLocal 
                ? "bg-hw-accent/20 border-hw-accent text-hw-accent shadow-[0_0_15px_rgba(0,255,157,0.2)]" 
                : "bg-white/5 border-white/10 text-hw-muted hover:bg-white/10",
              !isHost && !isAIActiveLocal && "opacity-50 cursor-not-allowed"
            )}
          >
            <div className={cn("w-1.5 h-1.5 rounded-full", isAIActiveLocal ? "bg-hw-accent animate-pulse" : "bg-white/20")} />
            <span className="hidden xs:inline">
              {isAIActiveLocal ? "IA Analisando" : isHost ? "Ativar IA" : "IA Inativa"}
            </span>
            <span className="xs:hidden">IA</span>
          </button>
        </div>
      </div>

      {/* Video Grid */}
      <div className="flex-1 p-2 sm:p-6 overflow-y-auto bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-blue-900/10 via-black to-black">
        <div className={cn(
          "grid gap-3 sm:gap-6",
          peers.length === 0 ? "grid-cols-1 max-w-4xl mx-auto w-full" : 
          peers.length === 1 ? "grid-cols-1 md:grid-cols-2" : 
          peers.length <= 3 ? "grid-cols-1 md:grid-cols-2" : 
          "grid-cols-1 xs:grid-cols-2 md:grid-cols-3"
        )}>
          {/* Local Video */}
          <div className="relative bg-black/40 rounded-2xl sm:rounded-3xl border border-white/10 overflow-hidden group shadow-2xl ring-1 ring-white/5 aspect-video">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={cn("w-full h-full object-contain bg-black/20 transition-opacity duration-500", isVideoOff && "opacity-0")}
            />
            {isVideoOff && (
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-black/80 to-black/40 backdrop-blur-sm">
                <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-500/20 to-hw-accent/20 flex items-center justify-center border border-white/10 shadow-[0_0_30px_rgba(37,99,235,0.15)]">
                  <span className="text-3xl font-bold text-white">{userName.charAt(0).toUpperCase()}</span>
                </div>
              </div>
            )}
            <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between">
              <div className="px-4 py-2 bg-black/60 backdrop-blur-xl rounded-xl text-sm font-medium text-white border border-white/10 flex items-center gap-3 shadow-lg">
                <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center border border-blue-500/30">
                  <span className="text-[10px] font-bold text-blue-400">{userName.charAt(0).toUpperCase()}</span>
                </div>
                {userName} (Você)
                {isMuted ? (
                  <div className="w-6 h-6 rounded-full bg-red-500/20 flex items-center justify-center ml-1">
                    <MicOff className="w-3 h-3 text-red-500" />
                  </div>
                ) : (
                  <div className={cn("w-6 h-6 rounded-full flex items-center justify-center ml-1 transition-all", localAudioLevel > 0.05 ? "bg-hw-accent/20" : "bg-white/5")}>
                    <Mic className={cn("w-3 h-3 transition-all", localAudioLevel > 0.05 ? "text-hw-accent scale-110" : "text-hw-muted")} />
                  </div>
                )}
              </div>
            </div>
            
            {/* Audio Level Indicator */}
            {!isMuted && localAudioLevel > 0.01 && (
              <div className="absolute top-4 right-4 flex gap-1 items-center bg-black/40 backdrop-blur-md px-2 py-1.5 rounded-lg border border-white/10">
                {[...Array(3)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="w-1 bg-hw-accent rounded-full"
                    animate={{ height: [4, 12, 4] }}
                    transition={{
                      duration: 0.5,
                      repeat: Infinity,
                      delay: i * 0.1,
                      ease: "easeInOut"
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Remote Videos */}
          {peers.map(peer => (
            <RemoteVideo 
              key={peer.id} 
              peer={peer} 
              isHost={isHost}
              onMute={() => muteParticipant(peer.id)}
              onKick={() => kickParticipant(peer.id)}
            />
          ))}
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="h-24 sm:h-20 bg-black/40 backdrop-blur-md border-t border-white/5 flex items-center justify-center gap-3 sm:gap-4 shrink-0 z-10 px-4">
        <button
          onClick={toggleMute}
          className={cn(
            "w-14 h-14 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all relative",
            isMuted ? "bg-red-500/20 text-red-500 hover:bg-red-500/30" : "bg-white/10 text-white hover:bg-white/20"
          )}
        >
          {!isMuted && localAudioLevel > 0.05 && (
            <span className="absolute inset-0 rounded-full bg-hw-accent/30 animate-ping" style={{ animationDuration: '1s', opacity: localAudioLevel }} />
          )}
          {isMuted ? <MicOff className="w-6 h-6 sm:w-5 sm:h-5 relative z-10" /> : <Mic className="w-6 h-6 sm:w-5 sm:h-5 relative z-10" />}
        </button>
        
        <button
          onClick={toggleVideo}
          className={cn(
            "w-14 h-14 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all",
            isVideoOff ? "bg-red-500/20 text-red-500 hover:bg-red-500/30" : "bg-white/10 text-white hover:bg-white/20"
          )}
        >
          {isVideoOff ? <VideoOff className="w-6 h-6 sm:w-5 sm:h-5" /> : <Video className="w-6 h-6 sm:w-5 sm:h-5" />}
        </button>

        <button
          onClick={() => leaveRoom(false)}
          className={cn(
            "w-14 h-14 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all shadow-lg ml-2 sm:ml-4 group relative",
            isHost ? "bg-red-600 hover:bg-red-500 text-white shadow-[0_0_15px_rgba(220,38,38,0.3)]" : "bg-white/10 text-white hover:bg-white/20"
          )}
        >
          <PhoneOff className="w-6 h-6 sm:w-5 sm:h-5" />
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-black text-[8px] uppercase font-mono rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">
            {isHost ? "Finalizar" : "Sair"}
          </span>
        </button>

        {isHost && (
          <button
            onClick={() => leaveRoom(true)}
            className="w-14 h-14 sm:w-12 sm:h-12 rounded-full bg-hw-muted/20 hover:bg-hw-muted/30 text-white flex items-center justify-center transition-all ml-2 group relative"
          >
            <span className="text-sm sm:text-xs font-bold uppercase">X</span>
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-black text-[8px] uppercase font-mono rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">Cancelar</span>
          </button>
        )}
      </div>
    </div>
  );
};

const RemoteVideo = ({ peer, isHost, onMute, onKick }: { peer: Peer, isHost?: boolean, onMute?: () => void, onKick?: () => void }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioLevel = useAudioLevel(peer.stream);
  const [, setForceUpdate] = useState({});

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !peer.stream) return;

    console.log(`VoxTranscribe Pro: Attaching stream to video for ${peer.id}. Tracks:`, peer.stream.getTracks().length);
    video.srcObject = peer.stream;
    
    // Ensure video plays
    video.onloadedmetadata = () => {
      video.play().catch(err => console.error("VoxTranscribe Pro: Error playing remote video:", err));
    };

    const handleTrackEvent = () => {
      console.log(`VoxTranscribe Pro: Track change for ${peer.id}`);
      if (video && peer.stream) {
        video.srcObject = peer.stream;
      }
      setForceUpdate({});
    };

    peer.stream.addEventListener('addtrack', handleTrackEvent);
    peer.stream.addEventListener('removetrack', handleTrackEvent);
    
    return () => {
      peer.stream.removeEventListener('addtrack', handleTrackEvent);
      peer.stream.removeEventListener('removetrack', handleTrackEvent);
    };
  }, [peer.stream, peer.id]);

  const hasVideo = peer.stream ? peer.stream.getVideoTracks().some(t => t.enabled) && !peer.isVideoOff : false;
  const hasAudio = peer.stream ? peer.stream.getAudioTracks().some(t => t.enabled) && !peer.isMuted : false;

  return (
    <div className={cn("relative bg-black/40 rounded-3xl border overflow-hidden group transition-all shadow-2xl aspect-video", audioLevel > 0.05 ? "border-hw-accent shadow-[0_0_30px_rgba(0,255,157,0.15)] ring-1 ring-hw-accent/50" : "border-white/10 ring-1 ring-white/5")}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={cn("w-full h-full object-contain bg-black/20 transition-opacity duration-500", !hasVideo && "opacity-0")}
      />
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-black/80 to-black/40 backdrop-blur-sm">
          <div className="w-16 h-16 sm:w-24 sm:h-24 rounded-full bg-white/5 flex items-center justify-center border border-white/10">
            <span className="text-2xl sm:text-3xl font-bold text-white/50">{peer.name.charAt(0).toUpperCase()}</span>
          </div>
        </div>
      )}

      {/* Moderation Overlay */}
      {isHost && (
        <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onMute}
            className="p-2 bg-black/60 hover:bg-red-500/20 text-white hover:text-red-500 rounded-xl border border-white/10 backdrop-blur-md transition-all"
            title="Silenciar Participante"
          >
            <MicOff className="w-4 h-4" />
          </button>
          <button
            onClick={onKick}
            className="p-2 bg-black/60 hover:bg-red-600 text-white rounded-xl border border-white/10 backdrop-blur-md transition-all"
            title="Expulsar Participante"
          >
            <UserMinus className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between">
        <div className="px-3 sm:px-4 py-1.5 sm:py-2 bg-black/60 backdrop-blur-xl rounded-xl text-xs sm:text-sm font-medium text-white border border-white/10 flex items-center gap-2 sm:gap-3 shadow-lg max-w-[90%]">
          <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-white/10 flex items-center justify-center border border-white/20 shrink-0">
            <span className="text-[8px] sm:text-[10px] font-bold text-white/70">{peer.name.charAt(0).toUpperCase()}</span>
          </div>
          <span className="truncate">{peer.name}</span>
          {!hasAudio ? (
            <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-red-500/20 flex items-center justify-center ml-1 shrink-0">
              <MicOff className="w-2.5 h-2.5 sm:w-3 h-3 text-red-500" />
            </div>
          ) : (
            <div className={cn("flex items-center gap-[2px] h-3 sm:h-4 ml-1 px-1.5 sm:px-2 rounded-full transition-all shrink-0", audioLevel > 0.05 ? "bg-hw-accent/20" : "bg-white/5")}>
              <div className="w-[2px] sm:w-[3px] bg-hw-accent rounded-full transition-all duration-75" style={{ height: `${Math.max(20, Math.min(100, audioLevel * 300))}%`, opacity: audioLevel > 0.05 ? 1 : 0.3 }} />
              <div className="w-[2px] sm:w-[3px] bg-hw-accent rounded-full transition-all duration-75" style={{ height: `${Math.max(20, Math.min(100, audioLevel * 400))}%`, opacity: audioLevel > 0.05 ? 1 : 0.3 }} />
              <div className="w-[2px] sm:w-[3px] bg-hw-accent rounded-full transition-all duration-75" style={{ height: `${Math.max(20, Math.min(100, audioLevel * 250))}%`, opacity: audioLevel > 0.05 ? 1 : 0.3 }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
