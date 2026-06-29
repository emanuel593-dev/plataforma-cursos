import React from 'react';

interface StatusBadgeProps {
  label: string;
  colorClass: string; // e.g. "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
}

export default function StatusBadge({ label, colorClass }: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center text-[10px] sm:text-xs font-medium px-1.5 sm:px-2 py-0.5 rounded-full border whitespace-nowrap ${colorClass}`}>
      {label}
    </span>
  );
}
