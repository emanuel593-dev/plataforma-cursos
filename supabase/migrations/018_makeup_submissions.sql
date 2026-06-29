-- ─────────────────────────────────────────────────────────────────────────────
-- 018: Makeup (Reposição) Submissions
--
-- Tracks each student's makeup session for a recorded lesson:
--   1. watched_at  — set the moment the student clicks "Assistir"
--   2. summary     — written by the student after watching (min 400 chars)
--   3. status      — pending | submitted | approved | rejected
--   4. reviewer_*  — coord/professor feedback
--
-- One row per (recording, student) pair enforced by UNIQUE constraint.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists makeup_submissions (
  id                    uuid        primary key default gen_random_uuid(),
  recording_id          uuid        not null references recordings(id) on delete cascade,
  scheduled_lesson_id   uuid        references scheduled_lessons(id) on delete set null,
  class_id              uuid        references classes(id) on delete set null,
  student_id            uuid        not null references profiles(id) on delete cascade,

  -- Lifecycle timestamps
  watched_at            timestamptz,                  -- first click on "Assistir"
  submitted_at          timestamptz,                  -- when summary was sent
  reviewed_at           timestamptz,                  -- when coord reviewed

  -- Content
  summary               text,                         -- student-written summary

  -- Workflow status
  status                text        not null default 'pending'
                        check (status in ('pending', 'submitted', 'approved', 'rejected')),

  -- Reviewer feedback (coord or professor)
  reviewer_notes        text,
  reviewed_by           uuid        references profiles(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (recording_id, student_id)
);

-- Auto-update updated_at
create or replace function makeup_submissions_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger makeup_submissions_updated_at
  before update on makeup_submissions
  for each row execute function makeup_submissions_set_updated_at();

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists makeup_recording_idx on makeup_submissions(recording_id);
create index if not exists makeup_student_idx   on makeup_submissions(student_id);
create index if not exists makeup_class_idx     on makeup_submissions(class_id);
create index if not exists makeup_status_idx    on makeup_submissions(status);
create index if not exists makeup_lesson_idx    on makeup_submissions(scheduled_lesson_id);

-- ── Row-Level Security ────────────────────────────────────────────────────────
alter table makeup_submissions enable row level security;

-- Student: see and manage their own submissions
create policy "makeup_student_own"
  on makeup_submissions for all
  using  (auth.uid() = student_id)
  with check (auth.uid() = student_id);

-- Professor / coordenacao: read all submissions from their classes
create policy "makeup_staff_select"
  on makeup_submissions for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('coordenacao', 'professor')
    )
  );

-- Coordinator: can update reviewer_notes, status, reviewed_by, reviewed_at
create policy "makeup_coord_review"
  on makeup_submissions for update
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('coordenacao', 'professor')
    )
  );
