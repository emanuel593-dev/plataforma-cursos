-- Add missing title column to lesson_reports
-- The TS type and ClassroomView already send this field on report creation

ALTER TABLE lesson_reports
  ADD COLUMN IF NOT EXISTS title text;
