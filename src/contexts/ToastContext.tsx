import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={16} />,
  error:   <XCircle size={16} />,
  warning: <AlertTriangle size={16} />,
  info:    <Info size={16} />,
};

const COLORS: Record<ToastType, string> = {
  success: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  error:   'bg-red-500/15 border-red-500/30 text-red-300',
  warning: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  info:    'bg-blue-500/15 border-blue-500/30 text-blue-300',
};

const HAPTIC: Record<ToastType, number | number[]> = {
  success: [10, 30, 12],
  error:   [22, 60, 22],
  warning: [12, 40, 12],
  info:    8,
};

const AUTO_DISMISS_MS = 4500;

function vibrate(pattern: number | number[]) {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  try { nav.vibrate?.(pattern); } catch { /* ignore */ }
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    vibrate(HAPTIC[type]);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, timer);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Always-mounted ARIA live regions so SR announces new toasts the moment
          they appear (mounting + announcement in the same tick is unreliable).
          Errors are 'assertive' to interrupt; everything else is 'polite'. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="false">
        {toasts.filter((t) => t.type !== 'error').map((t) => (
          <span key={t.id}>{t.message}</span>
        ))}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="false">
        {toasts.filter((t) => t.type === 'error').map((t) => (
          <span key={t.id}>{t.message}</span>
        ))}
      </div>
      {toasts.length > 0 && (
        <div
          className={[
            'fixed z-[9999] pointer-events-none flex flex-col gap-2',
            // Mobile: above bottom-nav (h-16 = 4rem). Nav already includes
            // safe-area-inset-bottom, so we don't re-add it here.
            'left-3 right-3 bottom-[4.75rem]',
            // Desktop: bottom-right.
            'sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-sm sm:w-full',
          ].join(' ')}
          aria-hidden="true"
        >
          {toasts.map((t) => (
            <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const startX = useRef<number | null>(null);
  const [dx, setDx] = useState(0);
  const [closing, setClosing] = useState(false);

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse') return;
    startX.current = e.clientX;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (startX.current === null) return;
    setDx(e.clientX - startX.current);
  }
  function onPointerUp() {
    if (startX.current === null) return;
    startX.current = null;
    if (Math.abs(dx) > 80) {
      setClosing(true);
      setTimeout(onDismiss, 160);
    } else {
      setDx(0);
    }
  }

  const style: React.CSSProperties = {
    transform: closing
      ? `translateX(${dx >= 0 ? 400 : -400}px)`
      : dx !== 0 ? `translateX(${dx}px)` : undefined,
    opacity: closing ? 0 : Math.max(0.3, 1 - Math.abs(dx) / 200),
    transition: startX.current ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out',
  };

  return (
    <div
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`flex items-start gap-3 px-4 py-3 rounded-2xl border backdrop-blur-md shadow-2xl pointer-events-auto ${COLORS[item.type]} animate-in slide-in-from-bottom-4 fade-in duration-300`}
    >
      <span className="mt-0.5 shrink-0">{ICONS[item.type]}</span>
      <p className="text-sm flex-1 leading-snug">{item.message}</p>
      <button
        onClick={onDismiss}
        className="opacity-60 hover:opacity-100 transition-opacity shrink-0 mt-0.5 p-1 -m-1 rounded-md"
        aria-label="Fechar notificação"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}