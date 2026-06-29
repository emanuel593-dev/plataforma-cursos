import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { Profile, ProfileUpdate } from '../types';

// ── localStorage keys ────────────────────────────────────────────────────────

const LS_AUTH_USER = 'iv_auth_user';
const LS_AUTH_USERS = 'iv_auth_users_db';
const LS_PROFILES = 'iv_profiles';
const LS_MUST_CHANGE = 'iv_must_change_password';

// ── Auth user type (minimal, works for both Supabase and localStorage) ───────

export interface AuthUser {
  id: string;
  email: string;
}

type AuthCallback = (user: AuthUser | null) => void;

// ── djb2 hash (dev-only, NOT production-safe) ───────────────────────────────
// Guard: prevent this code-path from running in a production build.
if (import.meta.env.PROD && !isSupabaseConfigured) {
  throw new Error(
    '[IV] localStorage auth mode is not allowed in production. Configure Supabase.'
  );
}

function hashPassword(password: string): string {
  let h = 5381;
  for (let i = 0; i < password.length; i++) {
    h = Math.imul(h, 33) ^ password.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

// ── localStorage user store ──────────────────────────────────────────────────

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  full_name: string;
}

function getStoredUsers(): Record<string, StoredUser> {
  try {
    return JSON.parse(localStorage.getItem(LS_AUTH_USERS) || '{}');
  } catch {
    return {};
  }
}

function saveStoredUsers(users: Record<string, StoredUser>) {
  localStorage.setItem(LS_AUTH_USERS, JSON.stringify(users));
}

function getStoredProfiles(): Record<string, Profile> {
  try {
    return JSON.parse(localStorage.getItem(LS_PROFILES) || '{}');
  } catch {
    return {};
  }
}

function saveStoredProfiles(profiles: Record<string, Profile>) {
  localStorage.setItem(LS_PROFILES, JSON.stringify(profiles));
}

// ── Listeners ────────────────────────────────────────────────────────────────

const listeners = new Set<AuthCallback>();

function notifyListeners(user: AuthUser | null) {
  listeners.forEach((cb) => cb(user));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function signUp(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthUser> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Erro ao criar conta.');
    if (!data.user.email) throw new Error('E-mail não disponível na conta criada.');
    const user: AuthUser = { id: data.user.id, email: data.user.email };
    return user;
  }

  // localStorage fallback
  const normalizedEmail = email.toLowerCase().trim();
  if (password.length < 6) throw new Error('A senha deve ter no mínimo 6 caracteres.');
  const users = getStoredUsers();
  if (users[normalizedEmail]) throw new Error('Este e-mail já está cadastrado.');

  const id = crypto.randomUUID();
  users[normalizedEmail] = {
    id,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    full_name: fullName,
  };
  saveStoredUsers(users);

  // Create profile (mirrors the DB trigger)
  const profiles = getStoredProfiles();
  const isFirstUser = Object.keys(profiles).length === 0;
  const now = new Date().toISOString();
  profiles[id] = {
    id,
    email: normalizedEmail,
    full_name: fullName,
    avatar_url: null,
    role: isFirstUser ? 'coordenacao' : 'aluno',
    phone: null,
    must_change_password: false,
    is_managed_only: false,
    created_at: now,
    updated_at: now,
  };
  saveStoredProfiles(profiles);

  const authUser: AuthUser = { id, email: normalizedEmail };
  localStorage.setItem(LS_AUTH_USER, JSON.stringify(authUser));
  notifyListeners(authUser);
  return authUser;
}

function translateAuthError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid credentials'))
    return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed'))
    return 'E-mail não confirmado. Verifique sua caixa de entrada.';
  if (m.includes('too many requests') || m.includes('rate limit'))
    return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  if (m.includes('user not found'))
    return 'E-mail ou senha incorretos.';
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed') || m.includes('load failed'))
    return 'Sem conexão com o servidor. Verifique sua internet e tente novamente.';
  if (m.includes('user already registered') || m.includes('already been registered'))
    return 'Este e-mail já está cadastrado.';
  if (m.includes('password should be at least'))
    return 'A senha deve ter no mínimo 6 caracteres.';
  if (m.includes('signup is disabled'))
    return 'Cadastro desativado. Entre em contato com a coordenação.';
  return msg;
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(translateAuthError(error.message));
      if (!data.user.email) throw new Error('E-mail não disponível nesta conta.');
      const user: AuthUser = { id: data.user.id, email: data.user.email };
      return user;
    } catch (err) {
      if (err instanceof Error) throw new Error(translateAuthError(err.message));
      throw err;
    }
  }

  // localStorage fallback
  const normalizedEmail = email.toLowerCase().trim();
  const users = getStoredUsers();
  const stored = users[normalizedEmail];
  // Use a single generic message to prevent user enumeration
  if (!stored || stored.passwordHash !== hashPassword(password)) {
    throw new Error('E-mail ou senha incorretos.');
  }

  const authUser: AuthUser = { id: stored.id, email: stored.email };
  localStorage.setItem(LS_AUTH_USER, JSON.stringify(authUser));
  notifyListeners(authUser);
  return authUser;
}

