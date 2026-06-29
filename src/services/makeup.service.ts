/**
 * makeup.service.ts
 *
 * CRUD for makeup_submissions — tracks each student's reposição session:
 *   - watched_at: set when student clicks "Assistir"
 *   - summary:    student-written summary (min 400 chars)
 *   - status:     pending → submitted → approved | rejected
 *   - reviewer_*: coord / professor feedback
 */

import { supabase } from '../lib/supabase';
import type { MakeupSubmission, MakeupSubmissionStatus } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function row(data: Record<string, unknown>): MakeupSubmission {
  return {
    id:                  data.id as string,
    recording_id:        data.recording_id as string,
    scheduled_lesson_id: data.scheduled_lesson_id as string | null,
    class_id:            data.class_id as string | null,
    student_id:          data.student_id as string,
    watched_at:          data.watched_at as string | null,
    submitted_at:        data.submitted_at as string | null,
    reviewed_at:         data.reviewed_at as string | null,
    summary:             data.summary as string | null,
    status:              data.status as MakeupSubmissionStatus,
    reviewer_notes:      data.reviewer_notes as string | null,
    reviewed_by:         data.reviewed_by as string | null,
    created_at:          data.created_at as string,
    updated_at:          data.updated_at as string,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the submission for a specific (recording, student) pair, or null.
 */
export async function getSubmission(
  recordingId: string,
  studentId: string,
): Promise<MakeupSubmission | null> {
  const { data, error } = await (supabase
    .from('makeup_submissions') as any)
    .select('*')
    .eq('recording_id', recordingId)
    .eq('student_id', studentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? row(data as Record<string, unknown>) : null;
}

/**
 * Returns all submissions for a given class (staff use).
 */
export async function listSubmissionsByClass(
  classId: string,
): Promise<MakeupSubmission[]> {
  const { data, error } = await (supabase
    .from('makeup_submissions') as any)
    .select('*')
    .eq('class_id', classId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(row);
}

/**
 * Returns all submissions visible to the current user (staff: all; student: own).
 */
export async function listAllSubmissions(opts?: {
  classId?: string;
  status?: MakeupSubmissionStatus;
  recordingIds?: string[];
  studentId?: string;
  limit?: number;
}): Promise<MakeupSubmission[]> {
  let query = (supabase.from('makeup_submissions') as any)
    .select('*')
    .order('created_at', { ascending: false });

  if (opts?.classId)             query = query.eq('class_id', opts.classId);
  if (opts?.status)              query = query.eq('status', opts.status);
  if (opts?.studentId)           query = query.eq('student_id', opts.studentId);
  if (opts?.recordingIds?.length) query = query.in('recording_id', opts.recordingIds);
  if (opts?.limit)               query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(row);
}

/**
 * Records that a student opened the recording (sets watched_at to now on first call).
 * Race-safe: uses upsert with ignoreDuplicates so concurrent calls don't violate
 * the unique(recording_id, student_id) constraint. Existing rows are not touched.
 */
export async function markWatched(
  recordingId: string,
  studentId: string,
  scheduledLessonId: string | null,
  classId: string | null,
): Promise<MakeupSubmission> {
  const payload = {
    recording_id:         recordingId,
    scheduled_lesson_id:  scheduledLessonId,
    class_id:             classId,
    student_id:           studentId,
    watched_at:           new Date().toISOString(),
    status:               'pending' as const,
  };

  const { data, error } = await (supabase
    .from('makeup_submissions') as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(payload as any, { onConflict: 'recording_id,student_id', ignoreDuplicates: true })
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);

  // Insert was performed -> return the newly-created row.
  if (data) return row(data as Record<string, unknown>);

  // Row already existed -> fetch it without overwriting watched_at.
  const existing = await getSubmission(recordingId, studentId);
  if (!existing) throw new Error('Falha ao registrar visualização.');
  return existing;
}

/**
 * Submits the student's summary (sets status → 'submitted').
 *
 * Enforces the makeup deadline: looks up the related attendance row and
 * blocks submission if `makeup_deadline` has passed. This is the backend
 * gate — UI also disables the button, but never trust the client.
 */
export async function submitSummary(
  submissionId: string,
  summary: string,
): Promise<void> {
  // 1) Load the submission to know which (lesson, student) it belongs to
  const { data: sub, error: subErr } = await (supabase
    .from('makeup_submissions') as any)
    .select('scheduled_lesson_id, student_id')
    .eq('id', submissionId)
    .maybeSingle();
  if (subErr) throw new Error(subErr.message);
  if (!sub) throw new Error('Submissão não encontrada.');

  // 2) If there's an attendance row with FJ + a deadline, enforce it
  if (sub.scheduled_lesson_id && sub.student_id) {
    const { data: att } = await (supabase
      .from('attendance') as any)
      .select('status, makeup_deadline')
      .eq('scheduled_lesson_id', sub.scheduled_lesson_id as string)
      .eq('student_id', sub.student_id as string)
      .maybeSingle();

    if (
      att?.status === 'justified'
      && att.makeup_deadline
      && new Date(att.makeup_deadline as string).getTime() < Date.now()
    ) {
      throw new Error(
        'O prazo para envio do resumo desta reposição já encerrou. '
        + 'Procure a coordenação se precisar de orientação.',
      );
    }
  }

  // 3) Persist the submission. We always reset reviewer fields so a
  //    re-submission (after rejection) starts a clean review cycle and the
  //    student no longer sees stale feedback once the new draft is sent.
  const { error } = await (supabase
    .from('makeup_submissions') as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({
      summary,
      status:         'submitted',
      submitted_at:   new Date().toISOString(),
      reviewer_notes: null,
      reviewed_at:    null,
      reviewed_by:    null,
    } as any)
    .eq('id', submissionId);
  if (error) throw new Error(error.message);
}

/**
 * Coord / professor reviews a submission (approve or reject + optional note).
 * Best-effort: triggers a push notification to the student. Push failures
 * never block the review itself.
 */
export async function reviewSubmission(
  submissionId: string,
  status: 'approved' | 'rejected',
  reviewedBy: string,
  reviewerNotes?: string,
): Promise<void> {
  const { error } = await (supabase
    .from('makeup_submissions') as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({
      status,
      reviewer_notes: reviewerNotes ?? null,
      reviewed_by:    reviewedBy,
      reviewed_at:    new Date().toISOString(),
    } as any)
    .eq('id', submissionId);
  if (error) throw new Error(error.message);

  // Fire-and-forget push notification to the student.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (token) {
      void fetch('/api/push/makeup-reviewed', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ submissionId }),
      }).catch(() => undefined);
    }
  } catch {
    // ignore push errors
  }
}

/**
 * Returns all submissions for a specific recording.
 */
export async function listSubmissionsByRecording(
  recordingId: string,
): Promise<MakeupSubmission[]> {
  const { data, error } = await (supabase
    .from('makeup_submissions') as any)
    .select('*')
    .eq('recording_id', recordingId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(row);
}
