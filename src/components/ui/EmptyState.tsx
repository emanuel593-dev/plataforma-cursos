import React from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

export default function EmptyState({
  icon = <Inbox size={32} />,
  title = 'Nenhum resultado',
  description = 'Nenhum item encontrado.',
  action,
}: EmptyStateProps) {
  return (
    <div className="glass-panel p-6 sm:p-8 flex flex-col items-center justify-center text-center space-y-3">
      <div className="text-iv-muted/50 [&>svg]:w-8 [&>svg]:h-8 sm:[&>svg]:w-auto sm:[&>svg]:h-auto">{icon}</div>
      <h3 className="text-sm font-semibold text-iv-text">{title}</h3>
      <p className="text-xs text-iv-muted max-w-xs">{description}</p>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
