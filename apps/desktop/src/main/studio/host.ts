import { dirname, join } from 'node:path';
import type { StudioEvent } from '@agentmat/studio';
import type { StudioHost } from '@agentmat/studio/node';
import { app } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import { store } from '../store';
import { openBetterSqlite } from './db';

/**
 * Where Studio meets the rest of AgentMate. This is the one file under main/studio allowed to
 * import the app's own modules (see studioBoundary.test.ts): everything Studio needs from the app
 * comes through the `StudioHost` built here, so Studio could move to an app of its own by
 * replacing this file.
 */

export function createDesktopStudioHost(): StudioHost {
  return {
    dataDir: join(app.getPath('userData'), 'data', 'studio'),
    // Videos, not Documents: Documents is often redirected to OneDrive, and large files and a
    // history database under a sync client are trouble.
    defaultLibraryRoot: join(app.getPath('videos'), 'AgentMate Studio'),
    defaultCacheDir: join(app.getPath('userData'), 'studio-cache'),
    appDir: app.isPackaged ? dirname(app.getPath('exe')) : null,
    appId: app.getName(),
    openDb: openBetterSqlite,
    projects: {
      async get(id) {
        const project = (await store.getProjects()).find((p) => p.id === id);
        return project
          ? { id: project.id, name: project.name, folderPath: project.folderPath }
          : null;
      },
    },
    notify: (event: StudioEvent) => broadcastToWindows(IPC.studio.onEvent, event),
  };
}

/** The ids of the projects AgentMate still has, for pruning Studio's per-project settings. */
export async function liveProjectIds(): Promise<Set<string>> {
  return new Set((await store.getProjects()).map((project) => project.id));
}
