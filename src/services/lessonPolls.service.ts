import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type {
  LessonPoll,
  LessonPollInsert,
  LessonPollResponse,
  LessonPollResponseInsert,
  LessonPollStatus,
} from '../types';

// ── lesson_polls / lesson_poll_responses service ─────────────────────────────
//
// Phase 4 of the monitor rollout: live in-class dynamics.
//
// The service is deliberately thin — every gating check happens in RLS
// (mig 030). Realtime delivery to participants is layered on top via
// `subscribeToPolls` / `subscribeToResponses`, both of which use Supabase
// Realtime postgres_changes (the room broadcast channel handles peer
// presence; polls are server-state, not peer state).

// ── Polls (staff CRUD + lifecycle) ───────────────────────────────────────────

/** List all polls for a given scheduled lesson. RLS already restricts the
 *  result set to participants of the class. Ordered newest first so the
 *  drawer shows the latest creations on top. */
export async function listPollsByLesson(scheduledLessonId: string): Promise<LessonPoll[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('lesson_polls')
    .select('*')
    .eq('scheduled_lesson_id', scheduledLessonId)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[IV] listPollsByLesson error:', error.message);
    return [];
  }
  return (data ?? []) as LessonPoll[];
}

/** Create a poll in `draft` state. Status transitions go through the
 *  dedicated helpers below so opened_at / closed_at stay consistent. */
export async function createPoll(input: LessonPollInsert): Promise<LessonPoll> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase não configurado.');
  }
  const payload = { status: 'draft' as const, ...input };
  const { data, error } = await (supabase.from('lesson_polls') as any)
    .insert(payload)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as LessonPoll;
}

/** Edit a draft poll. Only meaningful while status='draft'; the UI hides
 *  the edit affordance once the poll is open or closed. */
export async function updatePoll(
  pollId: string,
  patch: Partial<Pick<LessonPoll, 'kind' | 'question' | 'options' | 'correct_option'>>,
): Promise<LessonPoll> {
  if (!isSupabaseConfigured) throw new Error('Supabase não configurado.');
  const { data, error } = await (supabase.from('lesson_polls') as any)
    .update(patch)
    .eq('id', pollId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as LessonPoll;
}

/** Move a poll to `open` and stamp `opened_at`. The RLS for responses
 *  checks `lesson_polls.status='open'`, so this single transition flips
 *  the gate for every student in the class. */
export async function openPoll(pollId: string): Promise<LessonPoll> {
  if (!isSupabaseConfigured) throw new Error('Supabase não configurado.');
  const { data, error } = await (supabase.from('lesson_polls') as any)
    .update({ status: 'open', opened_at: new Date().toISOString() })
    .eq('id', pollId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as LessonPoll;
}

/** Move a poll to `closed` and stamp `closed_at`. */
export async function closePoll(pollId: string): Promise<LessonPoll> {
  if (!isSupabaseConfigured) throw new Error('Supabase não configurado.');
  const { data, error } = await (supabase.from('lesson_polls') as any)
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', pollId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as LessonPoll;
}

/** Delete a poll (cascade removes responses). Staff only via RLS. */
export async function deletePoll(pollId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.from('lesson_polls').delete().eq('id', pollId);
  if (error) throw new Error(error.message);
}

// ── Responses (student submit + staff aggregate) ─────────────────────────────

/** List all responses for a poll. Staff sees everything (per RLS); a
 *  student would receive only their own row, which is fine — they don't
 *  call this. Used by the staff drawer to render bar charts. */
export async function listPollResponses(pollId: string): Promise<LessonPollResponse[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('lesson_poll_responses')
    .select('*')
    .eq('poll_id', pollId)
    .order('submitted_at', { ascending: true });
  if (error) {
    console.warn('[IV] listPollResponses error:', error.message);
    return [];
  }
  return (data ?? []) as LessonPollResponse[];
}

/** Fetch the current student's response (if any) for a poll. Used to
 *  rehydrate the answered state when the modal reopens. */
export async function getMyResponse(
  pollId: string,
  studentId: string,
): Promise<LessonPollResponse | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase
    .from('lesson_poll_responses')
    .select('*')
    .eq('poll_id', pollId)
    .eq('student_id', studentId)
    .maybeSingle();
  if (error) {
    console.warn('[IV] getMyResponse error:', error.message);
    return null;
  }
  return (data as LessonPollResponse | null) ?? null;
}

/** Insert-or-update the student's response. Conflict target is the
 *  composite UNIQUE (poll_id, student_id). RLS enforces poll.status='open'
 *  on both INSERT and UPDATE, so a stale modal can't slip an answer in. */
export async function upsertResponse(input: LessonPollResponseInsert): Promise<LessonPollResponse> {
  if (!isSupabaseConfigured) throw new Error('Supabase não configurado.');
  const { data, error } = await (supabase.from('lesson_poll_responses') as any)
    .upsert(input, { onConflict: 'poll_id,student_id' })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as LessonPollResponse;
}

// ── Realtime subscriptions ──────────────────────────────────────────────────

/** Subscribe to INSERT/UPDATE/DELETE on lesson_polls for a given lesson.
 *  The handler receives the new row (or undefined for delete) and the
 *  raw event type so the UI can patch local state precisely.
 *  Returns an unsubscribe function. */
export function subscribeToPolls(
  scheduledLessonId: string,
  handler: (event: 'INSERT' | 'UPDATE' | 'DELETE', row: LessonPoll | null, oldRow: LessonPoll | null) => void,
): () => void {
  if (!isSupabaseConfigured) return () => undefined;
  const channel = supabase
    .channel(`polls:${scheduledLessonId}`)
    .on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table: 'lesson_polls', filter: `scheduled_lesson_id=eq.${scheduledLessonId}` },
      (payload: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: LessonPoll | null; old: LessonPoll | null }) => {
        handler(payload.eventType, payload.new, payload.old);
      },
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

