import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow, setElectronPath } from '../../test/main/electronMock';
import { useTempUserData } from '../../test/main/ipcHarness';

/** The desktop side of Studio's host: where its folders are, and what it sees of the app. */

const devSetup = vi.hoisted(() => ({
  answers: {} as Record<string, { state: string; path?: string | null }[]>,
  calls: [] as [string, unknown][],
}));
vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({
    detect: async (id: string, options?: unknown) => {
      devSetup.calls.push([id, options]);
      return devSetup.answers[id]?.shift() ?? { state: 'absent' };
    },
  }),
}));

const notices = vi.hoisted(() => [] as { title: string; body: string; route: string }[]);
vi.mock('../notifications/osNotification', () => ({
  showOsNotification: (input: { title: string; body: string; route: string }) => {
    notices.push(input);
    return true;
  },
}));

const userData = useTempUserData();

async function load() {
  setElectronPath('videos', join(userData.dir, 'Videos'));
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: join(userData.dir, 'shop'), createdAt: 1, updatedAt: 1 },
  ]);
  return import('./host');
}

/** None of these tests check a scene, the one place the host asks for its service. */
const noService = (): never => {
  throw new Error('the service is not used here');
};

describe('createDesktopStudioHost', () => {
  it('keeps the library under Videos and its own data under userData', async () => {
    const { createDesktopStudioHost } = await load();
    const host = createDesktopStudioHost(noService);
    expect(host.defaultLibraryRoot).toBe(join(userData.dir, 'Videos', 'Runova Studio'));
    expect(host.dataDir).toBe(join(userData.dir, 'data', 'studio'));
    expect(host.defaultCacheDir).toBe(join(userData.dir, 'studio-cache'));
    expect(host.appDir).toBeNull();
  });

  it('finds the projects Runova has, and nothing else', async () => {
    const { createDesktopStudioHost, liveProjectIds } = await load();
    const host = createDesktopStudioHost(noService);
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
    createDesktopStudioHost(noService).notify({ type: 'library-changed' });
    expect(win.webContents.sentOn(IPC.studio.onEvent)).toEqual([[{ type: 'library-changed' }]]);
  });
});

describe('render notices', () => {
  it('tells the user when a render ends or is picked up again, and opens the video on click', async () => {
    const { createDesktopStudioHost } = await load();
    notices.length = 0;
    const host = createDesktopStudioHost(noService);
    host.notify({ type: 'render-changed', jobId: 'j1', videoId: 'v1' });
    host.notify({
      type: 'render-finished',
      jobId: 'j1',
      videoId: 'v1',
      fileName: 'Launch.mp4',
      ok: true,
      error: null,
    });
    host.notify({
      type: 'render-finished',
      jobId: 'j2',
      videoId: 'v1',
      fileName: 'Teaser.mp4',
      ok: false,
      error: 'Scene 2 could not be drawn.',
    });
    host.notify({
      type: 'render-finished',
      jobId: 'j3',
      videoId: 'v2',
      fileName: 'Other.mp4',
      ok: false,
      error: null,
    });
    host.notify({ type: 'render-resumed', jobId: 'j1', videoId: 'v1', fileName: 'Launch.mp4' });
    expect(notices).toEqual([
      { title: 'Render finished', body: 'Launch.mp4 is ready.', route: '/studio/v1' },
      {
        title: 'Render failed',
        body: 'Teaser.mp4: Scene 2 could not be drawn.',
        route: '/studio/v1',
      },
      { title: 'Render failed', body: 'Other.mp4: it stopped.', route: '/studio/v2' },
      {
        title: 'Render resumed',
        body: 'Studio is carrying on with Launch.mp4 where it stopped.',
        route: '/studio/v1',
      },
    ]);
  });
});

describe('the render host', () => {
  it('finds ffmpeg and ffprobe where Dev Setup sees them, checking a miss again afresh', async () => {
    const { createDesktopStudioHost } = await load();
    devSetup.calls.length = 0;
    devSetup.answers = {
      ffmpeg: [{ state: 'found', path: 'C:/Links/ffmpeg.exe' }],
      ffprobe: [{ state: 'absent' }, { state: 'found', path: null }],
    };
    const render = createDesktopStudioHost(noService).render;
    expect(await render?.tools()).toEqual({
      ffmpeg: { file: 'C:/Links/ffmpeg.exe' },
      // Found on PATH without a known location: run it by name.
      ffprobe: { file: 'ffprobe' },
    });
    expect(devSetup.calls).toEqual([
      ['ffmpeg', undefined],
      ['ffprobe', undefined],
      ['ffprobe', { force: true }],
    ]);
    devSetup.answers = {};
    expect(await render?.tools()).toEqual({ ffmpeg: null, ffprobe: null });
    expect(await render?.frames.memoryBytes?.()).toBe(0);
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
    const result = await createDesktopStudioHost(noService).ai?.run(
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
    await createDesktopStudioHost(noService).ai?.run(
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
    const result = await createDesktopStudioHost(noService).ai?.run(
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
