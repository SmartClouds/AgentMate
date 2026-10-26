import { runSessionsOf, useRunSessionStore } from '@/stores/runSessionStore';
import { useTerminalStore } from '@/stores/terminalStore';

/**
 * Watches the output of project runs' terminals for where the run can be reached, for the status
 * bar. The shell starts it once, so a run is followed from its first line whichever page is open.
 * Other terminals' output is skipped without being looked at. Reference counted, so a second
 * start doesn't subscribe twice.
 */

let users = 0;
let stopFeed: (() => void) | null = null;

export function startRunSessionFeed(): () => void {
  users += 1;
  if (!stopFeed) {
    let runIds = new Set<string>();
    const sync = (): void => {
      runIds = new Set(runSessionsOf(useTerminalStore.getState().sessions).map((run) => run.id));
      useRunSessionStore.getState().prune([...runIds]);
    };
    sync();
    const offSessions = useTerminalStore.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) sync();
    });
    const offData = window.runova.terminal.onData(({ sessionId, data }) => {
      if (runIds.has(sessionId)) useRunSessionStore.getState().noteOutput(sessionId, data);
    });
    stopFeed = () => {
      offSessions();
      offData();
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
