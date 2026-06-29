-- Register/rebind a Web Push endpoint to the currently authenticated user.
--
-- Why this exists:
-- - `push_subscriptions.endpoint` is UNIQUE.
-- - Client `upsert(... onConflict: endpoint)` can hit UPDATE path if the same
--   browser endpoint already exists for a different user (shared device,
--   account switch, restored session), and then RLS blocks with 403.
--
-- This SECURITY DEFINER function provides an authenticated, auditable path that
-- atomically assigns the endpoint to auth.uid() and refreshes key material.

CREATE OR REPLACE FUNCTION register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  INSERT INTO push_subscriptions (
    user_id,
    endpoint,
    p256dh,
    auth,
    user_agent,
    last_used_at
  ) VALUES (
    auth.uid(),
    p_endpoint,
    p_p256dh,
    p_auth,
    p_user_agent,
    now()
  )
  ON CONFLICT (endpoint)
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    p256dh = EXCLUDED.p256dh,
    auth = EXCLUDED.auth,
    user_agent = EXCLUDED.user_agent,
    last_used_at = now();

  SELECT id INTO v_id
  FROM push_subscriptions
  WHERE endpoint = p_endpoint
  LIMIT 1;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION register_push_subscription(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_push_subscription(text, text, text, text) TO authenticated;
