import { useEffect, useRef, useState } from 'react';

const SPEAKING_THRESHOLD = 15;   // 0-255, lower = more sensitive
const SILENCE_DELAY_MS = 300;    // delay before marking as not speaking
const TICK_INTERVAL_MS = 100;    // ~10Hz analysis (vs ~60Hz of rAF) — saves CPU/battery
const AUDIO_LEVEL_DELTA = 4;     // skip setState when level barely changed

// ── Shared AudioContext ──────────────────────────────────────────────────────
// Chrome limits ~6 AudioContexts per tab. With one per peer this fails on
// 7+ participants. A single shared context is reused across all hook instances.

let sharedCtx: AudioContext | null = null;
let sharedCtxRefCount = 0;

function acquireAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext();
  }
  sharedCtxRefCount += 1;
  // Resume if browser suspended it (e.g. autoplay policy).
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume().catch(() => { /* noop */ });
  }
  return sharedCtx;
}

function releaseAudioContext() {
  sharedCtxRefCount = Math.max(0, sharedCtxRefCount - 1);
  if (sharedCtxRefCount === 0 && sharedCtx) {
    void sharedCtx.close().catch(() => { /* noop */ });
    sharedCtx = null;
  }
}

/**
 * Detects if a MediaStream has active audio (someone is speaking).
 * Returns { isSpeaking, audioLevel } where audioLevel is 0-100.
 */
export function useSpeakingDetection(stream: MediaStream | null) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const animRef = useRef<number>(0);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setIsSpeaking(false);
      setAudioLevel(0);
      return;
    }

    const audioCtx = acquireAudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastTickAt = 0;
    let lastLevelEmitted = -1;
    let lastSpeaking: boolean | null = null;

    function tick(now: number) {
      animRef.current = requestAnimationFrame(tick);
      // Skip if document hidden — saves CPU when tab in background.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // Throttle to ~10Hz instead of 60Hz.
      if (now - lastTickAt < TICK_INTERVAL_MS) return;
      lastTickAt = now;

      analyser.getByteFrequencyData(data);
      // Average of frequency bins
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const level = Math.min(100, Math.round((avg / 128) * 100));

      // Only re-render when level changed meaningfully.
      if (Math.abs(level - lastLevelEmitted) >= AUDIO_LEVEL_DELTA) {
        lastLevelEmitted = level;
        setAudioLevel(level);
      }

      if (avg > SPEAKING_THRESHOLD) {
        if (silenceTimer.current) {
          clearTimeout(silenceTimer.current);
          silenceTimer.current = null;
        }
        if (lastSpeaking !== true) {
          lastSpeaking = true;
          setIsSpeaking(true);
        }
      } else {
        if (!silenceTimer.current) {
          silenceTimer.current = setTimeout(() => {
            lastSpeaking = false;
            setIsSpeaking(false);
            silenceTimer.current = null;
          }, SILENCE_DELAY_MS);
        }
      }
    }

    animRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animRef.current);
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      try { source.disconnect(); } catch { /* noop */ }
      try { analyser.disconnect(); } catch { /* noop */ }
      releaseAudioContext();
    };
  }, [stream]);

  return { isSpeaking, audioLevel };
}
