import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * useScrollRestore — preserva e restaura a posição de scroll de cada rota.
 *
 * Comportamento:
 *  - Ao navegar via PUSH: salva o scroll atual e leva a próxima página ao topo (smooth).
 *  - Ao navegar via POP (back/forward): restaura o scroll salvo, garantindo continuidade.
 *
 * Uso: chame uma única vez no Layout.
 */
export function useScrollRestore() {
  const location = useLocation();
  const navType = useNavigationType();
  const positions = useRef<Map<string, number>>(new Map());
  const lastKey = useRef<string>(location.key);

  useEffect(() => {
    const prevKey = lastKey.current;
    // Save scroll for the page we are leaving.
    positions.current.set(prevKey, window.scrollY);
    lastKey.current = location.key;

    if (navType === 'POP') {
      const saved = positions.current.get(location.key) ?? 0;
      // Wait one frame so the new page mounts before scrolling.
      requestAnimationFrame(() => window.scrollTo({ top: saved, behavior: 'auto' }));
    } else {
      // PUSH or REPLACE → start fresh at top.
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    }
  }, [location.key, navType]);
}
