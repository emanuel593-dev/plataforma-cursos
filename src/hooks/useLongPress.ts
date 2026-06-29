import { useCallback, useEffect, useRef } from 'react';

interface UseLongPressOptions {
  /** Duração em ms antes de disparar o callback. Default: 450ms. */
  delay?: number;
  /** Tolerância de movimento em px antes de cancelar. Default: 10. */
  movementTolerance?: number;
  /** Vibrar quando disparar (se a Vibration API estiver disponível). Default: true. */
  haptic?: boolean;
  /** Habilita long-press em touch. Default: true. */
  enableTouch?: boolean;
}

interface LongPressHandlers {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

/**
 * useLongPress — detecta press longo (≈450ms) com tolerância de movimento.
 * Retorna handlers para serem espalhados no elemento alvo.
 * Usa listeners PASSIVOS para não bloquear o scroll móvel.
 *
 * Exemplo:
 *   const handlers = useLongPress(() => openContextMenu());
 *   <div {...handlers}>...</div>
 */
export function useLongPress(
  callback: (e: React.PointerEvent) => void,
  { delay = 450, movementTolerance = 10, haptic = true, enableTouch = true }: UseLongPressOptions = {}
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const elementRef = useRef<HTMLElement | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  // Attach passive listeners on element to avoid blocking scroll
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (!enableTouch && e.pointerType === 'touch') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        if (haptic && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          try { navigator.vibrate(18); } catch { /* ignore */ }
        }
        // Convert PointerEvent to React.PointerEvent-like object
        callback(e as unknown as React.PointerEvent);
      }, delay);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!start.current) return;
      const dx = Math.abs(e.clientX - start.current.x);
      const dy = Math.abs(e.clientY - start.current.y);
      if (dx > movementTolerance || dy > movementTolerance) clear();
    };

    const handleClear = () => clear();

    // Attach with passive: true to not block scrolling
    el.addEventListener('pointerdown', handlePointerDown, { passive: true });
    el.addEventListener('pointermove', handlePointerMove, { passive: true });
    el.addEventListener('pointerup', handleClear, { passive: true });
    el.addEventListener('pointerleave', handleClear, { passive: true });
    el.addEventListener('pointercancel', handleClear, { passive: true });

    return () => {
      el.removeEventListener('pointerdown', handlePointerDown);
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', handleClear);
      el.removeEventListener('pointerleave', handleClear);
      el.removeEventListener('pointercancel', handleClear);
    };
  }, [clear, delay, enableTouch, haptic, callback, movementTolerance]);

  useEffect(() => () => clear(), [clear]);

  // Return a ref setter as a special property to attach listeners
  const withRef = (el: HTMLElement | null) => {
    elementRef.current = el;
  };

  return {
    ref: withRef,
    onPointerDown: () => {}, // Dummy handler, actual listeners are attached via ref
    onPointerMove: () => {},
    onPointerUp: () => {},
    onPointerLeave: () => {},
    onPointerCancel: () => {},
  };
}
