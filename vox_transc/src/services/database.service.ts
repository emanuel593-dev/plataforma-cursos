/**
 * Database service abstraction.
 * Current implementation: localStorage-backed stub for development.
 * TODO: Replace LocalStorageDbService with SupabaseDbService when integrating Supabase.
 *
 * Real-time "watch" methods use a simple pub/sub pattern.
 * Supabase equivalent: supabase.channel() with postgres_changes.
 */

import {
  UserProfile,
  Organization,
  ApiKey,
  HistorySession,
  UserRole,
  Timestamp,
  LocalTimestamp,
} from '../types';

type Unsubscribe = () => void;
type Watcher<T> = (data: T) => void;

export interface IDbService {
  // User Profile
  getUserProfile(uid: string): Promise<UserProfile | null>;
  setUserProfile(uid: string, data: Partial<UserProfile>, merge?: boolean): Promise<void>;
  watchUserProfile(uid: string, cb: Watcher<UserProfile | null>): Unsubscribe;

  // Organization
  getOrganization(orgId: string): Promise<Organization | null>;
  setOrganization(orgId: string, data: Partial<Organization>): Promise<void>;
  createOrganization(org: Organization): Promise<void>;
  findOrganizationByOwner(ownerId: string): Promise<Organization | null>;
  watchOrganization(orgId: string, cb: Watcher<Organization | null>): Unsubscribe;

  // API Keys
  getApiKeys(orgId: string): Promise<ApiKey[]>;
  createApiKey(orgId: string, key: ApiKey): Promise<void>;
  deleteApiKey(orgId: string, keyId: string): Promise<void>;
  watchApiKeys(orgId: string, cb: Watcher<ApiKey[]>): Unsubscribe;

  // Sessions
  getSessions(userId: string): Promise<HistorySession[]>;
  createSession(session: HistorySession): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  watchSessions(userId: string, cb: Watcher<HistorySession[]>): Unsubscribe;

  // Org Members
  watchOrgMembers(orgId: string, cb: Watcher<UserProfile[]>): Unsubscribe;
  updateUserRole(uid: string, role: UserRole): Promise<void>;

  // Utilities
  generateId(): string;
  serverTimestamp(): Timestamp;
}

// ──────────────────────────────────────────────────────────────────────────────
// Stub implementation — backed by localStorage
// ──────────────────────────────────────────────────────────────────────────────

const LS = {
  USERS: 'vox_users',
  ORGS: 'vox_organizations',
  SESSIONS: 'vox_sessions',
  apiKeys: (orgId: string) => `vox_apikeys_${orgId}`,
};

class LocalStorageDbService implements IDbService {
  private readonly watchers = new Map<string, Set<Watcher<any>>>();

  // ── Pub/sub helpers ──────────────────────────────────────────────────────

  private subscribe<T>(key: string, cb: Watcher<T>): Unsubscribe {
    if (!this.watchers.has(key)) this.watchers.set(key, new Set());
    this.watchers.get(key)!.add(cb);
    return () => this.watchers.get(key)?.delete(cb);
  }

  private publish(key: string, data: any): void {
    this.watchers.get(key)?.forEach(cb => cb(data));
  }

  // ── localStorage helpers ─────────────────────────────────────────────────

