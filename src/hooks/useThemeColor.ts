import { useEffect } from 'react';

const META_SELECTOR = 'meta[name="theme-color"]';

/**
 * useThemeColor — atualiza dinamicamente a `<meta name="theme-color">`,
 * que controla a cor da status bar em PWAs/Chrome Android e na barra
 * superior do iOS quando instalado. Restaura a cor anterior ao desmontar.
 */
export function useThemeColor(color: string | null | undefined) {
  useEffect(() => {
    if (typeof document === 'undefined' || !color) return;

    let meta = document.querySelector<HTMLMetaElement>(META_SELECTOR);
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    const previous = meta.content;
    meta.content = color;
    return () => { meta!.content = previous; };
  }, [color]);
}
