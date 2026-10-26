import type {
  DevDetection,
  DevJobEvent,
  DevJobState,
  DevSetupEnvironment,
  DevUpdateCheck,
} from '@runova/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DevSetupPanel } from './DevSetupPanel';

/**
 * The whole Dev Setup panel against a fake machine: what appears while it looks, what each answer
 * turns into, and what a click on a row actually does.
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

/** git, node and npm are there, the GitHub CLI is not. */
const MOST: Record<string, DevDetection> = {
  git: found('2.55.0'),
  node: found('22.12.0'),
  npm: found('10.9.0'),
};

function bridgeFor(
  options: {
    environment?: DevSetupEnvironment | (() => Promise<DevSetupEnvironment>);
    detections?: Record<string, DevDetection>;
    stacks?: string[];
    /** What the update check says per tool. Anything not listed is current. Left out: no check. */
    updates?: Record<string, DevUpdateCheck>;
  } = {},
) {
  const detections = options.detections ?? MOST;
  const updates = options.updates;
  // Settings that remember what was saved, as the real store does, so a toggle sticks.
  let saved: Record<string, unknown> = { devSetupStacks: options.stacks ?? ['essentials'] };
  return {
    'settings.get': async () => saved,
    'settings.update': async (patch: Record<string, unknown>) => {
      saved = { ...saved, ...patch };
      return saved;
    },
    'devSetup.environment': options.environment ?? WIN,
    'devSetup.detect': async (id: string) => detections[id] ?? absent,
    ...(updates
      ? {
          'devSetup.updates': async (ids: string[]) =>
            Object.fromEntries(ids.map((id) => [id, updates[id] ?? { state: 'current' }])),
        }
      : {}),
    'devSetup.jobState': IDLE,
    'devSetup.install': async () => IDLE,
    'devSetup.cancel': async () => undefined,
    'devSetup.addToPath': async () => ({ changed: true, where: 'your user PATH' }),
    'shell.openExternal': async () => undefined,
  };
}

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

/** Fires a job event the way the preload would deliver it. */
const emit = (
  bridge: { $emit: (path: string, ...args: unknown[]) => void },
  ...events: DevJobEvent[]
) => act(() => events.forEach((event) => bridge.$emit('devSetup.onEvent', event)));

function renderPanel(bridge = bridgeFor(), route = '/') {
  return renderWithProviders(<DevSetupPanel />, { bridge, route });
}

