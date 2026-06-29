-- ─────────────────────────────────────────────────────────────────────────────
-- 019: Makeup Deadline (FJ → reposição)
--
-- When coordination marks a student as 'justified' (FJ), they are obliged to
-- watch the recording AND submit a written summary BEFORE the next lesson of
-- the same class (cutoff = next_scheduled_lesson - 24h).
--
-- Past that deadline, if the student didn't submit/get-approved, a daily
-- scheduled function flips the attendance back to 'absent' (F).
--
-- The deadline is computed and FROZEN at the moment markJustified() runs.
-- If the next lesson is later rescheduled, the original obligation stands.
-- ─────────────────────────────────────────────────────────────────────────────

alter table attendance
  add column if not exists makeup_deadline timestamptz;

-- Index for the daily expiry job (filters by status + deadline window).
create index if not exists attendance_makeup_deadline_idx
  on attendance(status, makeup_deadline)
  where status = 'justified' and makeup_deadline is not null;

comment on column attendance.makeup_deadline is
  'Deadline for the student to submit the makeup summary. '
  'Computed as (next scheduled lesson of the class - 24h) at the moment FJ is marked. '
  'If null, no deadline applies (legacy or non-FJ rows).';
