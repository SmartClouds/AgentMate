import type { DevDetection, DevSetupEnvironment, DevUpdateCheck } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  renderHookWithProviders,
  userEvent,
} from '../../../../../test/renderer/renderWithProviders';
import { useDevSetup } from './useDevSetup';

/**
 * The hook behind the Dev Setup panel. The things worth pinning are the ones the experience
 * depends on: each row resolving on its own instead of waiting for the slowest probe, a failed
 * probe becoming a row rather than a crash, the terminal hand-off re-checking by itself, and the
 * user's stack choices surviving a reload.
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
const found = (version: string): DevDetection => ({
  state: 'found',
  version,
  path: null,
  onPath: true,
});
const absent: DevDetection = { state: 'absent' };

/** A detect() that answers from a map, and says "absent" for anything not listed. */
function detectFrom(answers: Record<string, DevDetection | Promise<DevDetection>>) {
  return (id: string) => Promise.resolve(answers[id] ?? absent);
}

function bridgeFor(
  options: {
    stacks?: string[];
    detect?: (id: string, options?: { force?: boolean }) => Promise<DevDetection>;
    environment?: DevSetupEnvironment | (() => Promise<DevSetupEnvironment>);
    updates?: (
      ids: string[],
      options?: { force?: boolean },
    ) => Promise<Record<string, DevUpdateCheck>>;
  } = {},
) {
  return {
    'settings.get': { devSetupStacks: options.stacks ?? ['essentials'] },
    'settings.update': async (patch: unknown) => patch,
    'devSetup.environment': options.environment ?? WIN,
    'devSetup.detect': options.detect ?? detectFrom({}),
    ...(options.updates ? { 'devSetup.updates': options.updates } : {}),
  };
}

const behind = (latest: string, installed: string | null = null): DevUpdateCheck => ({
  state: 'update',
  latest,
  installed,
});

/** An updates() that answers from a map, and says "current" for anything not listed. */
function updatesFrom(answers: Record<string, DevUpdateCheck>) {
  return async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, answers[id] ?? ({ state: 'current' } as const)]));
}

beforeEach(() => {
  toast.info.mockReset();
  toast.error.mockReset();
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDevSetup: loading', () => {
  it('has no checklist until the machine has been described', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ environment: () => new Promise(() => undefined) }),
    });

    expect(result.current.checklist).toBeUndefined();
    expect(result.current.environmentFailed).toBe(false);
  });

  it('lists the Essentials items, each one checking until its own probe answers', async () => {
    const pending = new Promise<DevDetection>(() => undefined);
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: (id) =>
          id === 'node' ? pending : Promise.resolve(id === 'git' ? found('2.55.0') : absent),
      }),
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());
    await waitFor(() => {
      const states = Object.fromEntries(
        result.current.checklist?.rows.map((row) => [row.item.id, row.state.kind]) ?? [],
      );
      // git has answered, node is still thinking, and neither waited for the other.
      expect(states.git).toBe('installed');
      expect(states.node).toBe('checking');
      expect(states.gh).toBe('missing');
    });
  });

  it('turns a probe that failed to run into a row, not a crash', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: (id) =>
          id === 'git' ? Promise.reject(new Error('spawn blew up')) : Promise.resolve(absent),
      }),
    });

    await waitFor(() => {
      const git = result.current.checklist?.rows.find((row) => row.item.id === 'git');
      expect(git?.state).toEqual({ kind: 'unknown', message: 'spawn blew up' });
    });
  });

  it('reports that the machine could not be described, and can try again', async () => {
    let calls = 0;
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        environment: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('nope')) : Promise.resolve(WIN);
        },
      }),
    });

    await waitFor(() => expect(result.current.environmentFailed).toBe(true));
    expect(result.current.checklist).toBeUndefined();

    act(() => result.current.retryEnvironment());
    await waitFor(() => expect(result.current.checklist).toBeDefined());
    expect(result.current.environmentFailed).toBe(false);
  });
});

