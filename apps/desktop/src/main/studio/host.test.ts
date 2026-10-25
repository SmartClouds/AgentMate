import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow, setElectronPath } from '../../test/main/electronMock';
import { useTempUserData } from '../../test/main/ipcHarness';

/** The desktop side of Studio's host: where its folders are, and what it sees of the app. */

const userData = useTempUserData();

async function load() {
  setElectronPath('videos', join(userData.dir, 'Videos'));
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: join(userData.dir, 'shop'), createdAt: 1, updatedAt: 1 },
  ]);
  return import('./host');
}

describe('createDesktopStudioHost', () => {
  it('keeps the library under Videos and its own data under userData', async () => {
    const { createDesktopStudioHost } = await load();
    const host = createDesktopStudioHost();
    expect(host.defaultLibraryRoot).toBe(join(userData.dir, 'Videos', 'AgentMate Studio'));
    expect(host.dataDir).toBe(join(userData.dir, 'data', 'studio'));
    expect(host.defaultCacheDir).toBe(join(userData.dir, 'studio-cache'));
    expect(host.appDir).toBeNull();
  });

  it('finds the projects AgentMate has, and nothing else', async () => {
    const { createDesktopStudioHost, liveProjectIds } = await load();
    const host = createDesktopStudioHost();
    expect(await host.projects.get('p1')).toEqual({
      id: 'p1',
      name: 'Shop',
      folderPath: join(userData.dir, 'shop'),
    });
    expect(await host.projects.get('ghost')).toBeNull();
    expect(await liveProjectIds()).toEqual(new Set(['p1']));
  });

  it('passes events on to every window', async () => {
    const { createDesktopStudioHost } = await load();
    const win = new FakeBrowserWindow();
    createDesktopStudioHost().notify({ type: 'library-changed' });
    expect(win.webContents.sentOn(IPC.studio.onEvent)).toEqual([[{ type: 'library-changed' }]]);
  });
});

describe('Studio service lifecycle', () => {
  it('prunes the folders of removed projects without throwing, and shuts down cleanly', async () => {
    await load();
    const { pruneStudioProjects, shutdownStudio, studioService } = await import('./index');
    await studioService().setProjectRoot({ projectId: 'p1', path: join(userData.dir, 'media') });
    userData.writeData('projects.json', []);
    await pruneStudioProjects();
    userData.writeData('projects.json', [
      {
        id: 'p1',
        name: 'Shop',
        folderPath: join(userData.dir, 'shop'),
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect((await studioService().projectStorage({ projectId: 'p1' })).isCustom).toBe(false);
    await shutdownStudio();
    await shutdownStudio();
  });
});
