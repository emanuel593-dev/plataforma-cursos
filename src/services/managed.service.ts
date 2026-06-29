import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import {
  getCurrentUserRole,
  listProfilesByRole,
} from './auth.service';
import type { Profile } from '../types';

// ── localStorage fallback helpers ────────────────────────────────────────────

const LS_PROFILES = 'iv_profiles';

function getStoredProfiles(): Record<string, Profile> {
  try { return JSON.parse(localStorage.getItem(LS_PROFILES) || '{}'); }
  catch { return {}; }
}

function saveStoredProfiles(p: Record<string, Profile>) {
  localStorage.setItem(LS_PROFILES, JSON.stringify(p));
}

// ── Permission guard ─────────────────────────────────────────────────────────

function assertCoordinator() {
  const role = getCurrentUserRole();
  if (role !== null && role !== 'coordenacao') {
    throw new Error('Apenas coordenação pode gerenciar perfis presenciais.');
  }
}

// ── List ────────────────────────────────────────────────────────────────────

/** Lista todos os alunos managed (presenciais sem login). */
export async function listManagedStudents(): Promise<Profile[]> {
  const all = await listProfilesByRole('aluno');
  return all.filter((p) => p.is_managed_only === true);
}

/** Lista todos os professores managed (presenciais sem login). */
export async function listManagedProfessors(): Promise<Profile[]> {
  const all = await listProfilesByRole('professor');
  return all.filter((p) => p.is_managed_only === true);
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateManagedInput {
  full_name: string;
  phone?: string | null;
}

/**
 * Cria um aluno presencial sem auth.users / sem login.
 * Usa RPC SECURITY DEFINER `create_managed_profile` (mig 035) para contornar
 * RLS e auditar a criação. No localStorage, insere direto.
 */
export async function createManagedStudent(input: CreateManagedInput): Promise<Profile> {
  return createManagedInternal({ ...input, role: 'aluno' });
}

/** Cria um professor presencial sem auth.users / sem login. */
export async function createManagedProfessor(input: CreateManagedInput): Promise<Profile> {
  return createManagedInternal({ ...input, role: 'professor' });
}

async function createManagedInternal(
  input: CreateManagedInput & { role: 'aluno' | 'professor' },
): Promise<Profile> {
  assertCoordinator();
  assertOnline();
  const fullName = input.full_name.trim();
  if (!fullName) throw new Error('Nome completo é obrigatório.');

  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('create_managed_profile', {
      p_full_name: fullName,
      p_role: input.role,
      p_phone: input.phone ?? null,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Falha ao criar perfil presencial.');
    return data as Profile;
  }

  // localStorage path
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const profile: Profile = {
    id,
    email: null,
    full_name: fullName,
    avatar_url: null,
    role: input.role,
    phone: input.phone?.trim() || null,
    must_change_password: false,
    is_managed_only: true,
    created_at: now,
    updated_at: now,
  };
  const profiles = getStoredProfiles();
  profiles[id] = profile;
  saveStoredProfiles(profiles);
  return profile;
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updateManagedProfile(
  uid: string,
  updates: { full_name?: string; phone?: string | null },
): Promise<Profile> {
  assertCoordinator();
  assertOnline();

  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('update_managed_profile', {
      p_id: uid,
      p_full_name: updates.full_name ?? null,
      p_phone: updates.phone ?? null,
    });
    if (error) throw new Error(error.message);
    return data as Profile;
  }

  const profiles = getStoredProfiles();
  const cur = profiles[uid];
  if (!cur) throw new Error('Perfil não encontrado.');
  if (!cur.is_managed_only) throw new Error('Use o fluxo de contas reais.');
  const next: Profile = {
    ...cur,
    full_name: updates.full_name?.trim() || cur.full_name,
    phone: updates.phone === undefined ? cur.phone : (updates.phone?.trim() || null),
    updated_at: new Date().toISOString(),
  };
  profiles[uid] = next;
  saveStoredProfiles(profiles);
  return next;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export async function deleteManagedProfile(uid: string): Promise<void> {
  assertCoordinator();
  assertOnline();

  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc('delete_managed_profile', {
      p_id: uid,
    });
    if (error) throw new Error(error.message);
    return;
  }

  const profiles = getStoredProfiles();
  if (profiles[uid] && !profiles[uid].is_managed_only) {
    throw new Error('Use o fluxo de contas reais.');
  }
  delete profiles[uid];
  saveStoredProfiles(profiles);
}

// ── Promote managed → real auth account ─────────────────────────────────────

/**
 * Promove um perfil managed para conta real (cria auth.users com mesmo UUID).
 * Chama a Netlify function `admin-promote-managed` que faz toda a validação
 * server-side. O trigger handle_new_user (mig 034) atualiza o profile via
 * ON CONFLICT, então não precisamos mexer em profiles aqui.
 */
export async function promoteManagedToReal(input: {
  profileId: string;
  email: string;
  sendInvite?: boolean;
}): Promise<{ id: string; email: string; inviteSent: boolean }> {
  assertCoordinator();
  assertOnline();
  if (!isSupabaseConfigured) {
    throw new Error('Promoção de managed requer Supabase configurado.');
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Sessão expirada — faça login novamente.');

  const res = await fetch('/.netlify/functions/admin-promote-managed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      profileId: input.profileId,
      email: input.email.trim().toLowerCase(),
      sendInvite: input.sendInvite ?? true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? 'Falha ao promover perfil.');
  }
  return body as { id: string; email: string; inviteSent: boolean };
}
