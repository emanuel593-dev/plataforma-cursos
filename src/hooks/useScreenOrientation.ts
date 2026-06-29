import { useEffect, useState } from 'react';

type Orientation = 'portrait' | 'landscape';

/**
 * useScreenOrientation — detecta orientação atual com fallback para matchMedia.
 * Reativo a mudanças (orientationchange / resize).
 */
export function useScreenOrientation(): Orientation {
  const get = (): Orientation => {
    if (typeof window === 'undefined') return 'portrait';
    if (window.matchMedia) {
      return window.matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait';
    }
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  };

  const [orientation, setOrientation] = useState<Orientation>(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setOrientation(get());
    const mql = window.matchMedia ? window.matchMedia('(orientation: landscape)') : null;
    if (mql && typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
    } else {
      window.addEventListener('orientationchange', update);
      window.addEventListener('resize', update);
    }
    return () => {
      if (mql && typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', update);
      } else {
        window.removeEventListener('orientationchange', update);
        window.removeEventListener('resize', update);
      }
    };
  }, []);

  return orientation;
}
