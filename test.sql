BEGIN;
SELECT 'Initial Setup';
INSERT INTO public.profiles (id, full_name, role) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Student', 'aluno') ON CONFLICT DO NOTHING;
INSERT INTO public.classes (id, name, modality) VALUES ('22222222-2222-2222-2222-222222222222', 'Test Class', 'online') ON CONFLICT DO NOTHING;
INSERT INTO public.scheduled_lessons (id, class_id, scheduled_at, duration_minutes, started_at) VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', now(), 60, now()) ON CONFLICT DO NOTHING;
DELETE FROM public.attendance WHERE student_id = '11111111-1111-1111-1111-111111111111';

SELECT '1. Initial flush';
SELECT public.attendance_increment_duration('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 10, 0, 0, null, now(), null, null, null, '44444444-4444-4444-4444-444444444444', 3);

SELECT 'State 1:';
SELECT status, manually_overridden, duration_seconds FROM public.attendance WHERE student_id = '11111111-1111-1111-1111-111111111111';

SELECT '2. Manual Override (Monitor clicks P)';
SELECT public.attendance_upsert_with_key('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'present', null, null, null, true);

SELECT 'State 2:';
SELECT status, manually_overridden, duration_seconds FROM public.attendance WHERE student_id = '11111111-1111-1111-1111-111111111111';

SELECT '3. Second flush (Student is still in the room)';
SELECT public.attendance_increment_duration('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 10, 0, 0, null, null, null, null, null, '66666666-6666-6666-6666-666666666666', 3);

SELECT 'State 3:';
SELECT status, manually_overridden, duration_seconds FROM public.attendance WHERE student_id = '11111111-1111-1111-1111-111111111111';
ROLLBACK;
