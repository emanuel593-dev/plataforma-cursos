// Swap requests — professor↔professor lesson trades, with target acceptance.
// Coordination has full override (substitution.service.ts handles emergency).

import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { assertOnline } from '../lib/network';
import { updateScheduledLesson } from './schedule.service';
import type {
  LessonSwapRequest, LessonSwapRequestInsert,
  ScheduledLesson, Profile,
} from '../types';

const LS_KEY = 'iv_lesson_swap_requests';

function getStored(): LessonSwapRequest[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function save(items: LessonSwapRequest[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

export interface SwapRequestRich extends LessonSwapRequest {
  scheduled_lesson?: ScheduledLesson;
  offered_lesson?: ScheduledLesson;
  requester?: Profile;
  target?: Profile;
}

export async function createSwapRequest(input: LessonSwapRequestInsert): Promise<LessonSwapRequest> {
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('lesson_swap_requests') as any)
      .insert(input).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  const item: LessonSwapRequest = {
    id: crypto.randomUUID(),
    scheduled_lesson_id: input.scheduled_lesson_id,
    requester_id: input.requester_id,
    target_id: input.target_id,
    offered_lesson_id: input.offered_lesson_id ?? null,
    message: input.message ?? null,
    status: 'pending',
    responded_at: null,
    created_at: new Date().toISOString(),
  };
  const items = getStored();
  items.push(item);
  save(items);
  return item;
}

export async function listMyPendingSwaps(userId: string): Promise<LessonSwapRequest[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_swap_requests')
      .select('*')
      .or(`requester_id.eq.${userId},target_id.eq.${userId}`)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter((r) => r.status === 'pending' && (r.requester_id === userId || r.target_id === userId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listAllSwapsForUser(userId: string): Promise<LessonSwapRequest[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_swap_requests')
      .select('*')
      .or(`requester_id.eq.${userId},target_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored()
    .filter((r) => r.requester_id === userId || r.target_id === userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listAllSwaps(): Promise<LessonSwapRequest[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_swap_requests')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return getStored().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Target accepts: re-assigns the lesson to the target atomically via DB RPC.
 *  The RPC (migration 021) writes kind='swap' in lesson_assignment_history,
 *  fixing the bug where accepted swaps appeared as 'substitution' in Histórico.
 *  Falls back to the old sequential approach for offline/demo mode. */
export async function acceptSwap(requestId: string): Promise<void> {
  assertOnline();
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc('accept_lesson_swap', { p_swap_id: requestId });
    if (error) throw new Error(error.message);
    return;
  }
  // Offline/demo fallback
  const req = await getSwap(requestId);
  if (!req) throw new Error('Pedido de troca não encontrado.');
  if (req.status !== 'pending') throw new Error('Esta solicitação já foi respondida.');
  await updateScheduledLesson(req.scheduled_lesson_id, { professor_id: req.target_id });
  if (req.offered_lesson_id) {
    await updateScheduledLesson(req.offered_lesson_id, { professor_id: req.requester_id });
  }
  await updateSwap(requestId, { status: 'accepted', responded_at: new Date().toISOString() });
}

export async function rejectSwap(requestId: string): Promise<void> {
  assertOnline();
  await updateSwap(requestId, { status: 'rejected', responded_at: new Date().toISOString() });
}

export async function cancelSwap(requestId: string): Promise<void> {
  assertOnline();
  await updateSwap(requestId, { status: 'cancelled', responded_at: new Date().toISOString() });
}

async function getSwap(id: string): Promise<LessonSwapRequest | null> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_swap_requests').select('*').eq('id', id).maybeSingle();
    if (error) return null;
    return data;
  }
  return getStored().find((r) => r.id === id) || null;
}

async function updateSwap(id: string, patch: Partial<LessonSwapRequest>): Promise<void> {
  if (isSupabaseConfigured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('lesson_swap_requests') as any)
      .update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const items = getStored();
  const idx = items.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error('Pedido não encontrado.');
  items[idx] = { ...items[idx], ...patch } as LessonSwapRequest;
  save(items);
}
