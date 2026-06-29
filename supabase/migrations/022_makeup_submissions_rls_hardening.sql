-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 022_makeup_submissions_rls_hardening                                     ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Hardens Row-Level Security on `makeup_submissions`. The policies created ║
-- ║ in migration 018 had two real-world holes:                               ║
-- ║                                                                          ║
-- ║   1. The student-owner policy (`for all`) let the *student* UPDATE any   ║
-- ║      column — including `status`, `reviewer_notes`, `reviewed_by`. A     ║
-- ║      malicious user could effectively self-approve their own makeup.     ║
-- ║                                                                          ║
-- ║   2. The staff UPDATE policy had no `WITH CHECK`, so a coordinator could ║
-- ║      reassign a submission to a different student/lesson/class on save. ║
-- ║                                                                          ║
-- ║   3. Staff visibility was not scoped to classes the user actually        ║
-- ║      participates in: any professor could read submissions from any      ║
-- ║      class. Coordenação retains full visibility (intentional).           ║
-- ║                                                                          ║
-- ║ This migration replaces the offending policies with column-aware logic   ║
-- ║ enforced via a BEFORE UPDATE trigger (Postgres RLS cannot grant per-     ║
-- ║ column UPDATE on its own without GRANTs that would defeat RLS shape).   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1. Drop the over-permissive legacy policies ──────────────────────────────
drop policy if exists "makeup_student_own"   on makeup_submissions;
drop policy if exists "makeup_staff_select"  on makeup_submissions;
drop policy if exists "makeup_coord_review"  on makeup_submissions;

-- ── 2. Student SELECT: own rows only ─────────────────────────────────────────
create policy "makeup_student_select"
  on makeup_submissions for select
  using (auth.uid() = student_id);

-- ── 3. Student INSERT: only inserting rows that belong to themselves ─────────
--     (the typical insert path is via `recordWatched` after viewing a recording)
create policy "makeup_student_insert"
  on makeup_submissions for insert
  with check (auth.uid() = student_id);

-- ── 4. Student UPDATE: own row only.                                       ──
--     Column-level restrictions (no self-approval) are enforced by the
--     trigger below, because RLS does not provide per-column WITH CHECK.
create policy "makeup_student_update"
  on makeup_submissions for update
  using (auth.uid() = student_id)
  with check (auth.uid() = student_id);

-- ── 5. Staff SELECT: coordenação sees all, professores see only their own ────
--     classes (joined through scheduled_lessons → class_professors).
create policy "makeup_staff_select"
  on makeup_submissions for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role = 'coordenacao'
    )
    or exists (
      select 1
        from class_professors cp
       where cp.professor_id = auth.uid()
         and cp.class_id     = makeup_submissions.class_id
    )
  );

-- ── 6. Staff UPDATE: coord/prof, scoped to their classes, with WITH CHECK ────
--     so they cannot move a submission to another student/class on save.
create policy "makeup_staff_update"
  on makeup_submissions for update
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role = 'coordenacao'
    )
    or exists (
      select 1
        from class_professors cp
       where cp.professor_id = auth.uid()
         and cp.class_id     = makeup_submissions.class_id
    )
  )
  with check (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role = 'coordenacao'
    )
    or exists (
      select 1
        from class_professors cp
       where cp.professor_id = auth.uid()
         and cp.class_id     = makeup_submissions.class_id
    )
  );

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 7. Column-level enforcement trigger                                       ║
-- ║                                                                           ║
-- ║   Students may only mutate `summary`, `submitted_at`, `status` (only the ║
-- ║   transition pending → submitted), and `watched_at`. Reviewer fields are  ║
-- ║   reset to NULL on (re-)submission by the application layer; the trigger  ║
-- ║   verifies they remain NULL when the actor is the student.                ║
-- ║                                                                           ║
-- ║   Staff (coord/professor) may write any column.                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
create or replace function enforce_makeup_submission_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  -- Look up the actor role (no auth.uid() in BEFORE INSERT for service role,
  -- so we only enforce on UPDATE issued by an authenticated student).
  select role into v_role from profiles where id = auth.uid();

  -- Service role / triggers internal to migrations skip this check.
  if v_role is null then
    return new;
  end if;

  -- Staff bypass column-level checks; row-level RLS already gated them.
  if v_role in ('coordenacao', 'professor') then
    return new;
  end if;

  -- From here on the actor is a student updating their own row.
  if old.student_id is distinct from new.student_id
     or old.recording_id        is distinct from new.recording_id
     or old.class_id            is distinct from new.class_id
     or old.scheduled_lesson_id is distinct from new.scheduled_lesson_id
  then
    raise exception 'Students cannot reassign a makeup submission.'
      using errcode = '42501';
  end if;

  -- Status: only allow pending → submitted (or stay equal).
  if old.status is distinct from new.status then
    if not (old.status in ('pending', 'rejected') and new.status = 'submitted') then
      raise exception 'Students may only submit (or re-submit) a makeup; current status: %, new: %',
        old.status, new.status
        using errcode = '42501';
    end if;
  end if;

  -- Reviewer fields must remain NULL when written by a student. Re-submissions
  -- intentionally clear them; that is allowed (NULL → NULL is fine).
  if new.reviewer_notes is not null
     or new.reviewed_at  is not null
     or new.reviewed_by  is not null
  then
    raise exception 'Students cannot set reviewer fields.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists makeup_submissions_enforce_writes on makeup_submissions;
create trigger makeup_submissions_enforce_writes
  before update on makeup_submissions
  for each row execute function enforce_makeup_submission_writes();
