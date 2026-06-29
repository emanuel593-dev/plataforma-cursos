-- ============================================================================
-- 034 — Modalidades (online / presencial / híbrida) + perfis "managed only"
-- ============================================================================
--
-- Documento: docs/IMPLEMENTACAO_MODALIDADES.md
--
-- Objetivos:
--   1. Introduzir o enum class_modality e a coluna modality em classes e
--      scheduled_lessons (override por aula em turmas híbridas).
--   2. Permitir perfis "managed only" — alunos/professores presenciais
--      cadastrados pela coordenação SEM auth.users (sem login, sem push).
--   3. Validar que turmas presenciais/híbridas tenham ao menos 1 professor
--      vinculado. Monitor permanece opcional.
--   4. Blindar os triggers de presença automática (mig 031/033) contra rodar
--      em aulas presenciais — cinto + suspensório do manually_overridden.
--
-- Idempotente: ALTER TABLE ... ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
-- DO blocks para CREATE TYPE.

-- ── 1. Enum class_modality ────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'class_modality') THEN
    CREATE TYPE class_modality AS ENUM ('online', 'presencial', 'hibrida');
  END IF;
END $$;

-- ── 2. Colunas em classes ─────────────────────────────────────────────────
ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS modality class_modality NOT NULL DEFAULT 'online',
  ADD COLUMN IF NOT EXISTS location text NULL;

COMMENT ON COLUMN classes.modality IS
  'Modalidade padrão da turma. Aulas individuais podem sobrescrever via '
  'scheduled_lessons.modality (apenas em turmas hibridas).';

COMMENT ON COLUMN classes.location IS
  'Local físico (sala, endereço) para turmas presencial/hibrida. NULL em online.';

-- ── 3. Coluna em scheduled_lessons (override por aula) ────────────────────
ALTER TABLE scheduled_lessons
  ADD COLUMN IF NOT EXISTS modality class_modality NULL;

COMMENT ON COLUMN scheduled_lessons.modality IS
  'Override da modalidade desta aula (apenas em turmas hibridas). NULL = '
  'herda de classes.modality. Em turma online ou presencial pura, este '
  'campo deve ficar NULL.';

CREATE INDEX IF NOT EXISTS idx_scheduled_lessons_modality_override
  ON scheduled_lessons (class_id, scheduled_at)
  WHERE modality IS NOT NULL;

-- ── 4. Helper: modalidade efetiva da aula ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.effective_lesson_modality(p_lesson_id uuid)
  RETURNS class_modality
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(sl.modality, c.modality)
    FROM scheduled_lessons sl
    JOIN classes c ON c.id = sl.class_id
   WHERE sl.id = p_lesson_id;
$$;

COMMENT ON FUNCTION public.effective_lesson_modality IS
  'Retorna a modalidade efetiva de uma aula (override > padrão da turma).';

-- ── 5. Perfis "managed only" ──────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_managed_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.is_managed_only IS
  'Quando true, este perfil NÃO tem auth.users correspondente — é apenas um '
  'registro de gestão (aluno/professor presencial). Não loga, não recebe push.';

-- Email passa a ser nullable para suportar managed (sem email obrigatório).
-- Para usuários reais (is_managed_only=false), validamos via trigger abaixo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'profiles'
       AND column_name = 'email'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE profiles ALTER COLUMN email DROP NOT NULL;
  END IF;
END $$;

-- ── 6. Remover FK profiles.id → auth.users.id ─────────────────────────────
-- Por que? Perfis managed não têm linha em auth.users. A FK ON DELETE CASCADE
-- continua sendo necessária para usuários REAIS, mas vamos reproduzí-la via
-- trigger em auth.users (passo 7) para preservar o comportamento antigo
-- enquanto liberamos a inserção de managed.

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT tc.constraint_name INTO v_constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
   WHERE tc.table_schema = 'public'
     AND tc.table_name   = 'profiles'
     AND tc.constraint_type = 'FOREIGN KEY'
     AND kcu.column_name = 'id'
   LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

-- ── 7. Trigger: validar link auth para perfis NÃO-managed ─────────────────
CREATE OR REPLACE FUNCTION public.profiles_validate_auth_link() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Managed: aceita sem auth.users e sem email.
  IF NEW.is_managed_only = true THEN
    RETURN NEW;
  END IF;

  -- Real: exige auth.users correspondente E email NOT NULL.
  IF NEW.email IS NULL THEN
    RAISE EXCEPTION 'Perfil real (is_managed_only=false) requer email';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'Perfil real (is_managed_only=false) requer auth.users com mesmo id (%)', NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_validate_auth_link_trg ON profiles;
CREATE TRIGGER profiles_validate_auth_link_trg
  BEFORE INSERT OR UPDATE OF id, is_managed_only, email ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_validate_auth_link();

-- ── 8. Trigger: cascade DELETE de auth.users → profiles ───────────────────
-- Reproduz o comportamento da FK removida no passo 6, mas só para perfis
-- reais (managed nunca é apagado via cascade pois nem está em auth).
CREATE OR REPLACE FUNCTION public.auth_user_cascade_delete_profile() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.profiles
   WHERE id = OLD.id
     AND is_managed_only = false;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS auth_user_cascade_delete_profile_trg ON auth.users;
CREATE TRIGGER auth_user_cascade_delete_profile_trg
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auth_user_cascade_delete_profile();

