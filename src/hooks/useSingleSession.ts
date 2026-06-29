import { useEffect } from 'react';
import { supabase } from '../lib/supabase';

/** Single-session enforcement via Supabase Realtime broadcast.
 *
 *  Substitui a feature `sessions_single_per_user` do Supabase Auth (que é Pro
 *  plan). Estratégia:
 *
 *   1. Cada sessão (browser tab) gera um `sessionId` único + `claimedAt` ms.
 *   2. Ao montar com user logado, conecta no canal `user-session:{userId}` e
 *      faz broadcast `claim` anunciando-se.
 *   3. Outras tabs/dispositivos do MESMO user recebem o broadcast. Se o
 *      `claimedAt` recebido é MAIS NOVO que o próprio, fazem signOut imediato.
 *   4. Latência típica de Realtime broadcast: ~200-800 ms. Bem menor que
 *      esperar TTL do JWT (15 min após mig de hoje).
 *
 *  Limitações conhecidas:
 *   - Se o segundo device estiver offline, só é derrubado quando reconectar
 *     ao Realtime. Suficiente para nosso caso (não há valor em entrar na sala
 *     totalmente offline).
 *   - Sessões antigas que abrem o app e ainda não receberam o broadcast podem
 *     fazer 1 ou 2 chamadas autenticadas. Aceitável — RLS continua aplicando.
 */
export function useSingleSession(
  userId: string | null,
  onForcedSignOut: () => void | Promise<void>,
) {
  useEffect(() => {
    if (!userId) return;

    // The OAuth popup (/oauth/gdrive) mounts the full React app, including this
    // hook. If we let it broadcast a "claim", the main tab sees a newer session
    // and signs the user out — breaking the entire Drive auth flow.
    // Skip single-session enforcement in any popup window.
    if (window.opener !== null) return;

    // Identificador único desta sessão (tab/dispositivo).
    const sessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const claimedAt = Date.now();

    interface ClaimPayload {
      sessionId: string;
      claimedAt: number;
    }

    const channelName = `user-session:${userId}`;
    let cancelled = false;

    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false, ack: false } },
    });

    channel
      .on('broadcast', { event: 'claim' }, (msg) => {
        if (cancelled) return;
        const payload = msg.payload as ClaimPayload | undefined;
        if (!payload || payload.sessionId === sessionId) return;
        // Segunda sessão é mais nova → eu sou o antigo, devo sair.
        if (payload.claimedAt > claimedAt) {
          console.warn(
            '[IV single-session] outra sessão mais nova detectada; encerrando esta.',
            { mine: sessionId, other: payload.sessionId },
          );
          void onForcedSignOut();
        }
      })
      .subscribe((status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          // Anuncia-se assim que entra. Tabs antigas vão receber e sair.
          void channel.send({
            type: 'broadcast',
            event: 'claim',
            payload: { sessionId, claimedAt } satisfies ClaimPayload,
          });
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [userId, onForcedSignOut]);
}
