import { createStudioService, type StudioService } from '@agentmat/studio/node';
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

/** Forgets the storage folders of projects that were removed. Never throws. */
export async function pruneStudioProjects(): Promise<void> {
  try {
    await studioService().pruneProjects(await liveProjectIds());
  } catch {
    // The next startup sweeps again.
  }
}