export async function signOut(): Promise<void> {
  if (isSupabaseConfigured) {
    const { error } = await supabase.auth.signOut();
    if (error) {
      // Log but proceed — local session must always be cleared
      console.warn('[IV] signOut remote error:', error.message);
    }
  }
  localStorage.removeItem(LS_AUTH_USER);
  notifyListeners(null);
}

export function getCurrentUser(): AuthUser | null {
  if (isSupabaseConfigured) {
    // Synchronously read the cached user set by onAuthStateChanged listeners.
    // supabase.auth.getSession() is async so we rely on the LS_AUTH_USER
    // cache that is written by onAuthStateChanged whenever the session changes.
    try {
      const cached = localStorage.getItem(LS_AUTH_USER);
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  }
  try {
    const stored = localStorage.getItem(LS_AUTH_USER);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the current user's role synchronously from localStorage.
 * Returns null in Supabase mode (RLS enforces permissions there).
 */
export function getCurrentUserRole(): string | null {
  const user = getCurrentUser();
  if (!user) return null;
  if (isSupabaseConfigured) return null;
  const profiles = getStoredProfiles();
  return profiles[user.id]?.role ?? null;
}

export function onAuthStateChanged(callback: AuthCallback): () => void {
  listeners.add(callback);

  if (isSupabaseConfigured) {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const supaUser = session?.user ?? null;
      const user: AuthUser | null = supaUser?.email
        ? { id: supaUser.id, email: supaUser.email }
        : null;
      if (user) localStorage.setItem(LS_AUTH_USER, JSON.stringify(user));
      else localStorage.removeItem(LS_AUTH_USER);
      callback(user);
    });
    // Fire initial state
    supabase.auth.getSession().then(({ data: { session } }) => {
      const supaUser = session?.user ?? null;
      const user: AuthUser | null = supaUser?.email
        ? { id: supaUser.id, email: supaUser.email }
        : null;
      callback(user);
    });
    return () => {
      listeners.delete(callback);
      subscription.unsubscribe();
    };
  }

  // localStorage: fire immediately
  setTimeout(() => callback(getCurrentUser()), 0);
  return () => { listeners.delete(callback); };
}

// ── Profile helpers (used by useProfile and other services) ──────────────────

export async function getProfile(uid: string): Promise<Profile | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', uid)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  const profiles = getStoredProfiles();
  return profiles[uid] || null;
}

export async function updateProfile(uid: string, updates: ProfileUpdate): Promise<void> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase
      .from('profiles') as any)
      .update(updates)
      .eq('id', uid);
    if (error) throw new Error(error.message);
    return;
  }
  const profiles = getStoredProfiles();
  if (!profiles[uid]) throw new Error('Perfil não encontrado.');
  profiles[uid] = { ...profiles[uid], ...updates, updated_at: new Date().toISOString() };
  saveStoredProfiles(profiles);
}

export async function listProfiles(): Promise<Profile[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('full_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return Object.values(getStoredProfiles()).sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  );
}

export async function listProfilesByRole(role: Profile['role']): Promise<Profile[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', role)
      .order('full_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return Object.values(getStoredProfiles())
    .filter((p) => p.role === role)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

// ── Must-change-password ─────────────────────────────────────────────────────

function getMustChangeMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(LS_MUST_CHANGE) || '{}');
  } catch {
    return {};
  }
}

export async function checkMustChangePassword(uid: string): Promise<boolean> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('profiles')
      .select('must_change_password')
      .eq('id', uid)
      .single();
    // On error, default to true (safe: forces password flow rather than bypassing it)
    if (error) return true;
    return (data as { must_change_password: boolean } | null)?.must_change_password === true;
  }
  return getMustChangeMap()[uid] === true;
}

