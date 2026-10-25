import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CLI_REGISTRY, launchPickArgs } from '@agentmat/core';
import type { StudioEvent } from '@agentmat/studio';
import { checkScene, type StudioHost, type StudioService } from '@agentmat/studio/node';
import { app, nativeImage } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { streamHeadlessCliPrompt } from '../cli/headlessStream';
import { getDevSetupService } from '../devSetup/runtime';
import { broadcastToWindows } from '../ipc/send';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { createOffscreenSource, sceneWindowsMemoryBytes } from './capture/offscreenSource';
import { openBetterSqlite } from './db';

/** Scenes are checked small: a quarter of the design size is plenty to see blank or changing frames. */
const CHECK_SCALE = 0.25;

/**
 * The running service, made by main/studio/index.ts from this host. Imported when needed rather
 * than at load, since index.ts imports this file.
 */
async function studioServiceForHost(): Promise<StudioService> {
  const { studioService } = await import('./index');
  return studioService();
}

/**
 * Where Studio meets the rest of AgentMate. This is the one file under main/studio allowed to
 * import the app's own modules (see studioBoundary.test.ts): everything Studio needs from the app
 * comes through the `StudioHost` built here, so Studio could move to an app of its own by
 * replacing this file.
 */

/**
 * Where Studio's own files are. The package is bundled into the main process, so it cannot find
 * them next to itself: a packaged app ships them as resources (electron-builder.yml), and dev and
 * e2e builds read them from the package in node_modules.
 */
export function studioPackageRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'studio');
  // dist/node/index.js, three folders below the package root.
  const entry = createRequire(import.meta.url).resolve('@agentmat/studio/node');
  return dirname(dirname(dirname(entry)));
}

export function createDesktopStudioHost(): StudioHost {
  return {
    packageRoot: studioPackageRoot(),
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
    notify: (event: StudioEvent) => {
      broadcastToWindows(IPC.studio.onEvent, event);
      const notice = noticeFor(event);
      if (notice && 'videoId' in event) {
        showOsNotification({ ...notice, route: `/studio/${event.videoId}` });
      }
    },
    render: {
      async tools() {
        const [ffmpeg, ffprobe] = await Promise.all([
          devSetupTool('ffmpeg'),
          devSetupTool('ffprobe'),
        ]);
        return { ffmpeg, ffprobe };
      },
      frames: {
        // Rendering draws at the output size: the design size times the resolution's scale.
        open: (input) => createOffscreenSource(input),
        memoryBytes: async () => sceneWindowsMemoryBytes(),
      },
    },
    scenes: {
      async check(input) {
        const treeHash = /^studio-scene:\/\/t-([0-9a-f]{64})\//.exec(input.url)?.[1];
        const allowedHosts = treeHash
          ? await (await studioServiceForHost()).sceneHosts({ treeHash })
          : [];
        const source = createOffscreenSource({
          width: input.width,
          height: input.height,
          scale: CHECK_SCALE,
          allowedHosts,
        });
        const result = await checkScene(source, {
          url: input.url,
          duration: input.duration,
          fps: input.fps,
        });
        const thumb = result.thumbnail;
        const thumbnailPng = thumb
          ? nativeImage
              .createFromBitmap(Buffer.from(thumb.bitmap), {
                width: thumb.width,
                height: thumb.height,
              })
              .toPNG()
          : null;
        return { ...result, thumbnailPng };
      },
    },
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

/**
 * Where ffmpeg and ffprobe are, as Dev Setup sees them: on PATH, or where its installer put them
 * before PATH caught up. A miss is checked again afresh, since the user may have just installed it.
 */
async function devSetupTool(id: 'ffmpeg' | 'ffprobe'): Promise<{ file: string } | null> {
  const devSetup = getDevSetupService();
  let found = await devSetup.detect(id);
  if (found.state !== 'found') found = await devSetup.detect(id, { force: true });
  return found.state === 'found' ? { file: found.path ?? id } : null;
}

/**
 * Renders take minutes, so their end (and a render picked up again at startup) is told with an OS
 * notification, which reaches the user wherever they are. A click opens the video.
 */
function noticeFor(event: StudioEvent): { title: string; body: string } | null {
  if (event.type === 'render-resumed') {
    return {
      title: 'Render resumed',
      body: `Studio is carrying on with ${event.fileName} where it stopped.`,
    };
  }
  if (event.type !== 'render-finished') return null;
  return event.ok
    ? { title: 'Render finished', body: `${event.fileName} is ready.` }
    : { title: 'Render failed', body: `${event.fileName}: ${event.error ?? 'it stopped.'}` };
}

/** The ids of the projects AgentMate still has, for pruning Studio's per-project settings. */
export async function liveProjectIds(): Promise<Set<string>> {
  return new Set((await store.getProjects()).map((project) => project.id));
}
