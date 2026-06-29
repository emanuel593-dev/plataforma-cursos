BEGIN;
DO $$
DECLARE
  v_lesson_id uuid;
  v_student_id uuid;
  v_res record;
BEGIN
  SELECT scheduled_lesson_id, student_id INTO v_lesson_id, v_student_id
    FROM public.attendance
   WHERE manually_overridden = false
   LIMIT 1;

  IF v_lesson_id IS NULL THEN
    RAISE NOTICE 'No suitable row found';
    RETURN;
  END IF;

  RAISE NOTICE 'Testing with lesson % student %', v_lesson_id, v_student_id;

  -- 1. Get initial state
  SELECT status, manually_overridden, duration_seconds INTO v_res FROM attendance WHERE scheduled_lesson_id = v_lesson_id AND student_id = v_student_id;
  RAISE NOTICE 'Initial state: status=%, override=%, duration=%', v_res.status, v_res.manually_overridden, v_res.duration_seconds;

  -- 2. Apply override
  PERFORM public.attendance_upsert_with_key(v_lesson_id, v_student_id, gen_random_uuid(), 'present', v_student_id, null, null, true);

  -- 3. Get state 2
  SELECT status, manually_overridden, duration_seconds INTO v_res FROM attendance WHERE scheduled_lesson_id = v_lesson_id AND student_id = v_student_id;
  RAISE NOTICE 'State after override: status=%, override=%, duration=%', v_res.status, v_res.manually_overridden, v_res.duration_seconds;

  -- 4. Apply next flush
  PERFORM public.attendance_increment_duration(v_lesson_id, v_student_id, 10, 0, 0, null, null, null, null, null, gen_random_uuid(), 3);

  -- 5. Get state 3
  SELECT status, manually_overridden, duration_seconds INTO v_res FROM attendance WHERE scheduled_lesson_id = v_lesson_id AND student_id = v_student_id;
  RAISE NOTICE 'State after flush: status=%, override=%, duration=%', v_res.status, v_res.manually_overridden, v_res.duration_seconds;
END;
$$;
ROLLBACK;