beforeEach(() => {
  toast.info.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

describe('DevSetupPanel: loading', () => {
  it('shows a placeholder while it looks at the machine, and does not call anything missing yet', () => {
    renderPanel(bridgeFor({ environment: () => new Promise(() => undefined) }));

    expect(screen.getByRole('status', { name: 'Looking at this computer' })).toBeTruthy();
    expect(screen.queryByText(/not installed/i)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('still lets the person pick their stacks while the machine is being looked at', () => {
    renderPanel(bridgeFor({ environment: () => new Promise(() => undefined) }));

    expect(screen.getByRole('heading', { name: 'What do you build?' })).toBeTruthy();
  });

  it('offers to try again when the machine could not be looked at', async () => {
    let calls = 0;
    const { user } = renderPanel(
      bridgeFor({
        environment: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(WIN);
        },
      }),
    );

    expect(await screen.findByText('Could not look at this computer.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByRole('heading', { name: /ready$/ })).toBeTruthy();
  });
});

describe('DevSetupPanel: the checklist', () => {
  it('shows how far along the machine is', async () => {
    renderPanel();

    expect(await screen.findByRole('heading', { name: '3 of 4 ready' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Dev setup progress' })).toHaveAttribute(
      'aria-valuenow',
      '3',
    );
  });

  it('lists the tools under their stack, each with what it found', async () => {
    renderPanel();

    // Each row answers on its own, so wait for the whole list to settle before reading it.
    await screen.findByRole('heading', { name: '3 of 4 ready' });
    const essentials = screen.getByRole('region', { name: 'Essentials' });
    expect(within(essentials).getByText('Git')).toBeTruthy();
    expect(within(essentials).getByText('Version 2.55.0')).toBeTruthy();
    expect(within(essentials).getByText('Version 22.12.0')).toBeTruthy();
    expect(within(essentials).getByText('GitHub CLI')).toBeTruthy();
    expect(within(essentials).getByText('Not installed. Needs 2.40 or newer.')).toBeTruthy();
    expect(within(essentials).getByText('3 of 4 ready')).toBeTruthy();
  });

  it('only lists the stacks that are switched on', async () => {
    renderPanel();
    await screen.findByRole('region', { name: 'Essentials' });

    expect(screen.queryByRole('region', { name: 'Docker' })).toBeNull();
    expect(screen.queryByRole('region', { name: '.NET' })).toBeNull();
  });

  it('shows the stacks the person chose', async () => {
    renderPanel(bridgeFor({ stacks: ['essentials', 'docker'] }));

    expect(await screen.findByRole('region', { name: 'Docker' })).toBeTruthy();
    expect(screen.getByText('Windows Subsystem for Linux')).toBeTruthy();
  });

  it('turns a stack on from its chip, and remembers the choice', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByRole('region', { name: 'Essentials' });

    await user.click(screen.getByRole('button', { name: 'Docker' }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        devSetupStacks: ['essentials', 'docker'],
      }),
    );
    expect(await screen.findByRole('region', { name: 'Docker' })).toBeTruthy();
  });

  it('switches on the stack a link asks for, keeping the stacks already chosen', async () => {
    const { bridge } = renderPanel(
      bridgeFor({ stacks: ['essentials', 'docker'] }),
      '/tools?tab=dev-setup&stack=studio',
    );
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        devSetupStacks: ['essentials', 'docker', 'studio'],
      }),
    );
    expect(await screen.findByRole('region', { name: 'Studio' })).toBeTruthy();
    expect(screen.getByText('ffmpeg')).toBeTruthy();
  });

  it('leaves the choice alone when the stack a link asks for is already on, or is not a stack', async () => {
    const on = renderPanel(bridgeFor({ stacks: ['essentials', 'studio'] }), '/tools?stack=studio');
    await screen.findByRole('region', { name: 'Studio' });
    on.unmount();
    const other = renderPanel(bridgeFor(), '/tools?stack=nonsense');
    await screen.findByRole('region', { name: 'Essentials' });
    // Nothing ever saved the settings.
    for (const { bridge } of [on, other]) {
      expect(() => bridge.$fn('settings.update')).toThrow('has not been touched');
    }
  });

  it('checks everything again from the summary card', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });
    bridge.$fn('devSetup.detect').mockClear();

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() =>
      expect(bridge.$fn('devSetup.detect')).toHaveBeenCalledWith('gh', { force: true }),
    );
  });
});

