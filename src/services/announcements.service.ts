import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { getCurrentUserRole, getCurrentUser } from './auth.service';
import { getStudentClassIds, listClassesByProfessor } from './classes.service';
import type { Announcement, AnnouncementInsert, AnnouncementUpdate, AnnouncementRead } from '../types';

const LS_ANNOUNCEMENTS = 'iv_announcements';
const LS_ANNOUNCEMENT_READS = 'iv_announcement_reads';

function getStoredAnnouncements(): Announcement[] {
  try {
    return JSON.parse(localStorage.getItem(LS_ANNOUNCEMENTS) || '[]');
  } catch {
    return [];
  }
}

function saveStoredAnnouncements(items: Announcement[]) {
  localStorage.setItem(LS_ANNOUNCEMENTS, JSON.stringify(items));
}

function getStoredReads(): AnnouncementRead[] {
  try {
    return JSON.parse(localStorage.getItem(LS_ANNOUNCEMENT_READS) || '[]');
  } catch {
    return [];
  }
}

function saveStoredReads(items: AnnouncementRead[]) {
  localStorage.setItem(LS_ANNOUNCEMENT_READS, JSON.stringify(items));
}

function notExpired(item: Announcement): boolean {
  if (!item.expires_at) return true;
  return new Date(item.expires_at).getTime() > Date.now();
}

function sortAnnouncements(a: Announcement, b: Announcement): number {
  if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

export async function listVisibleAnnouncements(limit = 6): Promise<Announcement[]> {
  if (isSupabaseConfigured) {
    const nowIso = new Date().toISOString();
    // nowIso is generated server-side from Date, not from user input — safe to interpolate
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  }

  const role = getCurrentUserRole();
  const current = getCurrentUser();
  const all = getStoredAnnouncements().filter(notExpired);

  let visible = all.filter((a) => a.class_id === null);

  if (role === 'coordenacao') {
    visible = all;
  } else if (role === 'professor' && current) {
    const myClasses = await listClassesByProfessor(current.id);
    const classIds = new Set(myClasses.map((c) => c.id));
    visible = all.filter((a) => a.class_id === null || (a.class_id && classIds.has(a.class_id)));
  } else if (role === 'aluno' && current) {
    const classIds = new Set(await getStudentClassIds(current.id));
    visible = all.filter((a) => a.class_id === null || (a.class_id && classIds.has(a.class_id)));
  }

  return visible.sort(sortAnnouncements).slice(0, limit);
}

export async function createAnnouncement(input: AnnouncementInsert): Promise<Announcement> {
  const role = getCurrentUserRole();
  if (role !== null && role !== 'coordenacao' && role !== 'professor') {
    throw new Error('Apenas coordenação e professores podem criar avisos.');
  }
  assertOnline();

  if (isSupabaseConfigured) {
    const { data, error } = await (supabase.from('announcements') as any)
      .insert(input)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const item: Announcement = {
    id: crypto.randomUUID(),
    class_id: input.class_id ?? null,
    author_id: input.author_id,
    title: input.title,
    content: input.content,
    is_pinned: input.is_pinned ?? false,
    expires_at: input.expires_at ?? null,
    created_at: new Date().toISOString(),
  };

  const all = getStoredAnnouncements();
  all.push(item);
  saveStoredAnnouncements(all);
  return item;
}

export async function updateAnnouncement(id: string, updates: AnnouncementUpdate): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await (supabase.from('announcements') as any)
      .update(updates)
      .eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }

  const all = getStoredAnnouncements();
  const idx = all.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error('Aviso não encontrado.');
  all[idx] = { ...all[idx], ...updates };
  saveStoredAnnouncements(all);
}

export async function deleteAnnouncement(id: string): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('announcements').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }

  const all = getStoredAnnouncements().filter((a) => a.id !== id);
  saveStoredAnnouncements(all);
}

// ── Announcement Reads ───────────────────────────────────────────────────────

export async function markAnnouncementRead(announcementId: string, userId: string): Promise<AnnouncementRead> {
  if (isSupabaseConfigured) {
    const { data, error } = await (supabase.from('announcement_reads') as any)
      .upsert(
        { announcement_id: announcementId, user_id: userId, read_at: new Date().toISOString() },
        { onConflict: 'announcement_id,user_id', ignoreDuplicates: true },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const reads = getStoredReads();
  const existing = reads.find((r) => r.announcement_id === announcementId && r.user_id === userId);
  if (existing) return existing;

  const read: AnnouncementRead = {
    id: crypto.randomUUID(),
    announcement_id: announcementId,
    user_id: userId,
    read_at: new Date().toISOString(),
  };
  reads.push(read);
  saveStoredReads(reads);
  return read;
}

export async function listReadsByAnnouncement(announcementId: string): Promise<AnnouncementRead[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('announcement_reads')
      .select('*')
      .eq('announcement_id', announcementId);
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredReads().filter((r) => r.announcement_id === announcementId);
}

export async function listReadsByUser(userId: string): Promise<AnnouncementRead[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('announcement_reads')
      .select('*')
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStoredReads().filter((r) => r.user_id === userId);
}

export async function getReadCount(announcementId: string): Promise<number> {
  const reads = await listReadsByAnnouncement(announcementId);
  return reads.length;
}

export async function hasUserRead(announcementId: string, userId: string): Promise<boolean> {
  if (isSupabaseConfigured) {
    // Use maybeSingle() so 0-row result returns { data: null, error: null } instead of an error
    const { data, error } = await supabase
      .from('announcement_reads')
      .select('id')
      .eq('announcement_id', announcementId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return false; // safe: treat read-check failure as "not read"
    return !!data;
  }
  return getStoredReads().some((r) => r.announcement_id === announcementId && r.user_id === userId);
}

/** Batch: get read counts for multiple announcements */
export async function getReadCountsBatch(announcementIds: string[]): Promise<Record<string, number>> {
  if (announcementIds.length === 0) return {};
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .in('announcement_id', announcementIds);
    if (error) throw new Error(error.message);
    const counts: Record<string, number> = {};
    for (const id of announcementIds) counts[id] = 0;
    for (const row of (data || []) as Array<{ announcement_id: string }>) {
      counts[row.announcement_id] = (counts[row.announcement_id] ?? 0) + 1;
    }
    return counts;
  }
  const reads = getStoredReads();
  const idSet = new Set(announcementIds);
  const counts: Record<string, number> = {};
  for (const id of announcementIds) counts[id] = 0;
  for (const r of reads) {
    if (idSet.has(r.announcement_id)) {
      counts[r.announcement_id] = (counts[r.announcement_id] ?? 0) + 1;
    }
  }
  return counts;
}

/** Batch: get which announcements a user has read */
export async function getUserReadSet(userId: string, announcementIds: string[]): Promise<Set<string>> {
  if (announcementIds.length === 0) return new Set();
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .eq('user_id', userId)
      .in('announcement_id', announcementIds);
    if (error) throw new Error(error.message);
    return new Set((data || []).map((r: any) => r.announcement_id));
  }
  const reads = getStoredReads();
  const idSet = new Set(announcementIds);
  return new Set(
    reads
      .filter((r) => r.user_id === userId && idSet.has(r.announcement_id))
      .map((r) => r.announcement_id),
  );
}
