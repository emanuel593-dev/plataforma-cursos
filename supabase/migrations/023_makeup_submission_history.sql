-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 023_makeup_submission_history                                             ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Append-only audit trail for `makeup_submissions`. Enables coordenação to  ║
-- ║ see the full lifecycle of a reposição (assistida → enviada → aprovada/   ║
-- ║ reprovada → reenviada → ...) without losing prior reviewer feedback when  ║
-- ║ the student re-submits and the live row is reset.                         ║
-- ║                                                                           ║
-- ║ Events inferred from row deltas:                                          ║
-- ║   • created      — first INSERT (submission row exists, status pending)   ║
-- ║   • watched      — watched_at transitioned NULL → not NULL                ║
-- ║   • submitted    — status pending → submitted                             ║
-- ║   • resubmitted  — status rejected → submitted                            ║
-- ║   • approved     — status * → approved                                    ║
-- ║   • rejected     — status * → rejected                                    ║
-- ║                                                                           ║
-- ║ The 'expired' event is written by the cron function                       ║
-- ║ `expire-makeup-deadlines` directly via SQL insert (service role).         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists makeup_submission_history (
  id            uuid        primary key default gen_random_uuid(),
  submission_id uuid        not null references makeup_submissions(id) on delete cascade,
  event         text        not null check (event in (
                  'created','watched','submitted','resubmitted',
                  'approved','rejected','expired'
                )),
  at            timestamptz not null default now(),
  actor_id      uuid        references profiles(id) on delete set null,
  -- Snapshot of relevant fields at the moment the event happened
  payload       jsonb       not null default '{}'::jsonb
);

create index if not exists makeup_history_submission_idx
  on makeup_submission_history(submission_id, at desc);

create index if not exists makeup_history_event_idx
  on makeup_submission_history(event);

-- ── Trigger: write history rows from row deltas ──────────────────────────────
create or replace function record_makeup_submission_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- INSERT
  if tg_op = 'INSERT' then
    insert into makeup_submission_history (submission_id, event, actor_id, payload)
    values (
      new.id, 'created', auth.uid(),
      jsonb_build_object(
        'status', new.status,
        'recording_id', new.recording_id,
        'class_id', new.class_id,
        'scheduled_lesson_id', new.scheduled_lesson_id
      )
    );
    return new;
  end if;

  -- UPDATE: emit one event per meaningful delta. Multiple events can fire
  -- on the same UPDATE (e.g. student watches and immediately submits).
  if tg_op = 'UPDATE' then
    if old.watched_at is null and new.watched_at is not null then
      insert into makeup_submission_history (submission_id, event, actor_id, payload)
      values (new.id, 'watched', auth.uid(), jsonb_build_object('at', new.watched_at));
    end if;

    if old.status is distinct from new.status then
      if new.status = 'submitted' and old.status = 'pending' then
        insert into makeup_submission_history (submission_id, event, actor_id, payload)
        values (
          new.id, 'submitted', auth.uid(),
          jsonb_build_object('summary_length', coalesce(length(new.summary), 0))
        );
      elsif new.status = 'submitted' and old.status = 'rejected' then
        insert into makeup_submission_history (submission_id, event, actor_id, payload)
        values (
          new.id, 'resubmitted', auth.uid(),
          jsonb_build_object(
            'summary_length',           coalesce(length(new.summary), 0),
            'previous_reviewer_notes',  old.reviewer_notes,
            'previous_reviewed_by',     old.reviewed_by
          )
        );
      elsif new.status = 'approved' then
        insert into makeup_submission_history (submission_id, event, actor_id, payload)
        values (
          new.id, 'approved', auth.uid(),
          jsonb_build_object(
            'reviewer_notes', new.reviewer_notes,
            'reviewed_by',    new.reviewed_by
          )
        );
      elsif new.status = 'rejected' then
        insert into makeup_submission_history (submission_id, event, actor_id, payload)
        values (
          new.id, 'rejected', auth.uid(),
          jsonb_build_object(
            'reviewer_notes', new.reviewer_notes,
            'reviewed_by',    new.reviewed_by
          )
        );
      end if;
    end if;
    return new;
  end if;

  return null;
end;
$$;

drop trigger if exists makeup_submissions_history_aiu on makeup_submissions;
create trigger makeup_submissions_history_aiu
  after insert or update on makeup_submissions
  for each row execute function record_makeup_submission_event();

-- ── RLS: students see their own history; staff sees their classes ────────────
alter table makeup_submission_history enable row level security;

create policy "makeup_history_student_select"
  on makeup_submission_history for select
  using (
    exists (
      select 1 from makeup_submissions ms
       where ms.id         = makeup_submission_history.submission_id
         and ms.student_id = auth.uid()
    )
  );

create policy "makeup_history_staff_select"
  on makeup_submission_history for select
  using (
    exists (
      select 1 from profiles p
       where p.id   = auth.uid()
         and p.role = 'coordenacao'
    )
    or exists (
      select 1
        from makeup_submissions ms
        join class_professors cp on cp.class_id = ms.class_id
       where ms.id              = makeup_submission_history.submission_id
         and cp.professor_id    = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies: only the trigger (security definer) and
-- service-role cron jobs can write to this table. Append-only by design.
