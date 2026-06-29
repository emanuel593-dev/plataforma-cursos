-- ── push_dispatch_log ───────────────────────────────────────────────────────
-- Idempotency table for server-side push dispatch (Netlify cron).
-- The cron computes a stable `event_key` per event (e.g. 'swap-incoming:<id>',
-- 'lesson-cancelled:<lesson_id>', 'lesson-reminder-30:<lesson_id>') and tries
-- to INSERT it. The PRIMARY KEY collision guarantees we only push once even
-- when the cron overlaps or runs again over the same window.
--
-- Only the service role reads/writes this table; RLS denies everything for
-- regular users.

CREATE TABLE IF NOT EXISTS push_dispatch_log (
  event_key      text PRIMARY KEY,
  dispatched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_dispatch_log_dispatched_at
  ON push_dispatch_log (dispatched_at);

ALTER TABLE push_dispatch_log ENABLE ROW LEVEL SECURITY;

-- No policy granted → ALL authenticated/anon access is denied. Only service
-- role (which bypasses RLS) can read/write.

-- ── Backfill: prevent first-run spam ────────────────────────────────────────
-- Seed dispatch keys for every event that already exists, so when the cron
-- starts it does NOT replay historical swaps / substitutions / cancellations
-- as fresh push notifications.

INSERT INTO push_dispatch_log (event_key)
SELECT 'swap-incoming:' || id FROM lesson_swap_requests WHERE status = 'pending'
ON CONFLICT DO NOTHING;

INSERT INTO push_dispatch_log (event_key)
SELECT 'swap-accepted:' || id FROM lesson_swap_requests WHERE status = 'accepted'
ON CONFLICT DO NOTHING;

INSERT INTO push_dispatch_log (event_key)
SELECT 'swap-rejected:' || id FROM lesson_swap_requests WHERE status = 'rejected'
ON CONFLICT DO NOTHING;

INSERT INTO push_dispatch_log (event_key)
SELECT 'substitution:' || id FROM lesson_assignment_history WHERE kind = 'substitution'
ON CONFLICT DO NOTHING;

INSERT INTO push_dispatch_log (event_key)
SELECT 'lesson-started:' || id FROM scheduled_lessons WHERE status = 'in_progress'
ON CONFLICT DO NOTHING;

INSERT INTO push_dispatch_log (event_key)
SELECT 'lesson-cancelled:' || id FROM scheduled_lessons WHERE status = 'cancelled'
ON CONFLICT DO NOTHING;

INSERT INTO push_dispatch_log (event_key)
SELECT 'announcement:' || id FROM announcements
ON CONFLICT DO NOTHING;