describe('useDevSetup: stacks', () => {
  it('shows Essentials until the saved settings say otherwise', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: { ...bridgeFor(), 'settings.get': () => new Promise(() => undefined) },
    });

    expect(result.current.stacks).toEqual(['essentials']);
  });

  it('reads the stacks the user chose, and lists their items', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ stacks: ['essentials', 'docker'] }),
    });

    await waitFor(() => expect(result.current.stacks).toEqual(['essentials', 'docker']));
    await waitFor(() =>
      expect(result.current.checklist?.rows.map((row) => row.item.id)).toContain('docker-desktop'),
    );
  });

  it('saves a stack when it is switched on, and takes it back out when it is switched off', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ stacks: ['essentials', 'dotnet'] }),
    });
    await waitFor(() => expect(result.current.stacks).toEqual(['essentials', 'dotnet']));

    act(() => result.current.toggleStack('docker'));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({
        devSetupStacks: ['essentials', 'dotnet', 'docker'],
      }),
    );

    act(() => result.current.toggleStack('dotnet'));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({
        devSetupStacks: ['essentials'],
      }),
    );
  });

  it('never lets Essentials be switched off', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    act(() => result.current.toggleStack('essentials'));

    expect(() => bridge.$fn('settings.update')).toThrow();
  });

  it('ignores a stack id that is not in the catalog', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor(),
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    act(() => result.current.toggleStack('bogus'));

    expect(() => bridge.$fn('settings.update')).toThrow();
  });

  it('shows the new choice straight away, before the save comes back', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: {
        ...bridgeFor(),
        'settings.update': () => new Promise(() => undefined),
      },
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    act(() => result.current.toggleStack('flutter'));

    await waitFor(() => expect(result.current.stacks).toEqual(['essentials', 'flutter']));
  });

  it('says so when the choice could not be saved', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: { ...bridgeFor(), 'settings.update': () => Promise.reject(new Error('disk full')) },
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    act(() => result.current.toggleStack('docker'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save your choice.'));
  });
});

describe('useDevSetup: checking again', () => {
  it('asks for a fresh answer when told to check one item again', async () => {
    const detect = vi.fn(detectFrom({}));
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    detect.mockClear();

    act(() => result.current.recheck('git'));

    await waitFor(() => expect(detect).toHaveBeenCalledWith('git', { force: true }));
    expect(detect).not.toHaveBeenCalledWith('node', expect.anything());
  });

  it('checks everything again, and the machine too, since a package manager may have been added', async () => {
    const detect = vi.fn(detectFrom({}));
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    detect.mockClear();
    bridge.$fn('devSetup.environment').mockClear();

    act(() => result.current.recheckAll());

    await waitFor(() => expect(detect).toHaveBeenCalledWith('node', { force: true }));
    expect(detect).toHaveBeenCalledWith('git', { force: true });
    await waitFor(() => expect(bridge.$fn('devSetup.environment')).toHaveBeenCalled());
  });
});

