// Generic timestamp abstraction — compatible with Firestore, Supabase (ISO strings) and in-memory.
// Concrete implementations live in services/database.service.ts
export interface Timestamp {
  toDate(): Date;
}

export class LocalTimestamp implements Timestamp {
  private readonly _date: Date;
  constructor(date: Date | string = new Date()) {
    this._date = typeof date === 'string' ? new Date(date) : date;
  }
  toDate() { return this._date; }
  toJSON() { return this._date.toISOString(); }
  static from(date: Date | string) { return new LocalTimestamp(date); }
  static now() { return new LocalTimestamp(); }
}

export type UserRole = 'owner' | 'admin' | 'member';
export type SubscriptionPlan = 'free' | 'pro' | 'enterprise';
export type SessionMode = 'local' | 'meeting';

// App-level UI types (moved here from App.tsx to allow reuse in view components)
export type AppMode = 'idle' | 'local' | 'meeting';
export type SummaryTone = 'executive' | 'technical' | 'educational' | 'full' | 'interview';
export type RecordingMode = 'live' | 'hybrid' | 'recorder';
export type ActiveView = 'recording' | 'workspace' | 'dashboard' | 'settings' | 'conference' | 'admin';

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  orgId?: string;
  role?: UserRole;
  createdAt: Timestamp;
}

export interface Organization {
  id: string;
  name: string;
  ownerId: string;
  plan: SubscriptionPlan;
  createdAt: Timestamp;
}

export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  hashedKey: string;
  createdAt: Timestamp;
  lastUsedAt?: Timestamp;
}

export interface HistorySession {
  id: string;
  userId: string;
  orgId?: string | null;
  timestamp: Timestamp;
  mode: SessionMode;
  transcriptions?: any[];
  summary?: string;
  duration: number;
  externalId?: string;
}