export async function setMustChangePassword(uid: string): Promise<void> {
  if (isSupabaseConfigured) {
    const { error } = await (supabase
      .from('profiles') as any)
      .update({ must_change_password: true })
      .eq('id', uid);
    if (error) throw new Error(`Erro ao definir troca de senha: ${error.message}`);
    return;
  }
  const map = getMustChangeMap();
  map[uid] = true;
  localStorage.setItem(LS_MUST_CHANGE, JSON.stringify(map));
}

export async function clearMustChangePassword(uid: string): Promise<void> {
  if (isSupabaseConfigured) {
    const { error } = await (supabase
      .from('profiles') as any)
      .update({ must_change_password: false })
      .eq('id', uid);
    if (error) throw new Error(`Erro ao limpar troca de senha: ${error.message}`);
    return;
  }
  const map = getMustChangeMap();
  delete map[uid];
  localStorage.setItem(LS_MUST_CHANGE, JSON.stringify(map));
}

export async function changePassword(uid: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new Error('A senha deve ter no mínimo 8 caracteres.');
  if (isSupabaseConfigured) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
    await clearMustChangePassword(uid);
    return;
  }
  const profiles = getStoredProfiles();
  const profile = profiles[uid];
  if (!profile) throw new Error('Utilizador não encontrado.');
  const users = getStoredUsers();
  const storedUser = Object.values(users).find((u) => u.id === uid);
  if (!storedUser) throw new Error('Utilizador não encontrado.');
  users[storedUser.email] = { ...storedUser, passwordHash: hashPassword(newPassword) };
  saveStoredUsers(users);
  await clearMustChangePassword(uid);
}

// ── Create professor account (called by coordinator) ─────────────────────────

// ── Admin API helper (calls server.ts admin endpoints) ───────────────────────

