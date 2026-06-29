-- ─────────────────────────────────────────────────────────────────────────────
-- 016: Class Recording Metadata
--
-- Actual video bytes live in Google Drive (professor's personal account, 5 TB).
-- Supabase stores ONLY metadata: title, duration, GDrive file/folder IDs, status.
-- This keeps Supabase storage at zero cost regardless of recording size.
--
-- Access model:
--   - The recording professor (recorded_by) has full access to their recordings.
--   - Coordenacao can see all recordings.
--   - Active students of the class can watch (view link only — no edit/delete).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Google Drive OAuth tokens (per-professor, personal GDrive access) ────────
create table if not exists user_gdrive_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  access_token   text        not null,
  refresh_token  text        not null,
  expires_at     bigint      not null,  -- epoch ms
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table user_gdrive_tokens enable row level security;

-- Each user can only read/write their own tokens.
create policy "gdrive_tokens_own"
  on user_gdrive_tokens for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Recordings metadata ───────────────────────────────────────────────────────
create table if not exists recordings (
  id               uuid        primary key default gen_random_uuid(),
  scheduled_lesson_id uuid     references scheduled_lessons(id) on delete set null,
  class_id         uuid        references classes(id) on delete set null,
  recorded_by      uuid        not null references auth.users(id) on delete cascade,

  -- Google Drive identifiers
  gdrive_file_id   text        not null,
  gdrive_view_link text,            -- webViewLink from Drive API
  gdrive_folder_id text,            -- parent folder ID in Drive

  -- Human-readable metadata
  title            text        not null default '',
  duration_s       integer,         -- total seconds
  size_bytes       bigint,
  mime_type        text        not null default 'video/webm',

  -- Lifecycle: recording → uploading → ready | error
  status           text        not null default 'uploading'
                   check (status in ('recording', 'uploading', 'ready', 'error')),
  error_message    text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Keep updated_at current automatically
create or replace function recordings_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger recordings_updated_at
  before update on recordings
  for each row execute function recordings_set_updated_at();

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists recordings_lesson_idx   on recordings(scheduled_lesson_id);
create index if not exists recordings_class_idx    on recordings(class_id);
create index if not exists recordings_author_idx   on recordings(recorded_by);
create index if not exists recordings_status_idx   on recordings(status);
create index if not exists recordings_created_idx  on recordings(created_at desc);

-- ── Row-Level Security ────────────────────────────────────────────────────────
alter table recordings enable row level security;

-- SELECT: author | coordenacao | professor | enrolled active student of the class
create policy "recordings_select"
  on recordings for select
  using (
    auth.uid() = recorded_by
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('coordenacao', 'professor')
    )
    or (
      class_id is not null
      and exists (
        select 1 from enrollments e
        where e.class_id = recordings.class_id
          and e.student_id = auth.uid()
          and e.status = 'active'
      )
    )
  );

-- INSERT: only the authenticated professor (recorded_by must match caller)
create policy "recordings_insert"
  on recordings for insert
  with check (auth.uid() = recorded_by);

-- UPDATE: only the author (status/error_message updates during upload lifecycle)
create policy "recordings_update"
  on recordings for update
  using (auth.uid() = recorded_by);

-- DELETE: author or coordenacao
create policy "recordings_delete"
  on recordings for delete
  using (
    auth.uid() = recorded_by
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role = 'coordenacao'
    )
  );
