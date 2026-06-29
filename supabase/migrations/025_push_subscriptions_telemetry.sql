-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 025_push_subscriptions_telemetry                                          ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Adds delivery telemetry to push_subscriptions so the client can decide    ║
-- ║ whether to fall back to a local in-app notification when the server-side  ║
-- ║ push channel appears to be silently failing.                              ║
-- ║                                                                           ║
-- ║   • last_delivery_at  — timestamp of the most recent successful           ║
-- ║                         webpush.sendNotification() for this row.          ║
-- ║   • last_failure_at   — timestamp of the most recent non-410 failure.     ║
-- ║                                                                           ║
-- ║ The client reads these via PostgREST and, if a subscription exists but   ║
-- ║ has never delivered (or last_delivery_at is older than ~30 minutes after ║
-- ║ a recent failure), it dispatches the OS toast locally as a safety net.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table push_subscriptions
  add column if not exists last_delivery_at timestamptz,
  add column if not exists last_failure_at  timestamptz;

create index if not exists idx_push_subscriptions_user_delivery
  on push_subscriptions(user_id, last_delivery_at desc nulls last);