/** Subscribe to INSERT/UPDATE/DELETE on lesson_poll_responses for a given poll.
 *  Used by the staff drawer to update the live count without polling.
 *  RLS may filter individual events for a non-staff user; for the staff
 *  use case it returns every row. DELETE events carry the old row so the
 *  caller can remove the entry from local state. */
export function subscribeToPollResponses(
  pollId: string,
  handler: (event: 'INSERT' | 'UPDATE' | 'DELETE', row: LessonPollResponse | null, oldRow: LessonPollResponse | null) => void,
): () => void {
  if (!isSupabaseConfigured) return () => undefined;
  const channel = supabase
    .channel(`poll-responses:${pollId}`)
    .on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table: 'lesson_poll_responses', filter: `poll_id=eq.${pollId}` },
      (payload: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: LessonPollResponse | null; old: LessonPollResponse | null }) => {
        handler(payload.eventType, payload.new, payload.old);
      },
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

// ── Aggregation helpers (pure) ───────────────────────────────────────────────

/** Tally responses per option for a multiple_choice / true_false poll.
 *  Returns an array aligned with poll.options. open_text returns []. */
export function tallyResponses(poll: LessonPoll, responses: LessonPollResponse[]): number[] {
  if (poll.kind === 'open_text' || !poll.options) return [];
  const counts = new Array(poll.options.length).fill(0) as number[];
  for (const r of responses) {
    if (r.selected_option != null && r.selected_option >= 0 && r.selected_option < counts.length) {
      counts[r.selected_option] += 1;
    }
  }
  return counts;
}

/** Convenience predicate so the UI can disable the "Open" button when
 *  another poll is already running for the same lesson — keeping the
 *  student experience simple (one active poll at a time). */
export function hasOpenPoll(polls: LessonPoll[]): boolean {
  return polls.some((p) => p.status === 'open');
}

export type { LessonPollStatus };
