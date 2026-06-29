import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useHaptic } from '../../hooks/useHaptic';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
  swipeToDismiss?: boolean;
}

const SWIPE_DISMISS_THRESHOLD = 110;
const SWIPE_VELOCITY_THRESHOLD = 0.6;

export default function Modal({
  open, onClose, title, children, maxWidth = 'max-w-md', swipeToDismiss = true,
}: ModalProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ y: number; t: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [closing, setClosing] = useState(false);
  const haptic = useHaptic();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') handleClose(); }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleClose() {
    if (closing) return;
    haptic.tap();
    onClose();
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!swipeToDismiss) return;
    if (e.pointerType === 'mouse') return;
    dragStart.current = { y: e.clientY, t: performance.now() };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const dy = e.clientY - dragStart.current.y;
    setDragY(dy <= 0 ? 0 : dy);
  }
  function onPointerUp() {
    if (!dragStart.current) return;
    const dy = dragY;
    const dt = performance.now() - dragStart.current.t;
    const velocity = dt > 0 ? dy / dt : 0;
    dragStart.current = null;
    if (dy > SWIPE_DISMISS_THRESHOLD || velocity > SWIPE_VELOCITY_THRESHOLD) {
      setClosing(true);
      haptic.tap();
      setTimeout(() => { setClosing(false); setDragY(0); onClose(); }, 180);
    } else {
      setDragY(0);
    }
  }

  if (!open) return null;

  const isDragging = dragStart.current !== null;
  const sheetStyle: React.CSSProperties = {
    transform: closing
      ? 'translateY(100%)'
      : dragY > 0 ? `translateY(${dragY}px)` : undefined,
    transition: isDragging ? 'none' : 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        style={{ opacity: closing ? 0 : Math.max(0.4, 1 - dragY / 400) }}
        onClick={handleClose}
      />
      <div
        ref={sheetRef}
        style={sheetStyle}
        className={[
          'relative bg-iv-card border border-white/10',
          // Mobile: bottom-sheet (rounded top only). Desktop: full rounded card.
          'rounded-t-3xl sm:rounded-2xl',
          'shadow-[0_-8px_30px_rgba(0,0,0,0.5)] sm:shadow-2xl',
          // Mobile is full-width; on desktop the prop's max-width applies.
          'w-full', maxWidth,
          'max-h-[90dvh] sm:max-h-[85dvh] flex flex-col',
          isDragging ? '' : 'animate-in slide-in-from-bottom duration-300 sm:zoom-in-95',
        ].join(' ')}
      >
        <div
          className="sm:hidden flex items-center justify-center pt-2.5 pb-1 w-full cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="bottom-sheet-handle" />
        </div>

        <div
          className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-white/8 shrink-0"
          onPointerDown={(e) => { if (typeof window !== 'undefined' && window.innerWidth < 640) onPointerDown(e); }}
          onPointerMove={(e) => { if (typeof window !== 'undefined' && window.innerWidth < 640) onPointerMove(e); }}
          onPointerUp={() => { if (typeof window !== 'undefined' && window.innerWidth < 640) onPointerUp(); }}
        >
          <h3 id="modal-title" className="text-base font-semibold text-iv-text truncate pr-2">{title}</h3>
          <button
            onClick={handleClose}
            className="text-iv-muted hover:text-iv-text transition-colors flex items-center justify-center p-2 -mr-2 bg-white/5 hover:bg-white/10 rounded-full native-pressable"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5 safe-bottom">
          {children}
        </div>
      </div>
    </div>
  , document.body);
}