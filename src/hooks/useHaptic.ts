/**
 * useHaptic — pequenas vibrações para dar feel "nativo" a ações.
 *
 * Funciona apenas em dispositivos com Vibration API (mobile Android, alguns iOS via PWA).
 * Em desktop é no-op silencioso. Respeita prefers-reduced-motion.
 */

export type HapticPattern = 'tap' | 'success' | 'warning' | 'error' | 'selection' | 'long';

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 8,
  selection: 5,
  success: [10, 30, 12],
  warning: [12, 40, 12, 40, 12],
  error: [22, 60, 22],
  long: 18,
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function vibrate(pattern: number | number[]): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return false;
  if (prefersReducedMotion()) return false;
  try {
    return nav.vibrate(pattern);
  } catch {
    return false;
  }
}

export function useHaptic() {
  return {
    /** Vibração curta — usar em taps de botão/CTA. */
    tap: () => vibrate(PATTERNS.tap),
    /** Padrão de sucesso — confirmações, salvar, etc. */
    success: () => vibrate(PATTERNS.success),
    /** Padrão de aviso — validação suave. */
    warning: () => vibrate(PATTERNS.warning),
    /** Padrão de erro — falhas. */
    error: () => vibrate(PATTERNS.error),
    /** Vibração mínima — selecionar item de lista. */
    selection: () => vibrate(PATTERNS.selection),
    /** Vibração mais longa — long-press. */
    long: () => vibrate(PATTERNS.long),
    /** Padrão customizado. */
    custom: (pattern: number | number[]) => vibrate(pattern),
  };
}
