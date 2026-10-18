import { realpathSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSite, FilesSitesChangedEvent } from '../../../shared/deployFilesTypes';
import { IPC } from '../../../shared/ipcChannels';
import { app, electronState, FakeBrowserWindow } from '../../../test/main/electronMock';
import { tempDir } from '../../../test/main/fixtures';
import { invoke, useTempUserData } from '../../../test/main/ipcHarness';
import { createFakeRemote } from './transport/fakeRemote';

/**
 * The wiring of FTP and SFTP sites into Electron (E23): the channels, the sealed store, the
 * broadcasts every window hears, Deploy on save at startup, and the stop at quit.
 */

const notifications = vi.hoisted(() => ({ show: vi.fn(() => true) }));
vi.mock('../../notifications/osNotification', () => ({
  showOsNotification: notifications.show,
}));

const userData = useTempUserData();
let local = '';

beforeAll(async () => {
  await import('./index');
}, 120_000);

beforeEach(() => {
  local = realpathSync(tempDir('agentmate-files-wiring-'));
  userData.writeData('projects.json', []);
  userData.writeData('ssh-servers.json', [
    {
      id: 'srv-1',
      nickname: 'web',
      host: 'web.example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
      createdAt: 1,
      lastConnectedAt: null,
    },
  ]);
  electronState.appEvents.clear();
});

describe('registerDeployFilesIpc', () => {
  it('handles every call, tells every window about the sites, and stops at quit', async () => {
    const fake = createFakeRemote();
    fake.setDir('/srv/site');
    const watchers: { closed: boolean }[] = [];
    const { registerDeployFilesIpc } = await import('./index');
    const vault = await import('../../ssh/vault');
    const register = vi.spyOn(vault, 'registerSealedSecretStore');
    const win = new FakeBrowserWindow();

    registerDeployFilesIpc({
      guard: () => true,
      overrides: {
        openRemote: fake.opener,
        watch: () => {
          const watcher = { closed: false };
          watchers.push(watcher);
          return {
            close: () => {
              watcher.closed = true;
            },
          };
        },
      },
    });

    const invokes = Object.entries(IPC.deployFiles)
      .filter(([name]) => !name.startsWith('on'))
      .map(([, channel]) => channel);
    for (const channel of invokes) expect(electronState.handlers.has(channel)).toBe(true);
    expect(register).toHaveBeenCalled();

    const site = await invoke<FileSite>(IPC.deployFiles.create, {
      label: 'Shop',
      protocol: 'sftp',
      connection: { kind: 'saved', sshServerId: 'srv-1' },
      remoteRoot: '/srv/site',
      localFolder: local,
      projectIds: [],
      deployOnSave: true,
      quietSeconds: 5,
      ignorePatterns: [],
    });
    const sent = win.webContents.sentOn(IPC.deployFiles.onSitesChanged) as [
      FilesSitesChangedEvent,
    ][];
    expect(sent.at(-1)?.[0].sites.map((one) => one.id)).toEqual([site.id]);

    await vi.waitFor(() => expect(watchers).toHaveLength(1));
    app.emit('will-quit');
    expect(watchers[0]?.closed).toBe(true);
  });
});
