import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useHaptic } from '../../hooks/useHaptic';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
  /** Disparar vibração ao clicar (mobile). Default: true. */
  haptic?: boolean | 'success' | 'error';
  children?: React.ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:   'bg-iv-accent hover:bg-iv-accent-hover text-white shadow-sm shadow-iv-accent/30',
  secondary: 'bg-white/5 hover:bg-white/10 text-iv-text border border-white/10',
  ghost:     'bg-transparent hover:bg-white/5 text-iv-muted hover:text-iv-text',
  danger:    'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30',
  success:   'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30',
};

const SIZE_CLASSES: Record<Size, string> = {
  sm:   'h-9 px-3 text-xs gap-1.5 rounded-lg',
  md:   'h-11 px-4 text-sm gap-2 rounded-xl',
  lg:   'h-12 px-5 text-sm gap-2 rounded-xl',
  icon: 'h-11 w-11 rounded-xl',
};

/**
 * Button — primitivo unificado para todas as ações da UI.
 * Inclui haptic feedback automático no mobile, loading state, ícones e
 * variantes consistentes. Use ao invés de espalhar classes Tailwind nas views.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    haptic = true,
    className = '',
    children,
    onClick,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  const h = useHaptic();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (haptic === true) h.tap();
    else if (haptic === 'success') h.success();
    else if (haptic === 'error') h.error();
    onClick?.(e);
  };

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      onClick={handleClick}
      className={[
        'inline-flex items-center justify-center font-medium',
        'native-pressable',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iv-accent/50 focus-visible:ring-offset-0',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? (
        <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

export default Button;
