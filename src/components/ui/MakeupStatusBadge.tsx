import type { MakeupSubmissionStatus } from '../../types';

interface Props {
  status: MakeupSubmissionStatus;
  /** When true and status is 'pending', shows "Aguardando resumo" instead of
   *  "Pendente" — communicates that the student watched but hasn't written
   *  the summary yet. */
  watched?: boolean;
  /** Visual size: compact pill (badge) vs full status pill with border. */
  variant?: 'pill' | 'soft';
}

const labelFor = (status: MakeupSubmissionStatus, watched?: boolean): string => {
  switch (status) {
    case 'approved':  return 'Aprovado';
    case 'rejected':  return 'Reprovado';
    case 'submitted': return 'Aguardando revisão';
    case 'pending':   return watched ? 'Aguardando resumo' : 'Pendente';
    default:          return 'Desconhecido';
  }
};

const softClass: Record<MakeupSubmissionStatus, string> = {
  pending:   'bg-amber-500/15 text-amber-400',
  submitted: 'bg-blue-500/15 text-blue-400',
  approved:  'bg-emerald-500/15 text-emerald-400',
  rejected:  'bg-red-500/15 text-red-400',
};

const pillClass: Record<MakeupSubmissionStatus, string> = {
  pending:   'bg-iv-muted/10 text-iv-muted border-white/10',
  submitted: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  approved:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  rejected:  'bg-red-500/15 text-red-400 border-red-500/25',
};

/**
 * Single source of truth for makeup-submission status visuals. Keeps colours,
 * labels and watched-vs-pending wording consistent between ClassDetailView
 * (student perspective) and ReportsView (coordenação perspective).
 */
export default function MakeupStatusBadge({ status, watched, variant = 'soft' }: Props) {
  const label = labelFor(status, watched);
  if (variant === 'pill') {
    return (
      <span className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border ${pillClass[status]}`}>
        {label}
      </span>
    );
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${softClass[status]}`}>
      {label}
    </span>
  );
}
