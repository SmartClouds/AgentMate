import { useDevServerStore } from '@/stores/devServerStore';

/**
 * Watches all terminal output for dev server addresses, for the browser tab's start page. Its own
 * subscription next to the terminal runtime's, so nothing is added to the path that draws output.
 * The workspace starts it when it mounts, so a server started before any browser tab was opened
 * is still known. Reference counted, so a second start doesn't subscribe twice.
 */

let users = 0;
let stopFeed: (() => void) | null = null;

export function startDevServerFeed(): () => void {
  users += 1;
  if (!stopFeed) {
    const { noteOutput, forget } = useDevServerStore.getState();
    const offData = window.runova.terminal.onData(({ sessionId, data }) =>
      noteOutput(sessionId, data),
    );
    const offExit = window.runova.terminal.onExit(({ sessionId }) => forget(sessionId));
    stopFeed = () => {
      offData();
      offExit();
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users -= 1;
    if (users === 0) {
      stopFeed?.();
      stopFeed = null;
    }
  };
}
