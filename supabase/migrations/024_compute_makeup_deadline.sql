-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 024_compute_makeup_deadline                                               ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Single source of truth for the FJ → makeup deadline calculation.          ║
-- ║                                                                           ║
-- ║ Rule: deadline = (scheduled_at of the NEXT non-cancelled lesson of the    ║
-- ║ same class, strictly after the absent one) - 24 hours.                    ║
-- ║                                                                           ║
-- ║ Returns NULL when there is no next lesson (last class of the term, etc.). ║
-- ║                                                                           ║
-- ║ Previously this lived only in `attendance.service.ts:markJustified`.      ║
-- ║ Centralising here lets both the UI (via RPC) and future server-side       ║
-- ║ jobs (cron, triggers) compute the same value, eliminating drift.          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create or replace function compute_makeup_deadline(p_scheduled_lesson_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  with anchor as (
    select class_id, scheduled_at
      from scheduled_lessons
     where id = p_scheduled_lesson_id
  ),
  next_lesson as (
    select sl.scheduled_at
      from scheduled_lessons sl
      join anchor a on a.class_id = sl.class_id
     where sl.scheduled_at > a.scheduled_at
       and sl.status      <> 'cancelled'
     order by sl.scheduled_at asc
     limit 1
  )
  select (scheduled_at - interval '24 hours') from next_lesson;
$$;

-- Allow authenticated clients (and the service role) to invoke the function.
grant execute on function compute_makeup_deadline(uuid) to authenticated, service_role;
