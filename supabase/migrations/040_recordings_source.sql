-- ─────────────────────────────────────────────────────────────────────────────
-- 040: recordings — add source column
--
-- Distinguishes recordings captured natively by the platform
-- (MediaRecorder → resumable Drive upload) from recordings registered
-- manually (e.g. a Google Meet session recorded externally and linked
-- retroactively by a coordinator).
--
-- The DEFAULT 'platform' covers all existing rows without data migration.
-- ─────────────────────────────────────────────────────────────────────────────

alter table recordings
  add column if not exists source text not null default 'platform'
    constraint recordings_source_check check (source in ('platform', 'external'));

comment on column recordings.source is
  'Origin of the recording: platform = captured by the app via MediaRecorder, '
  'external = registered manually (e.g. Google Meet, Zoom, OBS).';
