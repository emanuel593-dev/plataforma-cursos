import { supabase, isSupabaseConfigured } from '../lib/supabase';

export interface PersistedChatMessage {
  id: string;
  scheduled_lesson_id: string | null;
  room_id: string;
  user_id: string;
  user_name: string;
  text: string;
  created_at: string;
}

export async function listChatMessages(roomId: string): Promise<PersistedChatMessage[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('lesson_chat_messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) {
    console.warn('[IV] listChatMessages error:', error.message);
    return [];
  }
  return (data ?? []) as PersistedChatMessage[];
}

/**
 * Reverse-cursor pagination for chat scroll-back. Pass the `created_at` of
 * the oldest message currently held in memory; returns up to `limit` messages
 * strictly older than that, ordered ascending so callers can prepend
 * directly. Used by the in-call chat panel "load older" affordance.
 */
export async function listChatMessagesBefore(
  roomId: string,
  beforeIso: string,
  limit = 100,
): Promise<PersistedChatMessage[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('lesson_chat_messages')
    .select('*')
    .eq('room_id', roomId)
    .lt('created_at', beforeIso)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[IV] listChatMessagesBefore error:', error.message);
    return [];
  }
  // Reverse to ascending so callers can prepend without re-sorting.
  return ((data ?? []) as PersistedChatMessage[]).slice().reverse();
}

export async function insertChatMessage(input: {
  scheduled_lesson_id?: string | null;
  room_id: string;
  user_id: string;
  user_name: string;
  text: string;
}): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await (supabase.from('lesson_chat_messages') as any).insert({
    scheduled_lesson_id: input.scheduled_lesson_id ?? null,
    room_id: input.room_id,
    user_id: input.user_id,
    user_name: input.user_name,
    text: input.text,
  });
  if (error) console.warn('[IV] insertChatMessage error:', error.message);
}

/**
 * Hard-deletes a chat message. RLS only allows the message owner, the
 * coordenação, or a class monitor of the lesson to perform the delete
 * (see migration 027). Used by the in-call moderation affordance.
 */
export async function deleteChatMessage(messageId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase
    .from('lesson_chat_messages')
    .delete()
    .eq('id', messageId);
  if (error) throw new Error(error.message);
}
