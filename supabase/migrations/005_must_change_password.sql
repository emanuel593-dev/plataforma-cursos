-- ── Add must_change_password flag to profiles ────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