describe('useDevSetup: updates', () => {
  const installed = detectFrom({
    git: found('2.55.0'),
    node: found('24.20.0'),
    npm: found('11.19.0'),
    gh: found('2.102.0'),
  });
  const rowOf = (result: { current: ReturnType<typeof useDevSetup> }, id: string) =>
    result.current.checklist?.rows.find((row) => row.item.id === id);

  it('asks once for each source, with the items that source covers', async () => {
    const updates = vi.fn(updatesFrom({}));
    renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect: installed, updates }),
    });

    await waitFor(() => expect(updates).toHaveBeenCalledTimes(2));

    expect(updates).toHaveBeenCalledWith(['git', 'node', 'gh'], { force: false });
    expect(updates).toHaveBeenCalledWith(['pnpm'], { force: false });
  });

  it('puts what it finds on the row, which stays ready', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: updatesFrom({ gh: behind('2.103.0', '2.102.0') }),
      }),
    });

    await waitFor(() =>
      expect(rowOf(result, 'gh')?.state).toMatchObject({
        kind: 'installed',
        update: { latest: '2.103.0' },
      }),
    );
    expect(rowOf(result, 'git')?.state).not.toHaveProperty('update');
    expect(result.current.checklist?.summary).toMatchObject({ ready: 4, total: 4, updates: 1 });
  });

  it('shows the answer of a quick source without waiting for a slow one', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: async (ids) =>
          ids.includes('pnpm')
            ? new Promise<Record<string, DevUpdateCheck>>(() => undefined)
            : { gh: behind('2.103.0', '2.102.0') },
      }),
    });

    await waitFor(() =>
      expect(rowOf(result, 'gh')?.state).toMatchObject({ update: expect.any(Object) }),
    );
    // The registry has not answered, and the page says it is still looking.
    expect(result.current.updatesStatus).toBe('checking');
  });

  it('says the check failed when nothing that is installed got an answer', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: async (ids) =>
          Object.fromEntries(ids.map((id) => [id, { state: 'unknown' } as const])),
      }),
    });

    await waitFor(() => expect(result.current.updatesStatus).toBe('failed'));
    expect(result.current.checklist?.summary.updates).toBe(0);
  });

  it('is not a failure when the only unknowns are tools that are not installed', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: async (ids) =>
          Object.fromEntries(
            ids.map((id) => [id, id === 'pnpm' ? { state: 'unknown' } : { state: 'current' }]),
          ) as Record<string, DevUpdateCheck>,
      }),
    });

    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    await waitFor(() => expect(result.current.updatesStatus).toBe('done'));
  });

  it('copes with a bridge that has nothing to say about updates', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect: installed }),
    });

    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    await waitFor(() => expect(result.current.updatesStatus).not.toBe('checking'));
    expect(result.current.checklist?.summary.updates).toBe(0);
  });

  it('updates the tools named, as an update and without any agreement', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: updatesFrom({ gh: behind('2.103.0', '2.102.0') }),
      }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    await waitFor(() => expect(result.current.updatesStatus).toBe('done'));

    await act(async () => result.current.update(['gh']));

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({ ids: ['gh'], intent: 'update' });
  });

  it('updates everything the app can run when asked to update all', async () => {
    const { result, bridge } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: updatesFrom({
          node: behind('24.22.1', '24.20.0'),
          gh: behind('2.103.0', '2.102.0'),
        }),
      }),
    });
    await waitFor(() => expect(result.current.updatePlan?.steps).toEqual(['node', 'gh']));

    await act(async () => result.current.updateAll());

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({
      ids: ['node', 'gh'],
      intent: 'update',
    });
  });

  it('says so when an update could not be started', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: {
        ...bridgeFor({ detect: installed, updates: updatesFrom({}) }),
        'devSetup.install': async () => {
          throw new Error("Error invoking remote method 'devSetup:install': Error: busy");
        },
      },
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    await act(async () => result.current.update(['gh']));

    expect(toast.error).toHaveBeenCalledWith('Could not start the update. busy');
  });

  it('asks every source again, and forces it, when everything is checked again', async () => {
    const updates = vi.fn(updatesFrom({}));
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect: installed, updates }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    await waitFor(() => expect(result.current.updatesStatus).toBe('done'));
    updates.mockClear();

    act(() => result.current.recheckAll());

    await waitFor(() =>
      expect(updates).toHaveBeenCalledWith(['git', 'node', 'gh'], { force: true }),
    );
    expect(updates).toHaveBeenCalledWith(['pnpm'], { force: true });
  });

  it('keeps showing an update while it is asked about again, instead of flickering', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({
        detect: installed,
        updates: async (ids) => {
          calls += 1;
          if (calls > 2) await new Promise<void>((resolve) => (release = resolve));
          return Object.fromEntries(
            ids.map((id) => [
              id,
              id === 'gh' ? behind('2.103.0', '2.102.0') : { state: 'current' },
            ]),
          ) as Record<string, DevUpdateCheck>;
        },
      }),
    });
    await waitFor(() =>
      expect(rowOf(result, 'gh')?.state).toMatchObject({ update: expect.any(Object) }),
    );

    act(() => result.current.recheckAll());
    await waitFor(() => expect(result.current.updatesStatus).toBe('checking'));

    expect(rowOf(result, 'gh')?.state).toMatchObject({ update: { latest: '2.103.0' } });
    release?.();
  });

  it('asks again about one tool, forced, when its row is checked again', async () => {
    const updates = vi.fn(updatesFrom({ gh: behind('2.103.0', '2.102.0') }));
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect: installed, updates }),
    });
    await waitFor(() =>
      expect(rowOf(result, 'gh')?.state).toMatchObject({ update: expect.any(Object) }),
    );
    updates.mockClear();

    act(() => result.current.recheck('gh'));

    await waitFor(() => expect(updates).toHaveBeenCalledWith(['gh'], { force: true }));
  });

  it('does not ask about updates when a row without one is checked again', async () => {
    const updates = vi.fn(updatesFrom({}));
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect: installed, updates }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    await waitFor(() => expect(result.current.updatesStatus).toBe('done'));
    updates.mockClear();

    act(() => result.current.recheck('git'));
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    expect(updates).not.toHaveBeenCalledWith(['git'], { force: true });
  });

  describe('handed to a terminal', () => {
    const COMMAND = 'sudo apt-get install -y --only-upgrade gh';

    it('opens a terminal that says update, and waits on the row without calling it installed', async () => {
      const { result } = renderHookWithProviders(() => useDevSetup(), {
        bridge: bridgeFor({
          detect: installed,
          updates: updatesFrom({ gh: behind('2.103.0', '2.102.0') }),
        }),
      });
      await waitFor(() =>
        expect(rowOf(result, 'gh')?.state).toMatchObject({ update: expect.any(Object) }),
      );

      act(() =>
        result.current.openInTerminal({
          id: 'gh',
          name: 'GitHub CLI',
          command: COMMAND,
          intent: 'update',
        }),
      );

      expect(useTerminalStore.getState().sessions[0]).toMatchObject({
        title: 'Update GitHub CLI',
        initialInput: COMMAND,
      });
      expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to update GitHub CLI.');
      expect(rowOf(result, 'gh')?.state).toMatchObject({
        kind: 'installed',
        update: { waiting: true },
      });
    });

    it('looks at that one update every few seconds and stops once it is gone', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let updated = false;
      const updates = vi.fn(async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            id === 'gh' && !updated
              ? behind('2.103.0', '2.102.0')
              : ({ state: 'current' } as const),
          ]),
        ),
      );
      const { result } = renderHookWithProviders(() => useDevSetup(), {
        bridge: bridgeFor({ detect: installed, updates }),
      });
      await waitFor(() =>
        expect(rowOf(result, 'gh')?.state).toMatchObject({ update: expect.any(Object) }),
      );

      act(() =>
        result.current.openInTerminal({
          id: 'gh',
          name: 'GitHub CLI',
          command: COMMAND,
          intent: 'update',
        }),
      );
      updates.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_200);
      });
      // Asked about by name and forced, so it is not a whole winget list every five seconds.
      expect(updates).toHaveBeenCalledWith(['gh'], { force: true });

      updated = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_200);
      });
      await waitFor(() => expect(rowOf(result, 'gh')?.state).not.toHaveProperty('update'));

      updates.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      expect(updates).not.toHaveBeenCalledWith(['gh'], { force: true });
    });
  });
});

