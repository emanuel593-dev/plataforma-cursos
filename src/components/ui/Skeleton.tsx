import React from 'react';

interface SkeletonProps {
  className?: string;
  /** Predefinições para casos comuns. */
  variant?: 'text' | 'title' | 'avatar' | 'card' | 'block';
}

const VARIANTS: Record<NonNullable<SkeletonProps['variant']>, string> = {
  text:   'h-3 w-full rounded-md',
  title:  'h-5 w-2/3 rounded-md',
  avatar: 'h-10 w-10 rounded-full',
  card:   'h-24 w-full rounded-2xl',
  block:  'h-16 w-full rounded-xl',
};

/**
 * Skeleton — placeholder com efeito shimmer (definido em index.css `.skeleton`).
 * Substitui spinners centrais por placeholders que comunicam estrutura.
 */
export function Skeleton({ className = '', variant = 'text' }: SkeletonProps) {
  return <div className={`skeleton ${VARIANTS[variant]} ${className}`} />;
}

/** Bloco pré-pronto: lista vertical de N linhas. */
export function SkeletonList({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`}>
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
