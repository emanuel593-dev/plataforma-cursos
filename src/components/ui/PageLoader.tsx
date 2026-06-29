import React from 'react';
import { Loader2 } from 'lucide-react';
import { Skeleton } from './Skeleton';

interface PageLoaderProps {
  /** 'spinner' (centro), 'list' (skeleton de lista), 'inline' (compacto). */
  variant?: 'spinner' | 'list' | 'inline';
  rows?: number;
  label?: string;
}

/** Loader unificado para estados de carregamento de página. */
export default function PageLoader({ variant = 'spinner', rows = 4, label }: PageLoaderProps) {
  if (variant === 'list') {
    return (
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="glass-panel p-4 flex items-center gap-3">
            <Skeleton variant="avatar" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="title" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <div className="inline-flex items-center gap-2 text-iv-muted text-sm" aria-busy="true">
        <Loader2 size={14} className="animate-spin" />
        {label && <span>{label}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3" aria-busy="true" aria-live="polite">
      <Loader2 size={28} className="animate-spin text-iv-accent" />
      {label && <p className="text-xs text-iv-muted">{label}</p>}
    </div>
  );
}
