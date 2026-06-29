import React, { useEffect, useRef, useState } from 'react';
import { Loader2, ArrowDown } from 'lucide-react';
import { useHaptic } from '../../hooks/useHaptic';

interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  children: React.ReactNode;
  /** Distância (px) para disparar o refresh. Default: 70. */
  threshold?: number;
  /** Distância máxima do indicador. Default: 110. */
  maxPull?: number;
  /** Desabilita em desktop. Default: true. */
  mobileOnly?: boolean;
}

/**
 * PullToRefresh — gesture nativo de "puxar para atualizar" para listas.
 * Usa pointer events PASSIVOS escopados ao container (não bloqueia scroll
 * mobile). Só dispara quando a página está no topo (scrollY === 0) e o
 * usuário arrasta para baixo.
 */
export default function PullToRefresh({
  onRefresh,
  children,
  threshold = 70,
  maxPull = 110,
  mobileOnly = true,
}: PullToRefreshProps) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const triggeredOnce = useRef(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const haptic = useHaptic();

  // Keep refs in sync so listeners (registered once) read latest values.
  refreshingRef.current = refreshing;
  pullRef.current = pull;

  // Stable refs for callbacks/options to avoid re-registering listeners.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const optsRef = useRef({ threshold, maxPull, mobileOnly });
  optsRef.current = { threshold, maxPull, mobileOnly };
  const hapticRef = useRef(haptic);
  hapticRef.current = haptic;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      const { mobileOnly } = optsRef.current;
      if (e.pointerType === 'mouse' && mobileOnly) return;
      if (window.scrollY > 4) { armed.current = false; return; }
      startY.current = e.clientY;
      armed.current = true;
      triggeredOnce.current = false;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!armed.current || startY.current === null || refreshingRef.current) return;
      const dy = e.clientY - startY.current;
      if (dy <= 0) {
        if (pullRef.current !== 0) setPull(0);
        return;
      }
      const { maxPull, threshold } = optsRef.current;
      const damped = Math.min(maxPull, dy * 0.55);
      setPull(damped);
      if (damped >= threshold && !triggeredOnce.current) {
        triggeredOnce.current = true;
        hapticRef.current.selection();
      }
    };

    const onPointerUp = async () => {
      if (!armed.current) return;
      armed.current = false;
      const { threshold } = optsRef.current;
      const shouldRefresh = pullRef.current >= threshold && !refreshingRef.current;
      if (shouldRefresh) {
        setRefreshing(true);
        hapticRef.current.success();
        try { await onRefreshRef.current(); } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
      startY.current = null;
    };

    // Scoped to container instead of window. ALL listeners are passive so the
    // browser can keep scroll smoothly handled (no two-finger requirement).
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('pointermove', onPointerMove, { passive: true });
    el.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('pointercancel', onPointerUp, { passive: true });
    el.addEventListener('pointerleave', onPointerUp, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('pointerleave', onPointerUp);
    };
  }, []); // Register once. State updates flow via refs.

  const indicatorTop = refreshing ? 16 : Math.max(-32, pull - 32);
  const opacity = refreshing ? 1 : Math.min(1, pull / threshold);
  const ready = pull >= threshold;

  return (
    <div ref={containerRef} className={`ptr-container ${mobileOnly ? 'lg:[--ptr-disabled:1]' : ''}`}>
      <div
        className="ptr-spinner"
        style={{ top: `${indicatorTop}px`, opacity }}
        aria-hidden={!refreshing}
      >
        {refreshing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <ArrowDown
            size={16}
            style={{
              transform: `rotate(${ready ? 180 : 0}deg)`,
              transition: 'transform 200ms ease-out',
            }}
          />
        )}
      </div>
      <div
        style={{
          transform: refreshing ? 'translateY(28px)' : `translateY(${pull * 0.5}px)`,
          transition: refreshing || pull === 0 ? 'transform 220ms cubic-bezier(0.2,0.8,0.2,1)' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