  private read<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  }

  private write(key: string, data: unknown): void {
    localStorage.setItem(key, JSON.stringify(data));
  }

  // ── Deserialization ──────────────────────────────────────────────────────

  private toTs(val: unknown): LocalTimestamp {
    if (val instanceof LocalTimestamp) return val;
    if (typeof val === 'string') return LocalTimestamp.from(val);
    if (val && typeof val === 'object' && '_date' in val) {
      return LocalTimestamp.from((val as any)._date as string);
    }
    return LocalTimestamp.now();
  }

  private deserializeProfile(raw: any): UserProfile {
    return { ...raw, createdAt: this.toTs(raw.createdAt) } as UserProfile;
  }

  private deserializeOrg(raw: any): Organization {
    return { ...raw, createdAt: this.toTs(raw.createdAt) } as Organization;
  }

  private deserializeApiKey(raw: any): ApiKey {
    return {
      ...raw,
      createdAt: this.toTs(raw.createdAt),
      lastUsedAt: raw.lastUsedAt ? this.toTs(raw.lastUsedAt) : undefined,
    } as ApiKey;
  }

  private deserializeSession(raw: any): HistorySession {
    return {
      ...raw,
      timestamp: this.toTs(raw.timestamp),
      transcriptions: (raw.transcriptions || []).map((t: any) => ({
        ...t,
        timestamp: t.timestamp
          ? typeof t.timestamp === 'string'
            ? new Date(t.timestamp)
            : t.timestamp
          : new Date(),
      })),
    } as HistorySession;
  }

  // ── User Profile ─────────────────────────────────────────────────────────

  async getUserProfile(uid: string): Promise<UserProfile | null> {
    const all = this.read<Record<string, any>>(LS.USERS) ?? {};
    const raw = all[uid];
    return raw ? this.deserializeProfile(raw) : null;
  }

  async setUserProfile(uid: string, data: Partial<UserProfile>, merge = true): Promise<void> {
    const all = this.read<Record<string, any>>(LS.USERS) ?? {};
    all[uid] = merge ? { ...(all[uid] ?? {}), ...data } : { ...data };
    this.write(LS.USERS, all);
    const profile = this.deserializeProfile(all[uid]);
    this.publish(`user:${uid}`, profile);
    // Refresh org-members watchers if orgId changed
    const orgId = (data as any).orgId ?? all[uid]?.orgId;
    if (orgId) {
      const members = await this.getOrgMembers(orgId);
      this.publish(`members:${orgId}`, members);
    }
  }

  watchUserProfile(uid: string, cb: Watcher<UserProfile | null>): Unsubscribe {
    const unsub = this.subscribe(`user:${uid}`, cb);
    this.getUserProfile(uid).then(cb);
    return unsub;
  }

  // ── Organization ─────────────────────────────────────────────────────────

  async getOrganization(orgId: string): Promise<Organization | null> {
    const all = this.read<Record<string, any>>(LS.ORGS) ?? {};
    const raw = all[orgId];
    return raw ? this.deserializeOrg(raw) : null;
  }

  async setOrganization(orgId: string, data: Partial<Organization>): Promise<void> {
    const all = this.read<Record<string, any>>(LS.ORGS) ?? {};
    all[orgId] = { ...(all[orgId] ?? {}), ...data };
    this.write(LS.ORGS, all);
    this.publish(`org:${orgId}`, this.deserializeOrg(all[orgId]));
  }

  async createOrganization(org: Organization): Promise<void> {
    const all = this.read<Record<string, any>>(LS.ORGS) ?? {};
    all[org.id] = org;
    this.write(LS.ORGS, all);
  }

  async findOrganizationByOwner(ownerId: string): Promise<Organization | null> {
    const all = this.read<Record<string, any>>(LS.ORGS) ?? {};
    const raw = Object.values(all).find((o: any) => o.ownerId === ownerId);
    return raw ? this.deserializeOrg(raw) : null;
  }

  watchOrganization(orgId: string, cb: Watcher<Organization | null>): Unsubscribe {
    const unsub = this.subscribe(`org:${orgId}`, cb);
    this.getOrganization(orgId).then(cb);
    return unsub;
  }

  // ── API Keys ─────────────────────────────────────────────────────────────

  async getApiKeys(orgId: string): Promise<ApiKey[]> {
    const all = this.read<Record<string, any>>(LS.apiKeys(orgId)) ?? {};
    return Object.values(all).map(k => this.deserializeApiKey(k));
  }

  async createApiKey(orgId: string, key: ApiKey): Promise<void> {
    const all = this.read<Record<string, any>>(LS.apiKeys(orgId)) ?? {};
    all[key.id] = key;
    this.write(LS.apiKeys(orgId), all);
    this.publish(`apikeys:${orgId}`, Object.values(all).map(k => this.deserializeApiKey(k)));
  }

  async deleteApiKey(orgId: string, keyId: string): Promise<void> {
    const all = this.read<Record<string, any>>(LS.apiKeys(orgId)) ?? {};
    delete all[keyId];
    this.write(LS.apiKeys(orgId), all);
    this.publish(`apikeys:${orgId}`, Object.values(all).map(k => this.deserializeApiKey(k)));
  }

  watchApiKeys(orgId: string, cb: Watcher<ApiKey[]>): Unsubscribe {
    const unsub = this.subscribe(`apikeys:${orgId}`, cb);
    this.getApiKeys(orgId).then(cb);
    return unsub;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async getSessions(userId: string): Promise<HistorySession[]> {
    const all = this.read<Record<string, any>>(LS.SESSIONS) ?? {};
    return Object.values(all)
      .filter((s: any) => s.userId === userId)
      .map(s => this.deserializeSession(s))
      .sort((a, b) => b.timestamp.toDate().getTime() - a.timestamp.toDate().getTime());
  }

  async createSession(session: HistorySession): Promise<void> {
    const all = this.read<Record<string, any>>(LS.SESSIONS) ?? {};
    all[session.id] = session;
    this.write(LS.SESSIONS, all);
    const sessions = await this.getSessions(session.userId);
    this.publish(`sessions:${session.userId}`, sessions);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const all = this.read<Record<string, any>>(LS.SESSIONS) ?? {};
    const session = all[sessionId];
    if (!session) return;
    delete all[sessionId];
    this.write(LS.SESSIONS, all);
    const sessions = await this.getSessions(session.userId);
    this.publish(`sessions:${session.userId}`, sessions);
  }

  watchSessions(userId: string, cb: Watcher<HistorySession[]>): Unsubscribe {
    const unsub = this.subscribe(`sessions:${userId}`, cb);
    this.getSessions(userId).then(cb);
    return unsub;
  }

  // ── Org Members ──────────────────────────────────────────────────────────

  private async getOrgMembers(orgId: string): Promise<UserProfile[]> {
    const all = this.read<Record<string, any>>(LS.USERS) ?? {};
    return Object.values(all)
      .filter((u: any) => u.orgId === orgId)
      .map(u => this.deserializeProfile(u));
  }

  watchOrgMembers(orgId: string, cb: Watcher<UserProfile[]>): Unsubscribe {
    const unsub = this.subscribe(`members:${orgId}`, cb);
    this.getOrgMembers(orgId).then(cb);
    return unsub;
  }

  async updateUserRole(uid: string, role: UserRole): Promise<void> {
    await this.setUserProfile(uid, { role });
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  generateId(): string {
    return crypto.randomUUID();
  }

  serverTimestamp(): Timestamp {
    return LocalTimestamp.now();
  }
}

// Export singleton — swap implementation here when adding Supabase
export const dbService: IDbService = new LocalStorageDbService();
