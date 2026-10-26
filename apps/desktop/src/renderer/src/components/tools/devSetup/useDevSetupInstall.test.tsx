import type { DevDetection, DevJobEvent, DevJobState, DevSetupEnvironment } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { useDevSetup } from './useDevSetup';

/**
 * The install half of the hook: following a run as it happens, asking before an agreement is
 * accepted on the person's behalf, and keeping the rows honest as items finish. The main process
 * is faked; its events are fired by hand the way the preload would deliver them.
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
const absent: DevDetection = { state: 'absent' };
const found = (version: string): DevDetection => ({
  state: 'found',
  version,
  path: null,
  onPath: true,
});

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

function bridgeFor(
  options: {
    stacks?: string[];
    jobState?: DevJobState;
    detect?: (id: string, options?: { force?: boolean }) => Promise<DevDetection>;
    install?: (request: unknown) => Promise<DevJobState>;
  } = {},
) {
  return {
    'settings.get': { devSetupStacks: options.stacks ?? ['essentials'] },
    'settings.update': async (patch: unknown) => patch,
    'devSetup.environment': WIN,
    'devSetup.detect': options.detect ?? (async () => absent),
    'devSetup.jobState': options.jobState ?? IDLE,
    'devSetup.install': options.install ?? (async () => IDLE),
    'devSetup.cancel': async () => undefined,
  };
}

const emit = (bridge: { $emit: (path: string, ...args: unknown[]) => void }, event: DevJobEvent) =>
  act(() => bridge.$emit('devSetup.onEvent', event));

const stateOf = (result: { current: ReturnType<typeof useDevSetup> }, id: string) =>
  result.current.checklist?.rows.find((row) => row.item.id === id)?.state;

beforeEach(() => {
  toast.error.mockReset();
  toast.info.mockReset();
  resolveConfirm(false);
});

describe('following a run', () => {
  it('has no run until one starts', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), { bridge: bridgeFor() });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    expect(result.current.job).toMatchObject({ running: false, items: {} });
  });

  it('picks up a run that was already going when the page opened', async () => {
    const running: DevJobState = {
      ...IDLE,
      jobId: 'a',
      running: true,
      order: ['gh'],
      current: 'gh',
      items: {
        gh: { status: 'installing', phase: 'downloading', fraction: 0.4, detail: '4 of 10 MB' },
      },
    };
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ jobState: running }),
    });

    await waitFor(() =>
      expect(stateOf(result, 'gh')).toMatchObject({ kind: 'installing', fraction: 0.4 }),
    );
    expect(result.current.job.running).toBe(true);
  });

  it('shows the steps of a new run as they are announced', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    await emit(bridge, { type: 'plan', jobId: 'a', steps: ['git', 'gh'] });
    await emit(bridge, { type: 'started', jobId: 'a', itemId: 'git' });
    await emit(bridge, {
      type: 'progress',
      jobId: 'a',
      itemId: 'git',
      phase: 'downloading',
      fraction: 0.25,
      detail: '1 of 4 MB',
    });

    expect(stateOf(result, 'git')).toEqual({
      kind: 'installing',
      phase: 'downloading',
      fraction: 0.25,
      detail: '1 of 4 MB',
    });
    expect(stateOf(result, 'gh')).toEqual({ kind: 'queued' });
    expect(result.current.job.running).toBe(true);
  });

  it('keeps what it was told about a run, even if the first answer arrives late', async () => {
    let answer: (state: DevJobState) => void = () => undefined;
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: {
        ...bridgeFor(),
        'devSetup.jobState': () => new Promise<DevJobState>((resolve) => (answer = resolve)),
      },
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    await emit(bridge, { type: 'plan', jobId: 'a', steps: ['gh'] });
    await act(async () => answer(IDLE));

    expect(result.current.job.jobId).toBe('a');
  });

  it('stops listening when the page goes away', async () => {
    const { result, bridge, unmount } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());
    expect(bridge.$listenerCount('devSetup.onEvent')).toBe(1);

    unmount();

    expect(bridge.$listenerCount('devSetup.onEvent')).toBe(0);
  });

  it("keeps each item's log", async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    await emit(bridge, { type: 'plan', jobId: 'a', steps: ['gh'] });
    await emit(bridge, { type: 'log', jobId: 'a', itemId: 'gh', line: 'Found GitHub CLI' });

    expect(result.current.job.logs.gh).toEqual(['Found GitHub CLI']);
  });

  it('shows a failure on the row, with its reason', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    await emit(bridge, { type: 'plan', jobId: 'a', steps: ['gh'] });
    await emit(bridge, {
      type: 'finished',
      jobId: 'a',
      itemId: 'gh',
      result: 'failed',
      message: 'winget could not finish (code 1603).',
      exitCode: 1603,
    });

    expect(stateOf(result, 'gh')).toEqual({
      kind: 'failed',
      message: 'winget could not finish (code 1603).',
      exitCode: 1603,
    });
  });
});

describe('re-checking as items finish', () => {
  it('looks at an item again the moment it finishes installing', async () => {
    const detect = vi.fn(async () => absent);
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    detect.mockClear();

    await emit(bridge, { type: 'plan', jobId: 'a', steps: ['gh'] });
    await emit(bridge, { type: 'finished', jobId: 'a', itemId: 'gh', result: 'installed' });

    await waitFor(() => expect(detect).toHaveBeenCalledWith('gh', { force: true }));
    expect(detect).not.toHaveBeenCalledWith('node', expect.anything());
  });

  it('shows the item as installed once the fresh check says so', async () => {
    let installed = false;
    const detect = async (id: string) => (id === 'gh' && installed ? found('2.62.0') : absent);
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect }),
    });
    await waitFor(() => expect(stateOf(result, 'gh')?.kind).toBe('missing'));

    installed = true;
    await emit(bridge, { type: 'plan', jobId: 'a', steps: ['gh'] });
    await emit(bridge, { type: 'finished', jobId: 'a', itemId: 'gh', result: 'installed' });

    await waitFor(() =>
      expect(stateOf(result, 'gh')).toMatchObject({ kind: 'installed', version: '2.62.0' }),
    );
  });
});

describe('installing', () => {
  it('asks main to install the items named', async () => {
    const install = vi.fn(async () => IDLE);
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ install }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    await act(async () => result.current.install(['gh']));

    expect(install).toHaveBeenCalledWith({ ids: ['gh'], consented: false });
  });

  it('installs everything that is missing in one go', async () => {
    const install = vi.fn(async () => IDLE);
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ install }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    await act(async () => result.current.installAll());

    // Required items only: git, node and gh (npm comes with node), not the optional pnpm.
    expect(install).toHaveBeenCalledWith({ ids: ['git', 'node', 'npm', 'gh'], consented: false });
  });

  it('works out what Install all will do, and what it cannot', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ stacks: ['essentials', 'docker'] }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    expect(result.current.plan?.steps).toEqual(['git', 'node', 'gh']);
    // WSL needs a terminal, and Docker Desktop has to wait for it.
    expect(result.current.plan?.manual).toEqual(['wsl2']);
    expect(result.current.plan?.deferred).toEqual(['docker-desktop', 'docker-running']);
  });

  it('says so when main refuses', async () => {
    const install = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'devSetup:install': Error: Invalid dev setup items.",
      );
    });
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ install }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    await act(async () => result.current.install(['gh']));

    expect(toast.error).toHaveBeenCalledWith(
      'Could not start the install. Invalid dev setup items.',
    );
  });

  it('cancels the whole run, or one waiting step', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    act(() => result.current.cancel());
    act(() => result.current.cancel('node'));

    expect(bridge.$fn('devSetup.cancel')).toHaveBeenNthCalledWith(1, undefined);
    expect(bridge.$fn('devSetup.cancel')).toHaveBeenNthCalledWith(2, 'node');
  });
});

describe('agreements', () => {
  const FLUTTER_STACKS = ['essentials', 'flutter'];

  async function setup(install = vi.fn(async () => IDLE)) {
    const view = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ stacks: FLUTTER_STACKS, install }),
    });
    await waitFor(() => expect(view.result.current.checklist?.summary.checking).toBe(0));
    return { ...view, install };
  }

  it('asks before installing something that comes with an agreement, and lists it', async () => {
    const { result } = await setup();

    let finished = false;
    act(() => {
      void result.current.install(['android-licenses']).then(() => {
        finished = true;
      });
    });

    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    const asked = useConfirmStore.getState();
    expect(asked.confirmLabel).toBe('Accept and install');
    expect(asked.items).toEqual([
      { name: 'Android SDK licenses', detail: 'https://developer.android.com/studio/terms' },
    ]);
    expect(finished).toBe(false);
    act(() => resolveConfirm(false));
  });

  it('goes ahead, saying the agreements were accepted, once the person agrees', async () => {
    const { result, install } = await setup();

    act(() => {
      void result.current.install(['android-licenses']);
    });
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    await act(async () => resolveConfirm(true));

    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ ids: ['android-licenses'], consented: true }),
    );
  });

  it('does not install anything when the person says no', async () => {
    const { result, install } = await setup();

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.install(['android-licenses']);
    });
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    await act(async () => {
      resolveConfirm(false);
      await done;
    });

    expect(install).not.toHaveBeenCalled();
  });

  it('does not ask for something with no agreement', async () => {
    const { result, install } = await setup();

    await act(async () => result.current.install(['jdk17']));

    expect(useConfirmStore.getState().open).toBe(false);
    expect(install).toHaveBeenCalledWith({ ids: ['jdk17'], consented: false });
  });
});

describe('an agreement that only main knew about', () => {
  const REFUSED = new Error(
    "Error invoking remote method 'devSetup:install': Error: consent-required",
  );

  /**
   * The page last saw the Android licenses as installed, so its own plan has no agreement in it.
   * Main looked again, found them missing and refused. When `recheckFindsThem` is set, a fresh
   * look at the machine from here finds them missing too, once main has refused.
   */
  async function setup({ recheckFindsThem }: { recheckFindsThem: boolean }) {
    let refused = false;
    const install = vi.fn(async (request: { consented?: boolean }) => {
      if (request.consented) return IDLE;
      refused = recheckFindsThem;
      throw REFUSED;
    });
    const view = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        stacks: ['essentials', 'flutter'],
        detect: async (id) => (id === 'android-licenses' && !refused ? found('1') : absent),
        install: (request) => install(request as { consented?: boolean }),
      }),
    });
    await waitFor(() => expect(view.result.current.checklist?.summary.checking).toBe(0));
    return { ...view, install };
  }

  it('asks the person with the usual agreement dialog, and never shows the code', async () => {
    const { result } = await setup({ recheckFindsThem: true });

    act(() => {
      void result.current.install(['android-licenses']);
    });

    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    expect(useConfirmStore.getState().confirmLabel).toBe('Accept and install');
    expect(useConfirmStore.getState().items).toEqual([
      { name: 'Android SDK licenses', detail: 'https://developer.android.com/studio/terms' },
    ]);
    expect(toast.error).not.toHaveBeenCalled();
    act(() => resolveConfirm(false));
  });

  it('installs with the agreement accepted once the person agrees', async () => {
    const { result, install } = await setup({ recheckFindsThem: true });

    act(() => {
      void result.current.install(['android-licenses']);
    });
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    await act(async () => resolveConfirm(true));

    await waitFor(() =>
      expect(install).toHaveBeenLastCalledWith({ ids: ['android-licenses'], consented: true }),
    );
    expect(install).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stops quietly when the person says no', async () => {
    const { result, install } = await setup({ recheckFindsThem: true });

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.install(['android-licenses']);
    });
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    await act(async () => {
      resolveConfirm(false);
      await done;
    });

    expect(install).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says something plain when it still cannot tell which agreement it is', async () => {
    const { result } = await setup({ recheckFindsThem: false });

    await act(async () => result.current.install(['android-licenses']));

    expect(useConfirmStore.getState().open).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const shown = String(toast.error.mock.calls[0]?.[0]);
    expect(shown).not.toContain('consent-required');
    expect(shown).toMatch(/^Could not start the install\. \S/);
  });
});
