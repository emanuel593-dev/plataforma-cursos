// Per-device audio capture preferences for WebRTC.
//
// These are scoped to localStorage (per browser/device) because they reflect
// hardware/environment characteristics — a USB mic on the desktop and the
// built-in mic on a phone usually want different settings.
//
// Defaults (auditoria §3.5 #1):
//   - autoGainControl: FALSE  → AGC was the most likely cause of the
//     "audio gradually fades" report (H1). Sala silenciosa + voz pausada
//     fazem o AGC abaixar o ganho de captura progressivamente.
//   - echoCancellation / noiseSuppression: TRUE  → mantém comportamento
//     anterior, evita feedback em fones.

export interface AudioPrefs {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

const STORAGE_KEY = 'iv:audio:prefs';

const DEFAULTS: AudioPrefs = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};

export function getAudioPrefs(): AudioPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      echoCancellation: parsed.echoCancellation ?? DEFAULTS.echoCancellation,
      noiseSuppression: parsed.noiseSuppression ?? DEFAULTS.noiseSuppression,
      autoGainControl: parsed.autoGainControl ?? DEFAULTS.autoGainControl,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setAudioPrefs(prefs: Partial<AudioPrefs>): AudioPrefs {
  const next = { ...getAudioPrefs(), ...prefs };
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
  }
  return next;
}
