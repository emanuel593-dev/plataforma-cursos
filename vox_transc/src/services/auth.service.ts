/**
 * Authentication service abstraction.
 * Current implementation: localStorage-backed stub for development.
 * TODO: Replace LocalAuthService with SupabaseAuthService when integrating Supabase.
 *
 * SECURITY NOTE: The stub password hashing is NOT cryptographically secure.
 * It exists only for local development and will be replaced by Supabase Auth.
 */

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

type AuthCallback = (user: AuthUser | null) => void;

export interface IAuthService {
  getCurrentUser(): AuthUser | null;
  onAuthStateChanged(callback: AuthCallback): () => void;
  signInWithEmail(email: string, password: string): Promise<AuthUser>;
  signUpWithEmail(email: string, password: string): Promise<AuthUser>;
  signInWithGoogle(): Promise<AuthUser>;
  signOut(): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Stub implementation — backed by localStorage
// ──────────────────────────────────────────────────────────────────────────────

const KEY_CURRENT_USER = 'vox_auth_user';
const KEY_REGISTERED_USERS = 'vox_auth_users';

type StoredUserRecord = {
  uid: string;
  passwordHash: string;
  displayName: string;
};

class LocalAuthService implements IAuthService {
  private currentUser: AuthUser | null = null;
  private readonly listeners = new Set<AuthCallback>();

  constructor() {
    const raw = localStorage.getItem(KEY_CURRENT_USER);
    if (raw) {
      try { this.currentUser = JSON.parse(raw); } catch { /* ignore */ }
    }
  }

  private notify(): void {
    this.listeners.forEach(cb => cb(this.currentUser));
  }

  private persist(): void {
    if (this.currentUser) {
      localStorage.setItem(KEY_CURRENT_USER, JSON.stringify(this.currentUser));
    } else {
      localStorage.removeItem(KEY_CURRENT_USER);
    }
  }

  private readUsers(): Record<string, StoredUserRecord> {
    try {
      return JSON.parse(localStorage.getItem(KEY_REGISTERED_USERS) || '{}');
    } catch { return {}; }
  }

  private writeUsers(users: Record<string, StoredUserRecord>): void {
    localStorage.setItem(KEY_REGISTERED_USERS, JSON.stringify(users));
  }

  /** djb2 hash — dev only, NOT for production */
  private hashPassword(password: string): string {
    let h = 5381;
    for (let i = 0; i < password.length; i++) {
      h = Math.imul(h, 33) ^ password.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  onAuthStateChanged(callback: AuthCallback): () => void {
    this.listeners.add(callback);
    // Fire immediately (async to match real provider behaviour)
    setTimeout(() => callback(this.currentUser), 0);
    return () => this.listeners.delete(callback);
  }

  async signInWithEmail(email: string, password: string): Promise<AuthUser> {
    const users = this.readUsers();
    const key = email.toLowerCase().trim();
    const record = users[key];
    if (!record || record.passwordHash !== this.hashPassword(password)) {
      const err = new Error('E-mail ou senha incorretos.');
      Object.assign(err, { code: 'auth/invalid-credential' });
      throw err;
    }
    this.currentUser = { uid: record.uid, email: key, displayName: record.displayName, photoURL: null };
    this.persist();
    this.notify();
    return this.currentUser;
  }

  async signUpWithEmail(email: string, password: string): Promise<AuthUser> {
    const users = this.readUsers();
    const key = email.toLowerCase().trim();
    if (users[key]) {
      const err = new Error('Este e-mail já está em uso.');
      Object.assign(err, { code: 'auth/email-already-in-use' });
      throw err;
    }
    if (password.length < 6) {
      const err = new Error('A senha deve ter pelo menos 6 caracteres.');
      Object.assign(err, { code: 'auth/weak-password' });
      throw err;
    }
    const uid = crypto.randomUUID();
    const displayName = key.split('@')[0];
    users[key] = { uid, passwordHash: this.hashPassword(password), displayName };
    this.writeUsers(users);
    this.currentUser = { uid, email: key, displayName, photoURL: null };
    this.persist();
    this.notify();
    return this.currentUser;
  }

  async signInWithGoogle(): Promise<AuthUser> {
    // TODO: Implement via Supabase OAuth provider
    throw new Error(
      'Login com Google será disponibilizado após a integração com Supabase. Use e-mail e senha por enquanto.'
    );
  }

  async signOut(): Promise<void> {
    this.currentUser = null;
    this.persist();
    this.notify();
  }
}

// Export singleton — swap implementation here when adding Supabase
export const authService: IAuthService = new LocalAuthService();
