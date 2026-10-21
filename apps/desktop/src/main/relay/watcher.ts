import { type FSWatcher, watch } from 'node:fs';
import { taskIdFromFileName } from '@agentmat/core';

/**
 * Keeps the board live: watches a project's tasks folder and its handoffs folder while the board
 * is on screen (`watch`/`unwatch`, counted per caller) or a relay runs there (`setLive`). Bursts
 * of changes (an editor saving, an agent rewriting a handoff) arrive as one call per project.
 */

export interface RelayWatchTarget {
  tasksDir: string;
  handoffsDir: string;
}

export interface RelayWatcherDeps {
  resolve: (projectId: string) => Promise<RelayWatchTarget | null>;
  onChange: (projectId: string, change: { handoffs: string[]; tasks: boolean }) => void;
  debounceMs?: number;
  /** How often a folder that does not exist yet is looked for again. */
  retryMs?: number;
}

interface Watched {
  refs: number;
  live: boolean;
  watchers: FSWatcher[];
  pending: { handoffs: Set<string>; tasks: boolean } | null;
  timer: NodeJS.Timeout | null;
  retry: NodeJS.Timeout | null;
}

export function createRelayWatcher(deps: RelayWatcherDeps) {
  const debounceMs = deps.debounceMs ?? 250;
  const retryMs = deps.retryMs ?? 5000;
  const projects = new Map<string, Watched>();

  function flush(projectId: string): void {
    const entry = projects.get(projectId);
    if (!entry?.pending) return;
    const { handoffs, tasks } = entry.pending;
    entry.pending = null;
    entry.timer = null;
    deps.onChange(projectId, { handoffs: [...handoffs], tasks });
  }

  function note(projectId: string, kind: 'tasks' | 'handoff', name: string | null): void {
    const entry = projects.get(projectId);
    if (!entry) return;
    entry.pending ??= { handoffs: new Set(), tasks: false };
    if (kind === 'tasks') {
      // RELAY.md and other notes do not change the board; an unknown name might.
      if (!name || taskIdFromFileName(name)) entry.pending.tasks = true;
    } else if (name) {
      const id = /^(T\d{3,})\.md$/.exec(name)?.[1];
      if (id) entry.pending.handoffs.add(id);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(projectId), debounceMs);
  }

  function close(entry: Watched): void {
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.retry) clearTimeout(entry.retry);
    entry.timer = null;
    entry.retry = null;
  }

  async function open(projectId: string): Promise<void> {
    const entry = projects.get(projectId);
    if (!entry) return;
    const target = await deps.resolve(projectId).catch(() => null);
    if (projects.get(projectId) !== entry || entry.watchers.length > 0) return;
    const add = (dir: string, kind: 'tasks' | 'handoff'): boolean => {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) =>
          note(projectId, kind, typeof name === 'string' ? name : null),
        );
        watcher.on('error', () => undefined);
        entry.watchers.push(watcher);
        return true;
      } catch {
        return false;
      }
    };
    const tasksOk = target ? add(target.tasksDir, 'tasks') : false;
    const handoffsOk = target ? add(target.handoffsDir, 'handoff') : false;
    if (!tasksOk || !handoffsOk) {
      // The folder appears once a plan or the first leg writes it; look again until then.
      close(entry);
      entry.retry = setTimeout(() => {
        entry.retry = null;
        void open(projectId);
      }, retryMs);
    }
  }

  function ensure(projectId: string): Watched {
    let entry = projects.get(projectId);
    if (!entry) {
      entry = { refs: 0, live: false, watchers: [], pending: null, timer: null, retry: null };
      projects.set(projectId, entry);
      void open(projectId);
    }
    return entry;
  }

  function release(projectId: string): void {
    const entry = projects.get(projectId);
    if (!entry || entry.refs > 0 || entry.live) return;
    close(entry);
    projects.delete(projectId);
  }

  return {
    watch(projectId: string): void {
      ensure(projectId).refs += 1;
    },
    unwatch(projectId: string): void {
      const entry = projects.get(projectId);
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      release(projectId);
    },
    /** The projects with a relay waiting, running or paused; the rest drop their live hold. */
    setLive(projectIds: string[]): void {
      const live = new Set(projectIds);
      for (const id of live) ensure(id).live = true;
      for (const [id, entry] of projects) {
        if (live.has(id)) continue;
        entry.live = false;
        release(id);
      }
    },
    watching(): string[] {
      return [...projects.keys()];
    },
    dispose(): void {
      for (const entry of projects.values()) close(entry);
      projects.clear();
    },
  };
}
