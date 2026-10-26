import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Tells main which page the app window is on, so the next launch can open there (see
 * main/lastRoute.ts). Main checks and cleans the route; this only reports it.
 */
export function useRememberRoute(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    window.runova.app.setLastRoute(`${pathname}${search}`);
  }, [pathname, search]);
}
