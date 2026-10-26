import type { SshAgentHistoryRun } from '../../shared/apiTypes';

/** How long after the last change the file is written, so a busy task is not a write per line. */
export const SAVE_DELAY_MS = 1000;
/** Tasks kept per saved server. The same cap the server's AI history lists. */
const DEFAULT_PER_SERVER = 50;

const CLOSED_NOTE = 'Runova closed while this was running.';

export interface SshHistoryStoreOptions {
  read: () => Promise<unknown>;
  write: (runs: SshAgentHistoryRun[]) => Promise<void>;
  perServer?: number;
}

function isRun(value: unknown): value is SshAgentHistoryRun {
  const run = value as SshAgentHistoryRun | null;
  return (
    typeof run === 'object' &&
    run !== null &&
    typeof run.id === 'string' &&
    typeof run.sessionId === 'string' &&
    typeof run.prompt === 'string' &&
    typeof run.startedAt === 'number' &&
    Array.isArray(run.entries)
  );
}

/** A task that was still going when the app closed ended right there, and says so. */
function settle(run: SshAgentHistoryRun): SshAgentHistoryRun {
  if (run.status !== 'running' && run.status !== 'paused') return run;
  const endedAt = run.entries.at(-1)?.at ?? run.startedAt;
  return {
    ...run,
    status: 'stopped',
    endedAt,
    entries: [...run.entries, { kind: 'stopped', at: endedAt, text: CLOSED_NOTE }],
  };
}

/** Only tasks on a saved server, newest `perServer` of each. A local tab means nothing next time. */
function keep(runs: SshAgentHistoryRun[], perServer: number): SshAgentHistoryRun[] {
  const byServer = new Map<string, SshAgentHistoryRun[]>();
  for (const run of runs) {
    if (!run.serverId) continue;
    const list = byServer.get(run.serverId) ?? [];
    list.push(run);
    byServer.set(run.serverId, list);
  }
  return [...byServer.values()].flatMap((list) =>
    list.sort((a, b) => a.startedAt - b.startedAt).slice(-perServer),
  );
}

/**
 * The SSH AI task history on disk, so a past task can be read, run again or continued after a
 * restart. Reading happens once; writes wait a moment after the last change. A file that cannot
 * be read starts the history empty rather than breaking the AI tasks.
 */
export function createSshHistoryStore({
  read,
  write,
  perServer = DEFAULT_PER_SERVER,
}: SshHistoryStoreOptions) {
  let loading: Promise<SshAgentHistoryRun[]> | null = null;
  let pending: SshAgentHistoryRun[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function load(): Promise<SshAgentHistoryRun[]> {
    loading ??= read()
      .then((saved) => (Array.isArray(saved) ? saved.filter(isRun).map(settle) : []))
      .catch(() => []);
    return loading;
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const runs = pending;
    pending = null;
    if (!runs) return;
    try {
      await write(keep(runs, perServer));
    } catch {
      // The next change tries again. Until then the history is only in memory.
    }
  }

  function save(runs: SshAgentHistoryRun[]): void {
    pending = runs;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  return { load, save, flush };
}
