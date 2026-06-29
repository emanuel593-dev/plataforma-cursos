import type { UserRole, EnrollmentStatus, ClassStatus, LessonStatus, AttendanceStatus } from '../types';

// ── Role labels & colors ─────────────────────────────────────────────────────

export const ROLE_LABELS: Record<UserRole, string> = {
  coordenacao: 'Coordenação',
  professor: 'Professor(a)',
  aluno: 'Aluno(a)',
  monitor: 'Monitor(a)',
};

export const ROLE_COLORS: Record<UserRole, string> = {
  coordenacao: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  professor: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  aluno: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  monitor: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

// ── Module colors ────────────────────────────────────────────────────────────

export const MODULE_COLORS: Record<number, { primary: string; bg: string; text: string; border: string }> = {
  1: { primary: '#3b82f6', bg: 'bg-blue-500/15', text: 'text-blue-400', border: 'border-blue-500/30' },
  2: { primary: '#22c55e', bg: 'bg-green-500/15', text: 'text-green-400', border: 'border-green-500/30' },
  3: { primary: '#ef4444', bg: 'bg-red-500/15', text: 'text-red-400', border: 'border-red-500/30' },
};

// ── Status labels ────────────────────────────────────────────────────────────

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  active: 'Ativo',
  completed: 'Concluído',
  dropped: 'Desistente',
  graduated: 'Formado',
  failed: 'Reprovado',
};

export const CLASS_STATUS_LABELS: Record<ClassStatus, string> = {
  active: 'Ativa',
  completed: 'Concluída',
  cancelled: 'Cancelada',
};

export const LESSON_STATUS_LABELS: Record<LessonStatus, string> = {
  scheduled: 'Agendada',
  in_progress: 'Em andamento',
  completed: 'Concluída',
  cancelled: 'Cancelada',
};

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Presente',
  absent: 'Ausente',
  justified: 'Justificado',
};

export const ATTENDANCE_STATUS_COLORS: Record<AttendanceStatus, string> = {
  present: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  absent: 'bg-red-500/20 text-red-400 border-red-500/30',
  justified: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

export const LESSON_STATUS_COLORS: Record<LessonStatus, string> = {
  scheduled: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  in_progress: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  completed: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  cancelled: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};

export const CLASS_STATUS_COLORS: Record<ClassStatus, string> = {
  active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  completed: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  cancelled: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};
