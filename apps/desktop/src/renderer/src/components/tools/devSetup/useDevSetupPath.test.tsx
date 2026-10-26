import type { DevDetection, DevJobState, DevSetupEnvironment } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { useDevSetup } from './useDevSetup';

/**
 * Putting a tool that is installed but off PATH onto the user PATH, from the hook's side: what the
 * person is told in each case, and that the row looks again afterwards. Main is faked.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const WIN: DevSetupEnvironment = { os: 'win32', arch: 'x64', packageManagers: ['winget'] };
const IDLE: DevJobState = {
  jobId: null,
  running: false,
  items: {},
  order: [],
  completed: [],
  logs: {},
  current: null,
  restartAdvised: false,
};

const gitOffPath: DevDetection = {
  state: 'found',
  version: '2.55.0',
  path: 'C:\\Program Files\\Git\\cmd\\git.exe',
  onPath: false,
};

function bridgeFor(
  options: {
    detect?: (id: string, options?: { force?: boolean }) => Promise<DevDetection>;
    addToPath?: (id: string) => Promise<{ changed: boolean; where: string }>;
  } = {},
) {
  return {
    'settings.get': { devSetupStacks: ['essentials'] },
    'settings.update': async (patch: unknown) => patch,
    'devSetup.environment': WIN,
    'devSetup.detect': options.detect ?? (async () => gitOffPath),
    'devSetup.jobState': IDLE,
    'devSetup.install': async () => IDLE,
    'devSetup.cancel': async () => undefined,
    'devSetup.addToPath':
      options.addToPath ?? (async () => ({ changed: true, where: 'your user PATH' })),
  };
}

async function setup(options: Parameters<typeof bridgeFor>[0] = {}) {
  const view = renderHookWithProviders(() => useDevSetup(), { bridge: bridgeFor(options) });
  await waitFor(() => expect(view.result.current.checklist?.summary.checking).toBe(0));
  return view;
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
});

describe('adding a tool to PATH', () => {
  it('asks main to do it for the tool named, by id only', async () => {
    const { result, bridge } = await setup();

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    expect(bridge.$fn('devSetup.addToPath')).toHaveBeenCalledWith('git');
  });

  it('says where it was added, and that already-open terminals need reopening', async () => {
    const { result } = await setup();

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    expect(toast.success).toHaveBeenCalledWith(
      'Added Git to your user PATH. Open a new terminal to use it.',
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('names the file when that is where it was written', async () => {
    const { result } = await setup({
      addToPath: async () => ({ changed: true, where: '/home/me/.zshrc' }),
    });

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    expect(toast.success).toHaveBeenCalledWith(
      'Added Git to /home/me/.zshrc. Open a new terminal to use it.',
    );
  });

  it('says so, and not that it added anything, when it was there already', async () => {
    const { result } = await setup({
      addToPath: async () => ({ changed: false, where: 'your user PATH' }),
    });

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    expect(toast.info).toHaveBeenCalledWith('Git is already on your PATH.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('looks at that tool again afterwards, and only that one', async () => {
    const detect = vi.fn(async () => gitOffPath);
    const { result } = await setup({ detect });
    detect.mockClear();

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    await waitFor(() => expect(detect).toHaveBeenCalledWith('git', { force: true }));
    expect(detect).not.toHaveBeenCalledWith('node', expect.anything());
  });

  it('shows the tool as on PATH once the fresh check says so', async () => {
    let added = false;
    const detect = async () => ({ ...gitOffPath, onPath: added });
    const { result } = await setup({
      detect,
      addToPath: async () => {
        added = true;
        return { changed: true, where: 'your user PATH' };
      },
    });
    const gitState = () =>
      result.current.checklist?.rows.find((row) => row.item.id === 'git')?.state;
    expect(gitState()).toMatchObject({ kind: 'installed', onPath: false });

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    await waitFor(() => expect(gitState()).toMatchObject({ kind: 'installed', onPath: true }));
  });
});

describe('adding a tool to PATH: when main refuses', () => {
  it('says so in plain words, without the wrapper Electron puts around it', async () => {
    const { result } = await setup({
      addToPath: async () => {
        throw new Error(
          "Error invoking remote method 'devSetup:addToPath': Error: That folder cannot go on the PATH.",
        );
      },
    });

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    expect(toast.error).toHaveBeenCalledWith(
      'Could not add Git to your PATH. That folder cannot go on the PATH.',
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('looks at that tool again, since a refusal means the row was out of date', async () => {
    const detect = vi.fn(async () => gitOffPath);
    const { result } = await setup({
      detect,
      addToPath: async () => {
        throw new Error('That tool is already on your PATH, or was not found.');
      },
    });
    detect.mockClear();

    await act(async () => result.current.addToPath({ id: 'git', name: 'Git' }));

    await waitFor(() => expect(detect).toHaveBeenCalledWith('git', { force: true }));
  });

  it('never throws, so a button press cannot become an unhandled rejection', async () => {
    const { result } = await setup({
      addToPath: async () => {
        throw new Error('boom');
      },
    });

    await expect(
      act(async () => result.current.addToPath({ id: 'git', name: 'Git' })),
    ).resolves.toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith('Could not add Git to your PATH. boom');
  });
});