async function adminFetch(path: string, method: string, body?: unknown): Promise<Response> {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  if (!token) throw new Error('Sessão expirada. Faça login novamente.');

  // CSRF protection: only POST to same-origin endpoints.
  // The path must be a relative URL (starts with '/api/'); we never pass
  // absolute cross-origin URLs here.
  if (!path.startsWith('/api/')) {
    throw new Error('adminFetch: caminho inválido — só são permitidos endpoints /api/.');
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Erro ${res.status}`);
  }

  return res;
}

export async function createProfessorAccount(
  email: string,
  fullName: string,
  password: string,
): Promise<AuthUser> {
  if (isSupabaseConfigured) {
    const res = await adminFetch('/api/admin/create-user', 'POST', {
      email: email.trim(),
      fullName: fullName.trim(),
      password,
      role: 'professor',
    });
    const data = await res.json() as { id: string; email: string };
    await setMustChangePassword(data.id);
    return { id: data.id, email: data.email };
  }

  // localStorage fallback
  const normalizedEmail = email.toLowerCase().trim();
  const users = getStoredUsers();
  if (users[normalizedEmail]) throw new Error('Este e-mail já está cadastrado.');

  const id = crypto.randomUUID();
  users[normalizedEmail] = {
    id,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    full_name: fullName,
  };
  saveStoredUsers(users);

  const profiles = getStoredProfiles();
  const now = new Date().toISOString();
  profiles[id] = {
    id,
    email: normalizedEmail,
    full_name: fullName,
    avatar_url: null,
    role: 'professor',
    phone: null,
    must_change_password: false,
    is_managed_only: false,
    created_at: now,
    updated_at: now,
  };
  saveStoredProfiles(profiles);

  await setMustChangePassword(id);

  return { id, email: normalizedEmail };
}

export async function createMonitorAccount(
  email: string,
  fullName: string,
  password: string,
): Promise<AuthUser> {
  if (isSupabaseConfigured) {
    const res = await adminFetch('/api/admin/create-user', 'POST', {
      email: email.trim(),
      fullName: fullName.trim(),
      password,
      role: 'monitor',
    });
    const data = await res.json() as { id: string; email: string };
    await setMustChangePassword(data.id);
    return { id: data.id, email: data.email };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const users = getStoredUsers();
  if (users[normalizedEmail]) throw new Error('Este e-mail já está cadastrado.');

  const id = crypto.randomUUID();
  users[normalizedEmail] = {
    id,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    full_name: fullName,
  };
  saveStoredUsers(users);

  const profiles = getStoredProfiles();
  const now = new Date().toISOString();
  profiles[id] = {
    id,
    email: normalizedEmail,
    full_name: fullName,
    avatar_url: null,
    role: 'monitor',
    phone: null,
    must_change_password: false,
    is_managed_only: false,
    created_at: now,
    updated_at: now,
  };
  saveStoredProfiles(profiles);

  await setMustChangePassword(id);

  return { id, email: normalizedEmail };
}

export async function createStudentAccount(
  email: string,
  fullName: string,
  password: string,
): Promise<AuthUser> {
  if (isSupabaseConfigured) {
    const res = await adminFetch('/api/admin/create-user', 'POST', {
      email: email.trim(),
      fullName: fullName.trim(),
      password,
      role: 'aluno',
    });
    const data = await res.json() as { id: string; email: string };
    await setMustChangePassword(data.id);
    return { id: data.id, email: data.email };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const users = getStoredUsers();
  if (users[normalizedEmail]) throw new Error('Este e-mail já está cadastrado.');

  const id = crypto.randomUUID();
  users[normalizedEmail] = {
    id,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    full_name: fullName,
  };
  saveStoredUsers(users);

  const profiles = getStoredProfiles();
  const now = new Date().toISOString();
  profiles[id] = {
    id,
    email: normalizedEmail,
    full_name: fullName,
    avatar_url: null,
    role: 'aluno',
    phone: null,
    must_change_password: false,
    is_managed_only: false,
    created_at: now,
    updated_at: now,
  };
  saveStoredProfiles(profiles);

  await setMustChangePassword(id);

  return { id, email: normalizedEmail };
}

export async function updateManagedAccount(
  uid: string,
  updates: { full_name?: string; email?: string },
): Promise<void> {
  if (isSupabaseConfigured) {
    // Update profile table (name always; email as display field)
    const profileUpdates: ProfileUpdate = {};
    if (updates.full_name) profileUpdates.full_name = updates.full_name.trim();
    if (updates.email) profileUpdates.email = updates.email.toLowerCase().trim();
    if (Object.keys(profileUpdates).length > 0) {
      await updateProfile(uid, profileUpdates);
    }
    // Also update login email in auth.users via admin endpoint
    if (updates.email) {
      await adminFetch(`/api/admin/users/${uid}`, 'PATCH', {
        email: updates.email.toLowerCase().trim(),
      });
    }
    return;
  }

  const profiles = getStoredProfiles();
  const profile = profiles[uid];
  if (!profile) throw new Error('Perfil não encontrado.');

  const users = getStoredUsers();
  const currentUser = Object.values(users).find((u) => u.id === uid);
  if (!currentUser) throw new Error('Usuário não encontrado.');

  const nextName = updates.full_name?.trim() || profile.full_name;
  // profile.email é nullable a partir da mig 034 (managed). updateManagedAccount
  // só opera em contas reais (com auth.users), então email sempre estará presente.
  const nextEmail = updates.email?.toLowerCase().trim() || profile.email;
  if (!nextEmail) throw new Error('E-mail é obrigatório para contas reais.');

  if (nextEmail !== currentUser.email && users[nextEmail]) {
    throw new Error('Este e-mail já está cadastrado.');
  }

  if (nextEmail !== currentUser.email) {
    delete users[currentUser.email];
  }
  users[nextEmail] = {
    ...currentUser,
    email: nextEmail,
    full_name: nextName,
  };
  saveStoredUsers(users);

  profiles[uid] = {
    ...profile,
    email: nextEmail,
    full_name: nextName,
    updated_at: new Date().toISOString(),
  };
  saveStoredProfiles(profiles);

  const currentAuth = getCurrentUser();
  if (currentAuth?.id === uid) {
    localStorage.setItem(LS_AUTH_USER, JSON.stringify({ id: uid, email: nextEmail }));
    notifyListeners({ id: uid, email: nextEmail });
  }
}

export async function deleteManagedAccount(uid: string): Promise<void> {
  if (isSupabaseConfigured) {
    await adminFetch(`/api/admin/users/${uid}`, 'DELETE');
    return;
  }

  const users = getStoredUsers();
  const found = Object.entries(users).find(([, u]) => u.id === uid);
  if (found) {
    delete users[found[0]];
    saveStoredUsers(users);
  }

  const profiles = getStoredProfiles();
  if (profiles[uid]) {
    delete profiles[uid];
    saveStoredProfiles(profiles);
  }

  await clearMustChangePassword(uid);

  const currentAuth = getCurrentUser();
  if (currentAuth?.id === uid) {
    await signOut();
  }
}
