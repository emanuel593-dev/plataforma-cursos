-- ============================================================================
-- IV Platform — Initial Schema
-- LMS Education Platform — Plataforma de Ensino
-- ============================================================================

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('coordenacao', 'professor', 'aluno');
CREATE TYPE enrollment_status AS ENUM ('active', 'completed', 'dropped');
CREATE TYPE class_status AS ENUM ('active', 'completed', 'cancelled');
CREATE TYPE lesson_status AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');
CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'justified');

-- ── Tables ───────────────────────────────────────────────────────────────────

-- profiles: synced with auth.users via trigger
CREATE TABLE profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  full_name   text NOT NULL,
  avatar_url  text,
  role        user_role NOT NULL DEFAULT 'aluno',
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- modules: course modules (1°, 2°, 3°)
CREATE TABLE modules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  color       text NOT NULL,
  order_index int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- lessons: lesson templates within a module
CREATE TABLE lessons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id   uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  order_index int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- classes: course instances (turma = module + professor + students)
CREATE TABLE classes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  module_id     uuid NOT NULL REFERENCES modules(id),
  professor_id  uuid REFERENCES profiles(id),
  status        class_status NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- enrollments: student ↔ class binding
CREATE TABLE enrollments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES profiles(id),
  status      enrollment_status NOT NULL DEFAULT 'active',
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, student_id)
);

-- scheduled_lessons: calendar entries
CREATE TABLE scheduled_lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lesson_id        uuid REFERENCES lessons(id),
  scheduled_at     timestamptz NOT NULL,
  duration_minutes int NOT NULL DEFAULT 60,
  room_id          text,
  status           lesson_status NOT NULL DEFAULT 'scheduled',
  started_at       timestamptz,
  ended_at         timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- attendance: per-student per-scheduled-lesson
CREATE TABLE attendance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_lesson_id  uuid NOT NULL REFERENCES scheduled_lessons(id) ON DELETE CASCADE,
  student_id           uuid NOT NULL REFERENCES profiles(id),
  status               attendance_status NOT NULL DEFAULT 'absent',
  joined_at            timestamptz,
  left_at              timestamptz,
  duration_seconds     int,
  marked_by            uuid REFERENCES profiles(id),
  notes                text,
  verified_checks      int NOT NULL DEFAULT 0,
  total_checks         int NOT NULL DEFAULT 0,
  UNIQUE (scheduled_lesson_id, student_id)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX idx_lessons_module          ON lessons(module_id);
CREATE INDEX idx_classes_module          ON classes(module_id);
CREATE INDEX idx_classes_professor       ON classes(professor_id);
CREATE INDEX idx_enrollments_class       ON enrollments(class_id);
CREATE INDEX idx_enrollments_student     ON enrollments(student_id);
CREATE INDEX idx_scheduled_lessons_class ON scheduled_lessons(class_id);
CREATE INDEX idx_scheduled_lessons_date  ON scheduled_lessons(scheduled_at);
CREATE INDEX idx_attendance_lesson       ON attendance(scheduled_lesson_id);
CREATE INDEX idx_attendance_student      ON attendance(student_id);

-- ── Updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Auth trigger: auto-create profile on signup ──────────────────────────────

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  SET search_path = public;
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'role', '')::public.user_role,
      'aluno'::public.user_role
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── Helper: get current user role ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_my_role()
RETURNS user_role AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ── RLS: Enable on all tables ────────────────────────────────────────────────

ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lessons           ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance        ENABLE ROW LEVEL SECURITY;

-- ── RLS: profiles ────────────────────────────────────────────────────────────

CREATE POLICY "profiles_select" ON profiles
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR get_my_role() = 'coordenacao')
  WITH CHECK (id = auth.uid() OR get_my_role() = 'coordenacao');

-- ── RLS: modules ─────────────────────────────────────────────────────────────

CREATE POLICY "modules_select" ON modules
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "modules_insert" ON modules
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "modules_update" ON modules
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'coordenacao')
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "modules_delete" ON modules
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- ── RLS: lessons ─────────────────────────────────────────────────────────────

CREATE POLICY "lessons_select" ON lessons
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "lessons_insert" ON lessons
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "lessons_update" ON lessons
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'coordenacao')
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "lessons_delete" ON lessons
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- ── RLS: classes ─────────────────────────────────────────────────────────────

CREATE POLICY "classes_select" ON classes
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "classes_insert" ON classes
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "classes_update" ON classes
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'coordenacao')
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "classes_delete" ON classes
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- ── RLS: enrollments ─────────────────────────────────────────────────────────

CREATE POLICY "enrollments_select" ON enrollments
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = enrollments.class_id AND c.professor_id = auth.uid()
    )
  );

CREATE POLICY "enrollments_insert" ON enrollments
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "enrollments_update" ON enrollments
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'coordenacao')
  WITH CHECK (get_my_role() = 'coordenacao');

CREATE POLICY "enrollments_delete" ON enrollments
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- ── RLS: scheduled_lessons ───────────────────────────────────────────────────

CREATE POLICY "scheduled_lessons_select" ON scheduled_lessons
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = scheduled_lessons.class_id AND c.professor_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.class_id = scheduled_lessons.class_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
  );

CREATE POLICY "scheduled_lessons_insert" ON scheduled_lessons
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = scheduled_lessons.class_id AND c.professor_id = auth.uid()
    )
  );

CREATE POLICY "scheduled_lessons_update" ON scheduled_lessons
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = scheduled_lessons.class_id AND c.professor_id = auth.uid()
    )
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = scheduled_lessons.class_id AND c.professor_id = auth.uid()
    )
  );

CREATE POLICY "scheduled_lessons_delete" ON scheduled_lessons
  FOR DELETE TO authenticated
  USING (get_my_role() = 'coordenacao');

-- ── RLS: attendance ──────────────────────────────────────────────────────────

CREATE POLICY "attendance_select" ON attendance
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      JOIN classes c ON c.id = sl.class_id
      WHERE sl.id = attendance.scheduled_lesson_id
        AND c.professor_id = auth.uid()
    )
  );

CREATE POLICY "attendance_insert" ON attendance
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      JOIN classes c ON c.id = sl.class_id
      WHERE sl.id = attendance.scheduled_lesson_id
        AND c.professor_id = auth.uid()
    )
  );

CREATE POLICY "attendance_update" ON attendance
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      JOIN classes c ON c.id = sl.class_id
      WHERE sl.id = attendance.scheduled_lesson_id
        AND c.professor_id = auth.uid()
    )
  )
  WITH CHECK (
    get_my_role() = 'coordenacao'
    OR student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM scheduled_lessons sl
      JOIN classes c ON c.id = sl.class_id
      WHERE sl.id = attendance.scheduled_lesson_id
        AND c.professor_id = auth.uid()
    )
  );
