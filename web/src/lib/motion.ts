import { useEffect, useState } from 'react';

/**
 * Live, not read once.
 *
 * The wall tablet is never reloaded, so someone toggling the OS-level setting
 * has to take effect without a restart — otherwise the accessibility control
 * does nothing on the one device where it matters most.
 *
 * Shared by the ticker (which changes presentation entirely) and the
 * celebration overlay (which drops the animation but keeps the announcement).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