describe('DevSetupPanel: notices', () => {
  it('explains what is different when winget is missing, and points at the fix', async () => {
    const { user, bridge } = renderPanel(
      bridgeFor({ environment: { ...WIN, packageManagers: [] } }),
    );

    expect(await screen.findByText(/winget was not found/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open the Microsoft Store page' }));

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(
      'https://apps.microsoft.com/detail/9nblggh4nns1',
    );
  });

  it('says nothing about winget when it is there', async () => {
    renderPanel();
    await screen.findByRole('region', { name: 'Essentials' });

    expect(screen.queryByText(/winget was not found/)).toBeNull();
  });

  it('says so when a Linux machine has no package manager it knows', async () => {
    renderPanel(bridgeFor({ environment: { os: 'linux', arch: 'x64', packageManagers: [] } }));

    expect(await screen.findByText(/No supported package manager was found/)).toBeTruthy();
  });
});

describe('DevSetupPanel: installing', () => {
  it('installs in the app when the main button is pressed', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await user.click(screen.getByRole('button', { name: 'Install GitHub CLI' }));

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({ ids: ['gh'], consented: false });
    // Nothing is typed into a terminal: the app does this one itself.
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('offers to install everything that is missing, with a count', async () => {
    const { user, bridge } = renderPanel();

    const button = await screen.findByRole('button', { name: 'Install all missing (1)' });
    await user.click(button);

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({ ids: ['gh'], consented: false });
  });

  it('turns Install all off, and says why, when only the person can do what is left', async () => {
    const { user } = renderPanel(
      bridgeFor({
        stacks: ['essentials', 'docker'],
        detections: { ...MOST, gh: found('2.62.0') },
      }),
    );

    const button = await screen.findByRole('button', { name: 'Install all missing' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement as HTMLElement);
    expect(
      (await screen.findAllByText(/What is left needs a terminal or a download first/)).length,
    ).toBeGreaterThan(0);
  });

  it('says what Install all will leave for the person', async () => {
    renderPanel(bridgeFor({ stacks: ['essentials', 'docker'] }));

    expect(await screen.findByText(/1 more step needs a terminal or a download/)).toBeTruthy();
  });

  it('hands the steps only the person can do to the terminal', async () => {
    const { user, bridge } = renderPanel(
      bridgeFor({
        stacks: ['essentials', 'docker'],
        detections: { ...MOST, gh: found('2.62.0') },
      }),
    );
    await screen.findByRole('region', { name: 'Docker' });

    // WSL cannot be installed from here, so its main button opens a terminal.
    await user.click(screen.getByRole('button', { name: 'Install Windows Subsystem for Linux' }));

    expect(useTerminalStore.getState().sessions[0]?.initialInput).toBe(
      'wsl --install --no-distribution',
    );
    expect(() => bridge.$fn('devSetup.install')).toThrow();
  });
});

describe('DevSetupPanel: during a run', () => {
  async function startRun() {
    const view = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });
    await emit(
      view.bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'started', jobId: 'a', itemId: 'gh' },
      {
        type: 'progress',
        jobId: 'a',
        itemId: 'gh',
        phase: 'downloading',
        fraction: 0.4,
        detail: '4 of 10 MB',
      },
    );
    return view;
  }

  it('speaks of the run, and shows the step with its own progress', async () => {
    await startRun();

    expect(screen.getByRole('heading', { name: 'Installing 1 of 1: GitHub CLI' })).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'GitHub CLI: Downloading 4 of 10 MB' }),
    ).toHaveAttribute('aria-valuenow', '40');
  });

  it('cancels the whole run from the summary', async () => {
    const { user, bridge } = await startRun();

    await user.click(screen.getByRole('button', { name: 'Cancel install' }));

    expect(bridge.$fn('devSetup.cancel')).toHaveBeenCalledWith(undefined);
  });

  it('cancels from the row too', async () => {
    const { user, bridge } = await startRun();

    await user.click(screen.getByRole('button', { name: 'Cancel installing GitHub CLI' }));

    expect(bridge.$fn('devSetup.cancel')).toHaveBeenCalledWith(undefined);
  });

  it('takes a waiting step out of the queue by itself', async () => {
    const { user, bridge } = renderPanel(bridgeFor({ detections: {} }));
    await screen.findByRole('heading', { name: '0 of 4 ready' });
    await emit(
      bridge,
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
    );

    await user.click(screen.getByRole('button', { name: 'Remove Node.js from the queue' }));

    expect(bridge.$fn('devSetup.cancel')).toHaveBeenCalledWith('node');
  });

  it('does not offer Install all in the middle of a run', async () => {
    await startRun();

    expect(screen.queryByRole('button', { name: /Install all/ })).toBeNull();
  });
});

describe('DevSetupPanel: when an install goes wrong', () => {
  async function failRun() {
    const view = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });
    await emit(
      view.bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'started', jobId: 'a', itemId: 'gh' },
      { type: 'log', jobId: 'a', itemId: 'gh', line: 'Found GitHub CLI' },
      { type: 'log', jobId: 'a', itemId: 'gh', line: 'Installer failed with exit code 1603' },
      {
        type: 'finished',
        jobId: 'a',
        itemId: 'gh',
        result: 'failed',
        message: 'winget could not finish (code 1603).',
        exitCode: 1603,
      },
      { type: 'done', jobId: 'a', cancelled: false },
    );
    return view;
  }

  it('says what went wrong on the row', async () => {
    await failRun();

    expect(screen.getByText('winget could not finish (code 1603).')).toBeTruthy();
  });

  it('opens the log by itself, since that is where the person will look next', async () => {
    await failRun();

    const log = await screen.findByRole('log', { name: 'Log for GitHub CLI' });
    expect(log.textContent).toBe('Found GitHub CLI\nInstaller failed with exit code 1603');
  });

  it('lets the person close the log, and open it again from the row', async () => {
    const { user } = await failRun();
    await screen.findByRole('log');

    await user.click(screen.getByRole('button', { name: 'Close log' }));
    expect(screen.queryByRole('log')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show the GitHub CLI install log' }));
    expect(await screen.findByRole('log', { name: 'Log for GitHub CLI' })).toBeTruthy();
  });

  it('tries the install again when asked', async () => {
    const { user, bridge } = await failRun();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({ ids: ['gh'], consented: false });
  });

  it('still offers the terminal and the clipboard for the same install', async () => {
    await failRun();

    expect(
      screen.getByRole('button', { name: 'Open the GitHub CLI install in a terminal' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Copy the GitHub CLI install command' }),
    ).toBeTruthy();
  });
});

describe('DevSetupPanel: after an install', () => {
  async function finishRun(restartAdvised = false) {
    const view = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });
    await emit(
      view.bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'started', jobId: 'a', itemId: 'gh' },
      { type: 'finished', jobId: 'a', itemId: 'gh', result: 'installed', restartAdvised },
      { type: 'done', jobId: 'a', cancelled: false },
    );
    return view;
  }

  it('warns that a terminal that was already open will not see the new tool', async () => {
    await finishRun();

    expect(
      screen.getByText(/Terminals that are already open will not see the new tools/),
    ).toBeTruthy();
  });

  it('says nothing of the kind before anything was installed', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    expect(screen.queryByText(/Terminals that are already open/)).toBeNull();
  });

  it('advises a restart when the installer said one is needed', async () => {
    await finishRun(true);

    expect(screen.getByText(/Restart your computer to finish setting up/)).toBeTruthy();
  });

  it('does not mention a restart when none is needed', async () => {
    await finishRun(false);

    expect(screen.queryByText(/Restart your computer/)).toBeNull();
  });
});

