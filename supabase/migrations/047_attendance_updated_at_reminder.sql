-- ============================================================================
-- 047 — Attendance updated_at + reminder cooldown
-- ============================================================================

-- Add a standard updated_at column so the attendance_upsert_with_key RPC can
-- update attendance rows safely without failing on tables that do not expose
-- generated timestamp columns.
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz;

-- Ensure the shared update_updated_at trigger is installed on attendance.
DROP TRIGGER IF EXISTS attendance_updated_at ON attendance;
CREATE TRIGGER attendance_updated_at
  BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON COLUMN attendance.updated_at IS
  'Timestamp of the last modification made to the attendance row.';

COMMENT ON COLUMN attendance.last_reminder_sent_at IS
  'When the last manual makeup reminder push was sent to the student.';
