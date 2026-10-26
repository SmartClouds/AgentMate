import type { RdpLinkStats } from '@shared/apiTypes';
import { useEffect, useState } from 'react';

const POLL_MS = 1000;

/**
 * The speed and answer time of a session's connection, read from main once a second while
 * `enabled`. Null before the first answer and whenever the connection has none open.
 */
export function useRdpLinkStats(sessionId: string, enabled: boolean): RdpLinkStats | null {
  const [stats, setStats] = useState<RdpLinkStats | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const poll = (): void => {
      window.runova.rdp.getLinkStats(sessionId).then(
        (next) => {
          if (!cancelled) setStats(next ?? null);
        },
        // The session ended between two polls.
        () => {
          if (!cancelled) setStats(null);
        },
      );
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, enabled]);

  return stats;
}