-- ── 9. handle_new_user: idempotente (suporta promoção managed → real) ─────
-- Promover um managed cria auth.users com o MESMO UUID do profile existente.
-- O trigger on_auth_user_created (mig 001) tentava INSERT puro → conflict.
-- Agora ON CONFLICT atualiza email/role mas NÃO mexe em managed=true (que
-- vira false só via UPDATE explícito do service).
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  SET search_path = public;
  INSERT INTO public.profiles (id, email, full_name, role, is_managed_only)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'role', '')::public.user_role,
      'aluno'::public.user_role
    ),
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    -- Promoção: managed=true vira false; full_name/role preservados se já
    -- preenchidos pela coordenação.
    is_managed_only = false,
    full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
    role      = COALESCE(public.profiles.role, EXCLUDED.role);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 10. Validação: turma presencial/hibrida exige ≥1 professor ────────────
CREATE OR REPLACE FUNCTION public.classes_validate_required_professor() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_modality class_modality;
  v_class_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'classes' THEN
    v_class_id := NEW.id;
    v_modality := NEW.modality;
  ELSIF TG_OP = 'DELETE' THEN
    v_class_id := OLD.class_id;
    SELECT modality INTO v_modality FROM classes WHERE id = v_class_id;
  ELSE
    v_class_id := NEW.class_id;
    SELECT modality INTO v_modality FROM classes WHERE id = v_class_id;
  END IF;

  IF v_modality IS NULL OR v_modality = 'online' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM class_professors WHERE class_id = v_class_id
  ) THEN
    RAISE EXCEPTION
      'Turma % (modalidade %) requer ao menos 1 professor vinculado.',
      v_class_id, v_modality;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Trigger DEFERRABLE INITIALLY DEFERRED em classes para permitir o caso
-- normal: INSERT classes + INSERT class_professors na mesma transação.
DROP TRIGGER IF EXISTS classes_require_professor_trg ON classes;
CREATE CONSTRAINT TRIGGER classes_require_professor_trg
  AFTER INSERT OR UPDATE OF modality ON classes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.classes_validate_required_professor();

-- Em DELETE de class_professors: validar imediatamente (não pode ficar zero).
DROP TRIGGER IF EXISTS class_professors_require_one_trg ON class_professors;
CREATE TRIGGER class_professors_require_one_trg
  AFTER DELETE ON class_professors
  FOR EACH ROW EXECUTE FUNCTION public.classes_validate_required_professor();

-- ── 11. Guards nos triggers de presença automática (mig 031/033) ──────────
-- Em aulas presenciais NUNCA roda recompute automático: status é sempre
-- decisão humana (monitor/coordenação). Já há proteção via manually_overridden,
-- mas blindamos por modalidade também (cinto+suspensório).

CREATE OR REPLACE FUNCTION public.attendance_recompute_one() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_started      timestamptz;
  v_ended        timestamptz;
  v_duration_min int;
  v_eff          int;
  v_status       attendance_status;
  v_notes        text;
  v_modality     class_modality;
BEGIN
  -- Override manual: respeitamos a decisão humana.
  IF NEW.manually_overridden THEN
    RETURN NEW;
  END IF;

  -- FJ é decisão humana.
  IF NEW.status = 'justified' THEN
    RETURN NEW;
  END IF;

  -- Modalidade efetiva da aula. Em presencial, status sempre manual.
  v_modality := public.effective_lesson_modality(NEW.scheduled_lesson_id);
  IF v_modality = 'presencial' THEN
    RETURN NEW;
  END IF;

  SELECT started_at, ended_at, duration_minutes
    INTO v_started, v_ended, v_duration_min
    FROM scheduled_lessons
   WHERE id = NEW.scheduled_lesson_id;

  IF v_started IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_ended IS NOT NULL THEN
    v_eff := EXTRACT(EPOCH FROM (v_ended - v_started))::int;
  ELSE
    v_eff := COALESCE(v_duration_min, 0) * 60;
  END IF;

  SELECT cas.out_status, cas.out_notes
    INTO v_status, v_notes
    FROM public.compute_attendance_status(
      COALESCE(NEW.duration_seconds, 0),
      COALESCE(NEW.verified_checks, 0),
      COALESCE(NEW.total_checks, 0),
      v_eff
    ) AS cas;

  NEW.status := v_status;
  NEW.notes  := v_notes;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.lesson_recompute_attendance() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_modality class_modality;
BEGIN
  -- Em aulas presenciais não há recompute automático.
  v_modality := COALESCE(NEW.modality, (SELECT modality FROM classes WHERE id = NEW.class_id));
  IF v_modality = 'presencial' THEN
    RETURN NEW;
  END IF;

  IF (OLD.started_at      IS DISTINCT FROM NEW.started_at)
  OR (OLD.ended_at        IS DISTINCT FROM NEW.ended_at)
  OR (OLD.duration_minutes IS DISTINCT FROM NEW.duration_minutes) THEN
    UPDATE attendance
       SET duration_seconds = duration_seconds
     WHERE scheduled_lesson_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_log_auto_absent() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_modality class_modality;
BEGIN
  -- Em presencial não existe "auto absent" — toda mudança é decisão humana.
  v_modality := public.effective_lesson_modality(NEW.scheduled_lesson_id);
  IF v_modality = 'presencial' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'absent'
     AND NEW.manually_overridden = false
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND OLD.status = 'present' THEN
    INSERT INTO audit_logs (actor_id, action, entity, entity_id, details)
    VALUES (
      NEW.marked_by,
      'attendance.auto_absent',
      'attendance',
      NEW.id::text,
      jsonb_build_object(
        'student_id', NEW.student_id,
        'scheduled_lesson_id', NEW.scheduled_lesson_id,
        'duration_seconds', NEW.duration_seconds,
        'verified_checks', NEW.verified_checks,
        'total_checks', NEW.total_checks,
        'notes', NEW.notes
      )
    );
  END IF;
  RETURN NEW;
END;
$$;
