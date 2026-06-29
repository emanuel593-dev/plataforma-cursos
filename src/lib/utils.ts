import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

export const BRAZIL_TIMEZONE = 'America/Sao_Paulo';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Translates raw Supabase / network error messages into friendly Portuguese strings.
 * Use this wherever you catch an error before displaying it to the user.
 */
export function friendlyError(err: unknown, fallback = 'Ocorreu um erro inesperado. Tente novamente.'): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();

  // Network
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed') || m.includes('load failed'))
    return 'Sem conexão com o servidor. Verifique sua internet e tente novamente.';

  // Auth
  if (m.includes('invalid login credentials') || m.includes('invalid credentials') || m.includes('user not found'))
    return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed'))
    return 'E-mail não confirmado. Verifique sua caixa de entrada.';
  if (m.includes('too many requests') || m.includes('rate limit'))
    return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  if (m.includes('user already registered') || m.includes('already been registered') || m.includes('já está cadastrado'))
    return 'Este e-mail já possui uma conta cadastrada.';
  if (m.includes('password should be at least'))
    return 'A senha deve ter no mínimo 6 caracteres.';
  if (m.includes('signup is disabled'))
    return 'Cadastro desativado. Entre em contato com a coordenação.';
  if (m.includes('session') || m.includes('sessão expirada') || m.includes('jwt expired'))
    return 'Sessão expirada. Faça login novamente.';

  // DB / RLS
  if (m.includes('duplicate key') || m.includes('unique constraint'))
    return 'Este registro já existe.';
  if (m.includes('row-level security') || m.includes('permission denied'))
    return 'Sem permissão para realizar esta operação.';
  if (m.includes('foreign key'))
    return 'Não é possível realizar esta operação pois há dados relacionados.';

  // Pass-through already-translated messages (pt-BR)
  if (msg.length > 0 && msg.length < 200 && !/[{}[\]"]/g.test(msg)) return msg;

  return fallback;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(d, BRAZIL_TIMEZONE, 'dd/MM/yyyy');
}

export function formatTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(d, BRAZIL_TIMEZONE, 'HH:mm');
}

export function formatDateTime(date: string | Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function toBrazilISO(dateYMD: string, timeHM: string): string {
  const zoned = fromZonedTime(`${dateYMD}T${timeHM}:00`, BRAZIL_TIMEZONE);
  return zoned.toISOString();
}

export function nowBrazilDateInputValue(): string {
  return formatInTimeZone(new Date(), BRAZIL_TIMEZONE, 'yyyy-MM-dd');
}

export function dateKeyInBrazil(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(d, BRAZIL_TIMEZONE, 'yyyy-MM-dd');
}

export function toBrazilTimeParts(date: string | Date): { date: string; time: string } {
  const d = typeof date === 'string' ? new Date(date) : date;
  const zoned = toZonedTime(d, BRAZIL_TIMEZONE);
  return {
    date: formatInTimeZone(zoned, BRAZIL_TIMEZONE, 'yyyy-MM-dd'),
    time: formatInTimeZone(zoned, BRAZIL_TIMEZONE, 'HH:mm'),
  };
}
