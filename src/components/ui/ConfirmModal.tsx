import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  variant?: 'danger' | 'warning';
}

export default function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirmar Exclusão', variant = 'danger' }: ConfirmModalProps) {
  const isDanger = variant === 'danger';

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className={`p-4 rounded-xl border ${isDanger ? 'border-red-500/20 bg-red-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
          <p className="text-sm text-iv-muted flex items-start gap-2">
            <AlertTriangle size={18} className={`${isDanger ? 'text-red-400' : 'text-amber-400'} shrink-0 mt-0.5`} />
            {message}
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="ghost" fullWidth onClick={onClose}>Cancelar</Button>
          <Button
            variant={isDanger ? 'danger' : 'primary'}
            fullWidth
            onClick={onConfirm}
            leftIcon={isDanger ? <Trash2 size={16} /> : undefined}
            haptic={isDanger ? 'error' : true}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
