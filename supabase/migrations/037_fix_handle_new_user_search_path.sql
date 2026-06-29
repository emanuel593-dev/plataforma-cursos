-- ============================================================================
-- 037 — Fix handle_new_user: session-scoped SET search_path breaks GoTrue
-- ============================================================================
-- Root cause: handle_new_user() contains `SET search_path = public` in the
-- function body. This is a SESSION-LEVEL SET that persists after the trigger
-- function returns. supabase_auth_admin has search_path=auth configured at
-- the role level, so GoTrue queries tables like `identities` (unqualified).
-- After handle_new_user fires and sets search_path=public, GoTrue's next
-- query (`INSERT INTO identities ...`) fails with:
--   ERROR: relation "identities" does not exist
-- which GoTrue surfaces as HTTP 500 "Database error creating new user".
--
-- Fix: move search_path into the CREATE FUNCTION SET clause (proconfig),
-- which PostgreSQL automatically restores after the function exits.
-- Remove the manual SET from the function body.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public          -- auto-restores after function exits
AS $$
BEGIN
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
    email          = EXCLUDED.email,
    -- Promoção: managed=true vira false; full_name/role preservados se já
    -- preenchidos pela coordenação.
    is_managed_only = false,
    full_name      = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
    role           = COALESCE(public.profiles.role, EXCLUDED.role);
  RETURN NEW;
END;
$$;
