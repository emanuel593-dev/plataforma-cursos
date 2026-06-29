import React, { forwardRef } from 'react';

// ── Shared input styles ──────────────────────────────────────────────────────
const INPUT_BASE =
  'w-full px-3 py-2.5 rounded-xl bg-iv-bg border text-iv-text placeholder:text-iv-muted/50 ' +
  'focus:outline-none focus:ring-1 transition-colors text-sm';

const STATE_OK    = 'border-white/10 focus:border-iv-accent/50 focus:ring-iv-accent/30';
const STATE_ERROR = 'border-red-500/40 focus:border-red-400/60 focus:ring-red-400/30';

// ── Field wrapper ────────────────────────────────────────────────────────────
interface FieldProps {
  label?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, hint, error, required, children, className = '' }: FieldProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && (
        <label className="text-sm text-iv-muted block">
          {label}
          {required && <span className="text-red-400 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-xs text-iv-muted/70">{hint}</p>
      ) : null}
    </div>
  );
}

// ── TextInput ────────────────────────────────────────────────────────────────
type TextInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid = false, className = '', ...props }, ref
) {
  return (
    <input
      ref={ref}
      className={`${INPUT_BASE} ${invalid ? STATE_ERROR : STATE_OK} ${className}`}
      {...props}
    />
  );
});

// ── Textarea ─────────────────────────────────────────────────────────────────
type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className = '', rows = 4, ...props }, ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`${INPUT_BASE} resize-y ${invalid ? STATE_ERROR : STATE_OK} ${className}`}
      {...props}
    />
  );
});

// ── Select ───────────────────────────────────────────────────────────────────
type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, className = '', children, ...props }, ref
) {
  return (
    <select
      ref={ref}
      className={`${INPUT_BASE} ${invalid ? STATE_ERROR : STATE_OK} ${className}`}
      {...props}
    >
      {children}
    </select>
  );
});
