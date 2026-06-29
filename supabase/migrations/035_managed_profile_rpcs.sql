-- ============================================================================
-- 035 — RPCs SECURITY DEFINER para perfis managed
-- ============================================================================
--
-- profiles tem RLS sem policy de INSERT (só Netlify functions com service role
-- inserem hoje, via admin-create-user). Para gerenciar perfis MANAGED diretamente
-- do cliente (sem precisar de service role / Netlify), expomos 3 RPCs SECURITY
-- DEFINER que checam role do caller antes de operar.
--
-- Apenas coordenação. Monitor não cria/edita managed nesta fase (decisão #3 do
-- doc de implementação — escopo Fase 2).

-- ── create_managed_profile ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_managed_profile(
  p_full_name text,
  p_role      user_role,
  p_phone     text DEFAULT NULL
) RETURNS profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role user_role;
  v_new_id      uuid;
  v_row         profiles;
BEGIN
  v_caller_role := get_my_role();
  IF v_caller_role IS DISTINCT FROM 'coordenacao' THEN
    RAISE EXCEPTION 'Apenas coordenação pode cadastrar perfis managed';
  END IF;

  IF p_role NOT IN ('aluno', 'professor') THEN
    RAISE EXCEPTION 'Perfis managed devem ter role aluno ou professor (recebido: %)', p_role;
  END IF;

  IF p_full_name IS NULL OR length(trim(p_full_name)) = 0 THEN
    RAISE EXCEPTION 'Nome completo é obrigatório';
  END IF;

  v_new_id := gen_random_uuid();

  INSERT INTO profiles (
    id, email, full_name, role, phone,
    must_change_password, is_managed_only,
    created_at, updated_at
  )
  VALUES (
    v_new_id,
    NULL,
    trim(p_full_name),
    p_role,
    NULLIF(trim(COALESCE(p_phone, '')), ''),
    false,
    true,
    now(),
    now()
  )
  RETURNING * INTO v_row;

  -- Audit
  INSERT INTO audit_logs (actor_id, action, entity, entity_id, details)
  VALUES (
    auth.uid(),
    'profile.managed_created',
    'profile',
    v_new_id::text,
    jsonb_build_object('full_name', v_row.full_name, 'role', v_row.role)
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_managed_profile(text, user_role, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_managed_profile(text, user_role, text) TO authenticated;

-- ── update_managed_profile ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_managed_profile(
  p_id        uuid,
  p_full_name text DEFAULT NULL,
  p_phone     text DEFAULT NULL
) RETURNS profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role user_role;
  v_target      profiles;
  v_row         profiles;
BEGIN
  v_caller_role := get_my_role();
  IF v_caller_role IS DISTINCT FROM 'coordenacao' THEN
    RAISE EXCEPTION 'Apenas coordenação pode editar perfis managed';
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil % não encontrado', p_id;
  END IF;
  IF v_target.is_managed_only = false THEN
    RAISE EXCEPTION 'update_managed_profile só opera em perfis managed (use admin endpoints para contas reais)';
  END IF;

  UPDATE profiles
     SET full_name  = COALESCE(NULLIF(trim(COALESCE(p_full_name, '')), ''), full_name),
         phone      = CASE
                         WHEN p_phone IS NULL THEN phone
                         ELSE NULLIF(trim(p_phone), '')
                       END,
         updated_at = now()
   WHERE id = p_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_managed_profile(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_managed_profile(uuid, text, text) TO authenticated;

-- ── delete_managed_profile ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_managed_profile(p_id uuid)
  RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role user_role;
  v_target      profiles;
BEGIN
  v_caller_role := get_my_role();
  IF v_caller_role IS DISTINCT FROM 'coordenacao' THEN
    RAISE EXCEPTION 'Apenas coordenação pode excluir perfis managed';
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_target.is_managed_only = false THEN
    RAISE EXCEPTION 'delete_managed_profile só opera em perfis managed (use admin endpoints para contas reais)';
  END IF;

  -- Audit antes do DELETE.
  INSERT INTO audit_logs (actor_id, action, entity, entity_id, details)
  VALUES (
    auth.uid(),
    'profile.managed_deleted',
    'profile',
    p_id::text,
    jsonb_build_object('full_name', v_target.full_name, 'role', v_target.role)
  );

  -- Cascade manual: enrollments, class_professors, class_monitors, attendance.
  -- (Não há FK CASCADE pois removemos no 034. As outras tabelas ainda têm FK
  -- para profiles.id; deletes em cascata via ON DELETE CASCADE configurado nas
  -- migrations originais.)
  DELETE FROM profiles WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_managed_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_managed_profile(uuid) TO authenticated;

-- ── RLS: permitir COORDENAÇÃO inserir profiles managed diretamente ────────
-- (defesa em profundidade — caso queira-se inserir via INSERT direto no futuro;
-- as RPCs acima são o caminho recomendado e fazem audit.)
DROP POLICY IF EXISTS "profiles_insert_managed" ON profiles;
CREATE POLICY "profiles_insert_managed" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    is_managed_only = true
    AND get_my_role() = 'coordenacao'
  );

DROP POLICY IF EXISTS "profiles_update_managed_coord" ON profiles;
CREATE POLICY "profiles_update_managed_coord" ON profiles
  FOR UPDATE TO authenticated
  USING (is_managed_only = true AND get_my_role() = 'coordenacao')
  WITH CHECK (is_managed_only = true AND get_my_role() = 'coordenacao');

DROP POLICY IF EXISTS "profiles_delete_managed_coord" ON profiles;
CREATE POLICY "profiles_delete_managed_coord" ON profiles
  FOR DELETE TO authenticated
  USING (is_managed_only = true AND get_my_role() = 'coordenacao');
