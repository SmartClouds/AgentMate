import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

describe('the AI port', () => {
  it('runs the picked CLI with its model and effort flags, strictly', async () => {
    const stream = await import('../cli/headlessStream');
    const spy = vi
      .spyOn(stream, 'streamHeadlessCliPrompt')
      .mockResolvedValue({ ok: true, text: '{}', cliName: 'Claude Code CLI' });
    const { createDesktopStudioHost } = await load();
    const signal = new AbortController().signal;
    const onLine = vi.fn();
    const result = await createDesktopStudioHost().ai?.run(
      {
        cliId: 'claude-code',
        model: 'opus',
        effort: 'high',
        cwd: 'C:/work/g1',
        prompt: 'the request',
        pointerPrompt: 'Read request.md',
        timeoutMs: 1000,
      },
      signal,
      onLine,
    );
    expect(result).toEqual({ ok: true, text: '{}', cliName: 'Claude Code', log: '' });
    const [prompt, cwd, options] = spy.mock.calls[0] ?? [];
    expect(prompt).toBe('the request');
    expect(cwd).toBe('C:/work/g1');
    expect(options).toMatchObject({
      preferredCliId: 'claude-code',
      strictCli: true,
      trustCwd: true,
      pointerPrompt: 'Read request.md',
      timeoutMs: 1000,
      signal,
      onLine,
    });
    expect(options?.runArgs?.slice(0, 2)).toEqual(['--model', 'opus']);
    expect(options?.runArgs?.length).toBeGreaterThan(2);
    spy.mockRestore();
  });

  it('falls back to the default CLI with no flags when none is picked', async () => {
    const stream = await import('../cli/headlessStream');
    const spy = vi
      .spyOn(stream, 'streamHeadlessCliPrompt')
      .mockResolvedValue({ ok: false, text: '', cliName: null, error: 'none' });
    const { createDesktopStudioHost } = await load();
    await createDesktopStudioHost().ai?.run(
      {
        cliId: null,
        model: null,
        effort: null,
        cwd: 'c',
        prompt: 'p',
        pointerPrompt: 'q',
        timeoutMs: 1,
      },
      new AbortController().signal,
      vi.fn(),
    );
    expect(spy.mock.calls[0]?.[2]).toMatchObject({
      preferredCliId: null,
      strictCli: false,
      runArgs: [],
    });
    spy.mockRestore();
  });

  it('passes no flags for a picked CLI with no model, and keeps a name it does not know', async () => {
    const stream = await import('../cli/headlessStream');
    const spy = vi
      .spyOn(stream, 'streamHeadlessCliPrompt')
      .mockResolvedValue({ ok: false, text: '', cliName: null, error: 'gone', log: 'x' });
    const { createDesktopStudioHost } = await load();
    const result = await createDesktopStudioHost().ai?.run(
      {
        cliId: 'codex-cli',
        model: null,
        effort: 'high',
        cwd: 'c',
        prompt: 'p',
        pointerPrompt: 'q',
        timeoutMs: 1,
      },
      new AbortController().signal,
      vi.fn(),
    );
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ strictCli: true, runArgs: [] });
    expect(result).toMatchObject({ cliName: null, log: 'x', error: 'gone' });
    spy.mockRestore();
  });
});
