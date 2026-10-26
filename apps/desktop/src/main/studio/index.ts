import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createStudioService, type StudioService } from '@runova/studio/node';
import { createDesktopStudioHost, liveProjectIds } from './host';

/**
 * Studio in the desktop app: one service for the whole process, made on first use so a session
 * that never opens Studio pays nothing for it.
 */

let service: StudioService | null = null;

export function studioService(): StudioService {
  service ??= createStudioService(createDesktopStudioHost());
  return service;
}

/** Closes every open video: flushes its document and releases its folder's lock. */
export async function shutdownStudio(): Promise<void> {
  const running = service;
  service = null;
  await running?.shutdown();
}

/**
 * Picks up renders and generated clips the app stopped in the middle of (a crash, a quit). Only
 * makes the service when there is a list to look at, so startup stays free for users who never
 * render or generate.
 */
export async function resumeStudioRenders(dataDir: string): Promise<void> {
  const lists = await Promise.all(
    ['renders.json', 'generations.json'].map((name) =>
      access(join(dataDir, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (!lists.some(Boolean)) return;
  try {
    await studioService().resumeRenders();
  } catch {
    // The render list says what happened; the user can resume from it.
  }
}

/** Forgets the storage folders of projects that were removed. Never throws. */
export async function pruneStudioProjects(): Promise<void> {
  try {
    await studioService().pruneProjects(await liveProjectIds());
  } catch {
    // The next startup sweeps again.
  }
}
