import React from 'react';
import { useHaptic } from '../../hooks/useHaptic';

interface FABProps {
  icon: React.ReactNode;
  onClick: () => void;
  label?: string;
  /** Esconder em desktop (lg+). Default: true — FAB é primariamente mobile. */
  mobileOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * FAB — Floating Action Button (padrão Material/iOS para CTA primária no mobile).
 * Posicionado acima da bottom nav, respeitando safe-area-inset.
 */
export default function FAB({
  icon, onClick, label, mobileOnly = true, className = '', ariaLabel,
}: FABProps) {
  const haptic = useHaptic();
  const handleClick = () => {
    haptic.tap();
    onClick();
  };

  return (
    <button
      onClick={handleClick}
      aria-label={ariaLabel ?? label ?? 'Ação principal'}
      className={[
        'fab native-pressable',
        'bg-iv-accent hover:bg-iv-accent-hover text-white',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iv-accent/60',
        mobileOnly ? 'lg:hidden' : '',
        label ? 'w-auto h-14 px-5 gap-2 text-sm font-semibold' : '',
        className,
      ].join(' ')}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}
