// Lesson assignment history — read-only audit log of meaningful lesson changes.
// Written automatically by DB triggers on `scheduled_lessons`:
//   - record_lesson_assignment_change: professor substitutions + swaps
//   - record_lesson_status_change:     cancellations / reinstatements (020)
//   - record_lesson_reschedule:        scheduled_at changes (020)
//
// NOTE: kind='assignment' (initial professor at creation time) is excluded from
// list queries — it's noise that grows with every new scheduled lesson.

import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { LessonAssignmentHistory } from '../types';

// Kinds we display in the Histórico tab (excludes pure initial 'assignment').
const MEANINGFUL_KINDS = ['substitution', 'swap', 'cancellation', 'reinstatement', 'reschedule'];

export async function listAssignmentHistory(opts: { limit?: number } = {}): Promise<LessonAssignmentHistory[]> {
  const { limit = 200 } = opts;
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_assignment_history')
      .select('*')
      .in('kind', MEANINGFUL_KINDS)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  }
  return [];
}

export async function listAssignmentHistoryFor(
  scheduledLessonId: string,
): Promise<LessonAssignmentHistory[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase
      .from('lesson_assignment_history')
      .select('*')
      .eq('scheduled_lesson_id', scheduledLessonId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return [];
}