describe('DevSetupPanel: the terminal, for installs the person runs', () => {
  it('opens a terminal with the install typed in, and waits for the person to run it', async () => {
    const { user } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await user.click(
      screen.getByRole('button', { name: 'Open the GitHub CLI install in a terminal' }),
    );

    const [session] = useTerminalStore.getState().sessions;
    expect(session?.title).toBe('Install GitHub CLI');
    expect(session?.initialInput).toContain('winget install --id GitHub.cli');
    expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to install GitHub CLI.');
    expect(
      await screen.findByText('Waiting for the terminal. Press Enter there, then check again.'),
    ).toBeTruthy();
  });

  it('copies the command', async () => {
    const { user } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await user.click(screen.getByRole('button', { name: 'Copy the GitHub CLI install command' }));

    expect(await navigator.clipboard.readText()).toContain('winget install --id GitHub.cli');
  });

  it('checks again when a row waiting for the terminal is asked to', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });
    await user.click(
      screen.getByRole('button', { name: 'Open the GitHub CLI install in a terminal' }),
    );
    await screen.findByText(/Waiting for the terminal/);
    bridge.$fn('devSetup.detect').mockClear();

    // The summary card has a "Check again" too; this is the one on the waiting row.
    const essentials = screen.getByRole('region', { name: 'Essentials' });
    await user.click(within(essentials).getByRole('button', { name: 'Check again' }));

    await waitFor(() =>
      expect(bridge.$fn('devSetup.detect')).toHaveBeenCalledWith('gh', { force: true }),
    );
  });

  it('sends a person to the download page when winget is missing', async () => {
    const { user, bridge } = renderPanel(
      bridgeFor({ environment: { ...WIN, packageManagers: [] } }),
    );
    await screen.findByText(/winget was not found/);

    const git = (await screen.findAllByRole('button', { name: 'Open download page' }))[0];
    expect(git).toBeTruthy();
    await user.click(git as HTMLElement);

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\//),
    );
  });
});

describe('DevSetupPanel: a tool that is installed but not on PATH', () => {
  const gitOffPath: DevDetection = {
    state: 'found',
    version: '2.55.0',
    path: 'C:\\Git\\cmd\\git.exe',
    onPath: false,
  };

  it('warns about it and offers to put it on the PATH', async () => {
    renderPanel(bridgeFor({ detections: { ...MOST, git: gitOffPath } }));

    expect(await screen.findByText('Not on your PATH')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Git to PATH' })).toBeTruthy();
  });

  it('asks main to do it for that tool when the button is pressed', async () => {
    const { user, bridge } = renderPanel(bridgeFor({ detections: { ...MOST, git: gitOffPath } }));

    await user.click(await screen.findByRole('button', { name: 'Add Git to PATH' }));

    expect(bridge.$fn('devSetup.addToPath')).toHaveBeenCalledWith('git');
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Added Git to your user PATH. Open a new terminal to use it.',
      ),
    );
  });

  it('offers nothing for a tool that is already on the PATH', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    expect(screen.queryByText('Not on your PATH')).toBeNull();
    expect(screen.queryByRole('button', { name: /to PATH$/ })).toBeNull();
  });
});

