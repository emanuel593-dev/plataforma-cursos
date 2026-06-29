import { supabase } from './supabase';

/**
 * Returns headers including the current Supabase JWT for calling our Netlify
 * functions. If there is no session (anonymous user), returns plain headers
 * — the function endpoint will reject with 401.
 */
export async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    ...(extra ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
