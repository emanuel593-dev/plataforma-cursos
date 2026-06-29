BEGIN;
DO $$
DECLARE
  v_lesson_id uuid;
  v_student_id uuid;
  v_res record;
  v_count int;
BEGIN
  -- We'll use service_role to avoid auth issues in this test script
  SELECT scheduled_lesson_id, student_id INTO v_lesson_id, v_student_id
    FROM public.attendance
   WHERE manually_overridden = false
   LIMIT 1;

  IF v_lesson_id IS NULL THEN
    RAISE NOTICE 'No suitable row found';
    RETURN;
  END IF;

  RAISE NOTICE 'Testing UPSERT with lesson %, student %', v_lesson_id, v_student_id;

  -- 1. Initial state
  SELECT status, manually_overridden INTO v_res FROM attendance WHERE scheduled_lesson_id = v_lesson_id AND student_id = v_student_id;
  RAISE NOTICE 'Initial: status=%, override=%', v_res.status, v_res.manually_overridden;

  -- 2. Simulate upsertAttendance
  INSERT INTO public.attendance (scheduled_lesson_id, student_id, status, marked_by, manually_overridden, notes)
  VALUES (v_lesson_id, v_student_id, 'present', v_student_id, true, null)
  ON CONFLICT (scheduled_lesson_id, student_id) DO UPDATE SET
    status = EXCLUDED.status,
    marked_by = EXCLUDED.marked_by,
    manually_overridden = EXCLUDED.manually_overridden,
    notes = EXCLUDED.notes;

  -- 3. Check State 2
  SELECT status, manually_overridden INTO v_res FROM attendance WHERE scheduled_lesson_id = v_lesson_id AND student_id = v_student_id;
  RAISE NOTICE 'After UPSERT: status=%, override=%', v_res.status, v_res.manually_overridden;

  -- 4. Simulate flush
  PERFORM public.attendance_increment_duration(v_lesson_id, v_student_id, 10, 0, 0, null, null, null, null, null, gen_random_uuid(), 3);

  -- 5. Check State 3
  SELECT status, manually_overridden INTO v_res FROM attendance WHERE scheduled_lesson_id = v_lesson_id AND student_id = v_student_id;
  RAISE NOTICE 'After flush: status=%, override=%', v_res.status, v_res.manually_overridden;
END;
$$;
ROLLBACK;