describe('DevSetupPanel: updates', () => {
  const NODE_BEHIND: DevUpdateCheck = { state: 'update', latest: '24.22.1', installed: '22.12.0' };
  const READY: Record<string, DevDetection> = { ...MOST, gh: found('2.102.0') };
  const GH_BEHIND: DevUpdateCheck = { state: 'update', latest: '2.103.0', installed: '2.102.0' };

  const rowOf = (name: string) => {
    const essentials = screen.getByRole('region', { name: 'Essentials' });
    const row = within(essentials)
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText(name, { selector: 'span' }));
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  };

  it('marks a tool that is ready but behind, with the version on offer and a way to update it', async () => {
    renderPanel(bridgeFor({ updates: { node: NODE_BEHIND } }));

    expect(await screen.findByText('24.22.1 available')).toBeTruthy();
    const node = rowOf('Node.js');
    expect(within(node).getByText('Version 22.12.0')).toBeTruthy();
    expect(within(node).getByRole('button', { name: 'Update Node.js' })).toBeTruthy();
    // It is still counted as ready: only the GitHub CLI is missing.
    expect(screen.getByRole('heading', { name: '3 of 4 ready' })).toBeTruthy();
  });

  it('shows nothing of the kind on a tool that is current', async () => {
    renderPanel(bridgeFor({ updates: { node: NODE_BEHIND } }));
    await screen.findByText('24.22.1 available');

    expect(within(rowOf('Git')).queryByRole('button', { name: /Update/ })).toBeNull();
    expect(within(rowOf('Git')).queryByText(/available/)).toBeNull();
  });

  it('updates the tool in the app when its button is pressed, as an update', async () => {
    const { user, bridge } = renderPanel(bridgeFor({ updates: { node: NODE_BEHIND } }));

    await user.click(await screen.findByRole('button', { name: 'Update Node.js' }));

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({
      ids: ['node'],
      intent: 'update',
    });
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('says how many updates there are, and updates them all from the summary', async () => {
    const { user, bridge } = renderPanel(
      bridgeFor({ detections: READY, updates: { node: NODE_BEHIND, gh: GH_BEHIND } }),
    );

    expect(await screen.findByText(/2 updates available\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Update all (2)' }));

    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({
      ids: ['node', 'gh'],
      intent: 'update',
    });
  });

  it('puts the count on the stack too, so a long list can be scanned', async () => {
    renderPanel(bridgeFor({ detections: READY, updates: { node: NODE_BEHIND, gh: GH_BEHIND } }));

    const essentials = await screen.findByRole('region', { name: 'Essentials' });
    expect(await within(essentials).findByText('2 updates')).toBeTruthy();
    expect(within(essentials).getByText('4 of 4 ready')).toBeTruthy();
  });

  it('leads with Update all, and drops the Install all that has nothing to do, when all is installed', async () => {
    renderPanel(bridgeFor({ detections: READY, updates: { gh: GH_BEHIND } }));

    expect(await screen.findByRole('button', { name: 'Update all (1)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install all missing/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Everything is ready' })).toBeTruthy();
  });

  it('keeps both buttons when something is missing and something is behind', async () => {
    renderPanel(bridgeFor({ updates: { node: NODE_BEHIND } }));

    expect(await screen.findByRole('button', { name: 'Update all (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install all missing (1)' })).toBeTruthy();
  });

  it('keeps the disabled Install all when there are no updates, as it always was', async () => {
    renderPanel(bridgeFor({ detections: READY, updates: {} }));

    const button = await screen.findByRole('button', { name: 'Install all missing' });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull();
    expect(await screen.findByText(/Everything is up to date\./)).toBeTruthy();
  });

  it('says plainly when the updates could not be checked, rather than that all is current', async () => {
    renderPanel(
      bridgeFor({
        detections: READY,
        updates: {
          git: { state: 'unknown' },
          node: { state: 'unknown' },
          gh: { state: 'unknown' },
          pnpm: { state: 'unknown' },
        },
      }),
    );

    expect(await screen.findByText(/Could not check for updates\./)).toBeTruthy();
    expect(screen.queryByText(/Everything is up to date/)).toBeNull();
  });

  it('checks again for updates from the summary, asking the sources afresh', async () => {
    const { user, bridge } = renderPanel(bridgeFor({ detections: READY, updates: {} }));
    await screen.findByText(/Everything is up to date\./);
    bridge.$fn('devSetup.updates').mockClear();

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() =>
      expect(bridge.$fn('devSetup.updates')).toHaveBeenCalledWith(expect.any(Array), {
        force: true,
      }),
    );
  });

  it('keeps the page working when the app has no answer for updates at all', async () => {
    renderPanel(bridgeFor({ detections: READY }));

    expect(await screen.findByRole('heading', { name: 'Everything is ready' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Update/ })).toBeNull();
  });

  it('speaks of updating during an update run, and offers to cancel it in those words', async () => {
    const { bridge } = renderPanel(
      bridgeFor({ detections: READY, updates: { node: NODE_BEHIND, gh: GH_BEHIND } }),
    );
    await screen.findByRole('button', { name: 'Update all (2)' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'u', steps: ['node', 'gh'], intent: 'update' },
      { type: 'started', jobId: 'u', itemId: 'node' },
      { type: 'progress', jobId: 'u', itemId: 'node', phase: 'installing', fraction: null },
    );

    expect(await screen.findByRole('heading', { name: 'Updating 1 of 2: Node.js' })).toBeTruthy();
    expect(within(rowOf('Node.js')).getByText('Updating')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel update' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull();
  });

  it('says why an update failed on the row and offers another go', async () => {
    const { bridge } = renderPanel(bridgeFor({ detections: READY, updates: { gh: GH_BEHIND } }));
    await screen.findByRole('button', { name: 'Update GitHub CLI' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'u', steps: ['gh'], intent: 'update' },
      { type: 'started', jobId: 'u', itemId: 'gh' },
      {
        type: 'finished',
        jobId: 'u',
        itemId: 'gh',
        result: 'failed',
        message: 'Close the app that is using it, then try again.',
      },
      { type: 'done', jobId: 'u', cancelled: false },
    );

    const gh = rowOf('GitHub CLI');
    expect(
      await within(gh).findByText(
        /Update failed\. Close the app that is using it, then try again\./,
      ),
    ).toBeTruthy();
    expect(within(gh).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('tells a screen reader that a tool was updated, and not that it was installed', async () => {
    const { bridge } = renderPanel(bridgeFor({ detections: READY, updates: { gh: GH_BEHIND } }));
    await screen.findByRole('button', { name: 'Update GitHub CLI' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'u', steps: ['gh'], intent: 'update' },
      { type: 'finished', jobId: 'u', itemId: 'gh', result: 'installed' },
    );

    expect(screen.getByRole('status', { name: 'Install updates' }).textContent).toBe(
      'GitHub CLI updated.',
    );
  });

  it('opens a terminal for an update that needs a password, with the upgrade command', async () => {
    const linux: DevSetupEnvironment = { os: 'linux', arch: 'x64', packageManagers: ['apt-get'] };
    const { user } = renderPanel(
      bridgeFor({
        environment: linux,
        detections: READY,
        updates: { gh: { state: 'update', latest: '2.103.0', installed: null } },
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Update GitHub CLI' }));

    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      title: 'Update GitHub CLI',
      initialInput: 'sudo apt-get install -y --only-upgrade gh',
    });
    expect(await screen.findByText(/Waiting for the terminal/)).toBeTruthy();
  });
});

describe('DevSetupPanel: telling a screen reader what happened', () => {
  const region = () => screen.getByRole('status', { name: 'Install updates' });

  it('has a polite live region that starts out empty', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region().textContent).toBe('');
  });

  it('says when a tool finished installing', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'started', jobId: 'a', itemId: 'gh' },
      { type: 'finished', jobId: 'a', itemId: 'gh', result: 'installed' },
    );

    expect(region().textContent).toBe('GitHub CLI installed.');
  });

  it('says when a tool could not be installed', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'started', jobId: 'a', itemId: 'gh' },
      { type: 'finished', jobId: 'a', itemId: 'gh', result: 'failed', message: 'No.' },
    );

    expect(region().textContent).toBe('GitHub CLI could not be installed.');
  });

  it('does not read out progress, which would talk over everything else', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'started', jobId: 'a', itemId: 'gh' },
      { type: 'progress', jobId: 'a', itemId: 'gh', phase: 'downloading', fraction: 0.4 },
    );

    expect(region().textContent).toBe('');
  });

  it('says each result once, as they come in', async () => {
    const { bridge } = renderPanel(bridgeFor({ detections: {} }));
    await screen.findByRole('heading', { name: '0 of 4 ready' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'installed' },
    );
    expect(region().textContent).toBe('Git installed.');

    await emit(bridge, { type: 'finished', jobId: 'a', itemId: 'node', result: 'installed' });
    expect(region().textContent).toBe('Node.js installed.');
  });

  it('says when a run was cancelled', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('heading', { name: '3 of 4 ready' });

    await emit(
      bridge,
      { type: 'plan', jobId: 'a', steps: ['gh'] },
      { type: 'done', jobId: 'a', cancelled: true },
    );

    expect(region().textContent).toBe('Install cancelled.');
  });
});
