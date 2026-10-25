import { dirname, join } from 'node:path';
import { CLI_REGISTRY, launchPickArgs } from '@agentmat/core';
import type { StudioEvent } from '@agentmat/studio';
import type { StudioHost } from '@agentmat/studio/node';
import { app } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { streamHeadlessCliPrompt } from '../cli/headlessStream';
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
    ai: {
      async run(request, signal, onLine) {
        const result = await streamHeadlessCliPrompt(request.prompt, request.cwd, {
          preferredCliId: request.cliId,
          // A CLI the user picked is the one that runs, or none; the model flags only fit it.
          strictCli: request.cliId !== null,
          runArgs: request.cliId
            ? launchPickArgs(request.cliId, {
                model: request.model ?? undefined,
                effort: request.effort ?? undefined,
              })
            : [],
          timeoutMs: request.timeoutMs,
          pointerPrompt: request.pointerPrompt,
          // The run's work folder is Studio's own, never a git repository or a trusted folder.
          trustCwd: true,
          signal,
          onLine,
        });
        // Studio names CLIs by their short label ("Claude Code"), as its pickers do.
        const cli = CLI_REGISTRY.find((c) => c.name === result.cliName);
        return { ...result, cliName: cli?.label ?? result.cliName, log: result.log ?? '' };
      },
    },
  };
}

/** The ids of the projects AgentMate still has, for pruning Studio's per-project settings. */
export async function liveProjectIds(): Promise<Set<string>> {
  return new Set((await store.getProjects()).map((project) => project.id));
}