describe('useDevSetup: the terminal hand-off', () => {
  const COMMAND = 'winget install --id GitHub.cli';

  it('opens a terminal with the command typed in but not run, and tells the person what to do', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), { bridge: bridgeFor() });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    act(() => result.current.openInTerminal({ id: 'gh', name: 'GitHub CLI', command: COMMAND }));

    const [session] = useTerminalStore.getState().sessions;
    expect(session).toMatchObject({ title: 'Install GitHub CLI', initialInput: COMMAND });
    expect(session?.initialInput?.endsWith('\n')).toBe(false);
    expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to install GitHub CLI.');
  });

  it('marks the row as waiting for the terminal', async () => {
    const { result } = renderHookWithProviders(() => useDevSetup(), { bridge: bridgeFor() });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    act(() => result.current.openInTerminal({ id: 'gh', name: 'GitHub CLI', command: COMMAND }));

    const gh = result.current.checklist?.rows.find((row) => row.item.id === 'gh');
    expect(gh?.state).toEqual({ kind: 'waiting-terminal' });
  });

  it('checks again every few seconds while waiting, and stops once the tool turns up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let installed = false;
    const detect = vi.fn(async (id: string) =>
      id === 'gh' && installed ? found('2.62.0') : absent,
    );
    const { result } = renderHookWithProviders(() => useDevSetup(), {
      bridge: bridgeFor({ detect }),
    });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));

    act(() => result.current.openInTerminal({ id: 'gh', name: 'GitHub CLI', command: COMMAND }));
    detect.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_200);
    });
    expect(detect.mock.calls.filter(([id]) => id === 'gh').length).toBeGreaterThanOrEqual(1);

    installed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_200);
    });
    await waitFor(() => {
      const gh = result.current.checklist?.rows.find((row) => row.item.id === 'gh');
      expect(gh?.state).toMatchObject({ kind: 'installed', version: '2.62.0' });
    });

    // Found, so it is no longer being waited on and the polling stops.
    detect.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(detect.mock.calls.filter(([id]) => id === 'gh')).toHaveLength(0);
  });

  it('gives up waiting after ten minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHookWithProviders(() => useDevSetup(), { bridge: bridgeFor() });
    await waitFor(() => expect(result.current.checklist?.summary.checking).toBe(0));
    act(() => result.current.openInTerminal({ id: 'gh', name: 'GitHub CLI', command: COMMAND }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 6_000);
    });

    await waitFor(() => {
      const gh = result.current.checklist?.rows.find((row) => row.item.id === 'gh');
      expect(gh?.state.kind).toBe('missing');
    });
  });

  it('copies the command to the clipboard', async () => {
    // renderHookWithProviders does not set userEvent up, and that is what installs a clipboard.
    userEvent.setup();
    const { result } = renderHookWithProviders(() => useDevSetup(), { bridge: bridgeFor() });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    await act(async () => {
      await result.current.copyCommand({ name: 'GitHub CLI', command: COMMAND });
    });

    // userEvent.setup() replaces navigator.clipboard, so the text is read back rather than spied on.
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
    expect(toast.success).toHaveBeenCalledWith('Copied the command for GitHub CLI.');
  });
});
