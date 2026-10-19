import type { AndroidSdkStatus } from '@agentmat/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useRunPauseStore } from '@/stores/runPauseStore';
import { useRunSessionStore } from '@/stores/runSessionStore';
import { type TerminalSessionMeta, useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useNavigate: () => navigate };
});

const { StatusBar } = await import('./StatusBar');

/**
 * The Android entry in the bottom bar. It is the quick way to see what is running without
 * leaving whatever page you are on, so what matters is that it stays out of the way when there
 * is no SDK, shows real usage rather than a bare count, and every row is a way through to the
 * device it names.
 */

const FULL_SDK: AndroidSdkStatus = {
  status: 'found',
  root: '/home/dev/Android/Sdk',
  source: 'ANDROID_HOME',
  checked: ['/home/dev/Android/Sdk'],
  tools: { adb: true, emulator: true, avdmanager: true, sdkmanager: true },
  adbVersion: '35.0.1',
};

const NO_SDK: AndroidSdkStatus = {
  ...FULL_SDK,
  status: 'missing',
  root: null,
  source: null,
  adbVersion: null,
  tools: { adb: false, emulator: false, avdmanager: false, sdkmanager: false },
};

function emulator(name: string, serial: string | null, over: Record<string, unknown> = {}) {
  return {
    kind: 'emulator',
    avd: {
      name,
      displayName: name.replace(/_/g, ' '),
      device: 'pixel_7',
      manufacturer: 'Google',
      api: 34,
      tag: 'google_apis',
      abi: 'x86_64',
      playStore: false,
      ramMb: 2048,
      storageMb: 6144,
      gpuMode: 'auto',
      systemImageDir: null,
      path: null,
    },
    state: serial ? 'running' : 'stopped',
    serial,
    progress: serial ? 100 : 0,
    adopted: false,
    usage: null,
    lastLine: null,
    error: null,
    ...over,
  };
}

function snapshot(emulators: unknown[], physical: unknown[] = []) {
  return { sdk: FULL_SDK, emulators, physical, broken: [] };
}

function setup(bridge: Record<string, unknown>) {
  navigate.mockClear();
  return renderWithProviders(<StatusBar />, { bridge });
}

describe('the Android status bar entry', () => {
  it('stays out of the bar when there is no SDK on this machine', async () => {
    setup({ 'android.sdk': NO_SDK });

    // Nothing to show and nowhere useful to go, so the bar says nothing about Android.
    await waitFor(() => expect(screen.queryByLabelText(/^Android:/)).not.toBeInTheDocument());
  });

  it('counts the emulators that are actually up', async () => {
    setup({
      'android.sdk': FULL_SDK,
      'android.refresh': snapshot([
        emulator('Pixel_7_API_34', 'emulator-5554'),
        emulator('Pixel_Tablet', null),
      ]),
    });

    expect(await screen.findByText('1 running')).toBeInTheDocument();
  });

  it('opens a list of what is running, with the usage of each', async () => {
    const { user } = setup({
      'android.sdk': FULL_SDK,
      'android.refresh': snapshot([
        emulator('Pixel_7_API_34', 'emulator-5554', {
          usage: { cpuPercent: 23, memoryBytes: 2_147_483_648, cpuReady: true },
        }),
      ]),
    });

    await user.click(await screen.findByLabelText(/^Android:/));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Pixel 7 API 34')).toBeInTheDocument();
    expect(within(panel).getByText('23%')).toBeInTheDocument();
    expect(within(panel).getByText('2.0 GB')).toBeInTheDocument();
  });

  it('says it is measuring before the first CPU sample has a rate', async () => {
    const { user } = setup({
      'android.sdk': FULL_SDK,
      'android.refresh': snapshot([
        emulator('Pixel_7_API_34', 'emulator-5554', {
          usage: { cpuPercent: 0, memoryBytes: 1_073_741_824, cpuReady: false },
        }),
      ]),
    });

    await user.click(await screen.findByLabelText(/^Android:/));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).queryByText('0%')).not.toBeInTheDocument();
    expect(within(panel).getByText(/measuring/i)).toBeInTheDocument();
  });

  it('takes you to the device you clicked', async () => {
    const { user } = setup({
      'android.sdk': FULL_SDK,
      'android.refresh': snapshot([emulator('Pixel_7_API_34', 'emulator-5554')]),
    });

    await user.click(await screen.findByLabelText(/^Android:/));
    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByRole('button', { name: /Pixel 7 API 34/ }));

    expect(navigate).toHaveBeenCalledWith('/android?device=emulator-5554');
  });

  it('offers a way to the page when nothing is running', async () => {
    const { user } = setup({
      'android.sdk': FULL_SDK,
      'android.refresh': snapshot([emulator('Pixel_7_API_34', null)]),
    });

    await user.click(await screen.findByLabelText(/^Android:/));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/No emulators running/i)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /Open the Android page/i }));
    expect(navigate).toHaveBeenCalledWith('/android');
  });

  it('samples usage only while the panel is open', async () => {
    const { user, bridge } = setup({
      'android.sdk': FULL_SDK,
      'android.refresh': snapshot([emulator('Pixel_7_API_34', 'emulator-5554')]),
    });
    const watchUsage = window.agentmat.android.watchUsage;

    await screen.findByText('1 running');
    // The bar is always on screen, so it must not keep a process sampler running behind it.
    expect(watchUsage).not.toHaveBeenCalledWith(true);

    await user.click(screen.getByLabelText(/^Android:/));
    await waitFor(() => expect(bridge.$fn('android.watchUsage')).toHaveBeenCalledWith(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(bridge.$fn('android.watchUsage')).toHaveBeenCalledWith(false));
  });
});

/**
 * The project runs entry: every terminal started with Run, what it is using and where it can be
 * reached, with a way to stop it. It sits in a 24px bar next to the agents, so one run shows its
 * detail and several collapse into a count.
 */
describe('the project runs entry', () => {
  const MB = 1024 * 1024;

  function runInfo(label: string, command: string, kind: 'web' | 'mobile' = 'web') {
    return {
      commandId: label.toLowerCase(),
      label,
      command,
      kind,
      startedAt: Date.now() - 120_000,
    };
  }

  function status(sessionId: string, over: Record<string, unknown> = {}) {
    return {
      sessionId,
      alive: true,
      cpuPercent: 4,
      memBytes: 200 * MB,
      processCount: 3,
      ports: [],
      ...over,
    };
  }

  function runs(
    sessions: TerminalSessionMeta[],
    outputs: Record<string, { urls: string[]; devices: string[] }> = {},
  ): void {
    useTerminalStore.setState({ sessions, activeSessionId: null, isOpen: false });
    useRunSessionStore.setState({ outputs });
    useRunPauseStore.setState({ paused: {}, pending: {} });
  }

  function pauseResult(over: Record<string, unknown> = {}) {
    return {
      ok: true,
      paused: true,
      reason: 'user',
      pausedAt: Date.now(),
      processCount: 3,
      failedCount: 0,
      containersOnly: false,
      ...over,
    };
  }

  const DEV: TerminalSessionMeta = {
    id: 'dev',
    title: 'Apollo',
    projectId: 'apollo',
    run: runInfo('Dev', 'pnpm dev'),
  };

  function setupRuns(statuses: unknown[], extra: Record<string, unknown> = {}) {
    navigate.mockClear();
    return renderWithProviders(<StatusBar />, {
      bridge: {
        'android.sdk': NO_SDK,
        'terminal.runStatus': { available: true, cpuReady: true, sessions: statuses },
        ...extra,
      },
    });
  }

  it('shows one run with its port, CPU and memory', async () => {
    runs([DEV], { dev: { urls: ['http://localhost:5173/'], devices: [] } });
    setupRuns([status('dev', { ports: [5173] })]);

    const chip = await screen.findByRole('button', { name: 'Apollo: Dev' });
    await waitFor(() => expect(within(chip).getByText('4.0%')).toBeInTheDocument());
    expect(within(chip).getByText('Apollo')).toBeInTheDocument();
    expect(within(chip).getByText(/:5173/)).toBeInTheDocument();
    expect(within(chip).getByText('200 MB')).toBeInTheDocument();
  });

  it('collapses several runs into a count with their total usage', async () => {
    runs([DEV, { id: 'api', title: 'Zeus', run: runInfo('API', 'dotnet run') }]);
    setupRuns([status('dev'), status('api', { cpuPercent: 6, memBytes: 300 * MB })]);

    const chip = await screen.findByRole('button', { name: '2 project runs' });
    expect(within(chip).getByText('2 runs')).toBeInTheDocument();
    await waitFor(() => expect(within(chip).getByText('10%')).toBeInTheDocument());
    expect(within(chip).getByText('500 MB')).toBeInTheDocument();
  });

  it('names the device a mobile run went to, as the Android page knows it', async () => {
    runs([{ id: 'app', title: 'Hermes', run: runInfo('App', 'flutter run', 'mobile') }], {
      app: { urls: [], devices: ['emulator-5554'] },
    });
    setupRuns([status('app')]);

    const chip = await screen.findByRole('button', { name: 'Hermes: App' });
    expect(within(chip).getByText('emulator-5554')).toBeInTheDocument();
  });

  it('says a mobile run is still waiting for a device', async () => {
    runs([{ id: 'app', title: 'Hermes', run: runInfo('App', 'flutter run', 'mobile') }]);
    setupRuns([status('app')]);

    const chip = await screen.findByRole('button', { name: 'Hermes: App' });
    expect(within(chip).getByText('waiting for device')).toBeInTheDocument();
  });

  it('marks a run whose command has finished', async () => {
    runs([{ ...DEV, run: { ...runInfo('Dev', 'pnpm dev'), startedAt: Date.now() - 600_000 } }]);
    setupRuns([status('dev', { processCount: 1 })]);

    const chip = await screen.findByRole('button', { name: 'Apollo: Dev' });
    await waitFor(() => expect(chip.querySelector('[data-state-dot="idle"]')).toBeInTheDocument());
  });

  it('stops a run from its panel, closing its terminal', async () => {
    runs([DEV]);
    const { user, bridge } = setupRuns([status('dev')]);

    await user.click(await screen.findByRole('button', { name: 'Apollo: Dev' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('pnpm dev')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Stop Dev' }));

    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith('dev');
    expect(useTerminalStore.getState().sessions).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apollo: Dev' })).not.toBeInTheDocument(),
    );
  });

  it("opens the run's terminal in the drawer", async () => {
    runs([{ id: 'shell', title: 'PowerShell' }, DEV]);
    const { user } = setupRuns([status('dev')]);

    await user.click(await screen.findByRole('button', { name: 'Apollo: Dev' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Show terminal/ }),
    );

    expect(useTerminalStore.getState()).toMatchObject({ activeSessionId: 'dev', isOpen: true });
  });

  it('opens the address in the browser', async () => {
    runs([DEV], { dev: { urls: ['http://localhost:5173/'], devices: [] } });
    const { user, bridge } = setupRuns([status('dev', { ports: [5173] })]);

    await user.click(await screen.findByRole('button', { name: 'Apollo: Dev' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'http://localhost:5173/',
      }),
    );

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('lists every address a run can be reached on, not just the first', async () => {
    // A launch script that starts a web app and its API, printing both (and the API docs).
    runs([DEV], {
      dev: {
        urls: [
          'http://localhost:3002/api/v1',
          'http://localhost:3001/',
          'http://localhost:3002/api/v1/docs',
        ],
        devices: [],
      },
    });
    const { user, bridge } = setupRuns([status('dev', { ports: [3001, 3002] })]);

    const chip = await screen.findByRole('button', { name: 'Apollo: Dev' });
    await waitFor(() => expect(within(chip).getByText(/:3002/)).toBeInTheDocument());
    expect(within(chip).getByText('+1')).toBeInTheDocument();

    await user.click(chip);
    const panel = await screen.findByRole('dialog');
    const api = within(panel).getByRole('button', { name: 'http://localhost:3002/api/v1' });
    const web = within(panel).getByRole('button', { name: 'http://localhost:3001/' });
    expect(api.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(panel).getByRole('button', { name: 'Copy http://localhost:3001/' }),
    ).toBeVisible();

    await user.click(web);
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('http://localhost:3001/');
  });

  describe('pausing', () => {
    const API: TerminalSessionMeta = {
      id: 'api',
      title: 'Zeus',
      run: runInfo('API', 'dotnet run'),
    };

    it('pauses a run from its panel and offers to resume it', async () => {
      runs([DEV]);
      const { user, bridge } = setupRuns([status('dev')], {
        'terminal.pause': pauseResult(),
      });

      await user.click(await screen.findByRole('button', { name: 'Apollo: Dev' }));
      const panel = await screen.findByRole('dialog');
      await user.click(within(panel).getByRole('button', { name: 'Pause Dev' }));

      expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'user');
      expect(await within(panel).findByRole('button', { name: 'Resume Dev' })).toBeEnabled();
      expect(within(panel).getByText(/paused, using no CPU/)).toBeInTheDocument();
      expect(panel.querySelector('[data-state-dot="paused"]')).toBeInTheDocument();
    });

    it('resumes a paused run', async () => {
      runs([DEV]);
      useRunPauseStore.setState({ paused: { dev: { reason: 'user', pausedAt: 1 } }, pending: {} });
      const { user, bridge } = setupRuns(
        [status('dev', { paused: true, pauseReason: 'user', pausedAt: 1 })],
        {
          'terminal.resume': pauseResult({ paused: false, reason: null, pausedAt: null }),
        },
      );

      await user.click(await screen.findByRole('button', { name: 'Apollo: Dev, paused' }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Resume Dev' }),
      );

      expect(bridge.$fn('terminal.resume')).toHaveBeenCalledWith('dev');
      expect(await screen.findByRole('button', { name: 'Apollo: Dev' })).toBeInTheDocument();
    });

    it('shows the button busy while main is pausing', async () => {
      runs([DEV]);
      useRunPauseStore.setState({ paused: {}, pending: { dev: 'pausing' } });
      const { user } = setupRuns([status('dev')]);

      await user.click(await screen.findByRole('button', { name: 'Apollo: Dev' }));
      const button = within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Pause Dev',
      });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Pausing');
    });

    it('marks a paused run in the bar and shows it uses no CPU', async () => {
      runs([DEV]);
      useRunPauseStore.setState({ paused: { dev: { reason: 'user', pausedAt: 1 } }, pending: {} });
      setupRuns([status('dev', { cpuPercent: 0, paused: true, pauseReason: 'user', pausedAt: 1 })]);

      const chip = await screen.findByRole('button', { name: 'Apollo: Dev, paused' });
      expect(chip.querySelector('[data-state-dot="paused"]')).toBeInTheDocument();
      expect(within(chip).getByText('paused')).toBeInTheDocument();
      expect(within(chip).queryByText('0.0%')).not.toBeInTheDocument();
    });

    it('says when the agent paused it', async () => {
      runs([DEV]);
      useRunPauseStore.setState({ paused: { dev: { reason: 'agent', pausedAt: 1 } }, pending: {} });
      const { user } = setupRuns([
        status('dev', { paused: true, pauseReason: 'agent', pausedAt: 1 }),
      ]);

      await user.click(await screen.findByRole('button', { name: 'Apollo: Dev, paused' }));
      expect(
        within(await screen.findByRole('dialog')).getByText(/paused while an agent works/),
      ).toBeInTheDocument();
    });

    it('offers no pause for a run whose command has finished', async () => {
      runs([{ ...DEV, run: { ...runInfo('Dev', 'pnpm dev'), startedAt: Date.now() - 600_000 } }]);
      const { user } = setupRuns([status('dev', { processCount: 1 })]);

      const chip = await screen.findByRole('button', { name: 'Apollo: Dev' });
      await waitFor(() =>
        expect(chip.querySelector('[data-state-dot="idle"]')).toBeInTheDocument(),
      );
      await user.click(chip);
      const panel = await screen.findByRole('dialog');
      expect(within(panel).queryByRole('button', { name: 'Pause Dev' })).not.toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Stop Dev' })).toBeInTheDocument();
    });

    it('counts the paused runs in the collapsed entry', async () => {
      runs([DEV, API]);
      useRunPauseStore.setState({ paused: { api: { reason: 'user', pausedAt: 1 } }, pending: {} });
      setupRuns([status('dev'), status('api', { paused: true, pauseReason: 'user', pausedAt: 1 })]);

      const chip = await screen.findByRole('button', { name: '2 project runs, 1 paused' });
      expect(within(chip).getByText('1 paused')).toBeInTheDocument();
    });

    it('pauses every run at once, then resumes them all', async () => {
      runs([DEV, API]);
      const { user, bridge } = setupRuns([status('dev'), status('api')], {
        'terminal.pause': pauseResult(),
        'terminal.resume': pauseResult({ paused: false, reason: null, pausedAt: null }),
      });

      await user.click(await screen.findByRole('button', { name: '2 project runs' }));
      const panel = await screen.findByRole('dialog');
      await user.click(within(panel).getByRole('button', { name: 'Pause all' }));

      expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'user');
      expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('api', 'user');
      await user.click(await within(panel).findByRole('button', { name: 'Resume all' }));
      await waitFor(() => expect(bridge.$fn('terminal.resume')).toHaveBeenCalledTimes(2));
    });

    it('turns the automatic pause on from the panel', async () => {
      runs([DEV]);
      const { user, bridge } = setupRuns([status('dev')], {
        'settings.get': { autoPauseRunsWhileAgentWorks: false },
      });

      await user.click(await screen.findByRole('button', { name: 'Apollo: Dev' }));
      const panel = await screen.findByRole('dialog');
      const toggle = await within(panel).findByRole('switch', {
        name: 'Pause runs while an agent works',
      });
      expect(toggle).not.toBeChecked();
      await user.click(toggle);

      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        autoPauseRunsWhileAgentWorks: true,
      });
    });
  });

  it('stays out of the bar, and measures nothing, with no runs', async () => {
    runs([{ id: 'shell', title: 'PowerShell' }]);
    const { bridge } = setupRuns([]);

    await screen.findByRole('contentinfo', { name: 'Status bar' });
    expect(screen.queryByRole('button', { name: /project runs|: Dev/ })).not.toBeInTheDocument();
    // Reading usage scans every process, so it never happens without a run to show.
    expect(() => bridge.$fn('terminal.runStatus')).toThrow();
  });
});

/**
 * The plan limits entries. Each AI subscription gets its own item, so the order is fixed, a
 * provider the user switched off in Settings stays out, and a provider with nothing to count
 * down to (an unlimited Cursor plan) never takes room in the bar.
 */
describe('the plan limits entries', () => {
  const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

  function usage(providerId: string, windows: unknown[], plan: string | null = null) {
    return {
      providerId,
      status: 'ok',
      subscription: {
        mode: 'subscription',
        plan: plan ? { id: plan.toLowerCase(), label: plan } : null,
        windows,
        source: 'account',
      },
    };
  }

  const LIST = [
    // The usage list comes back in registry order, with Cursor first.
    // A usage-based plan: three limits sharing the cycle's end, the total first.
    usage('cursor', [
      { key: 'month', label: 'Monthly usage', percent: 41, resetAt: inHours(300) },
      { key: 'month-auto', label: 'Auto', percent: 38, resetAt: inHours(300) },
      { key: 'month-api', label: 'API', percent: 100, resetAt: inHours(300) },
    ]),
    usage(
      'claude-code',
      [
        { key: 'session', label: 'Session (5h)', percent: 64, resetAt: inHours(3) },
        { key: 'week', label: 'Weekly', percent: 71, resetAt: inHours(13) },
      ],
      'Max 5×',
    ),
    usage(
      'codex',
      [
        { key: 'session', label: 'Session (5h)', percent: 22, resetAt: inHours(2) },
        { key: 'week', label: 'Weekly', percent: 9, resetAt: inHours(90) },
      ],
      'Plus',
    ),
  ];

  function setupLimits(list: unknown[], statusBarUsage?: Record<string, boolean>) {
    return setup({
      'android.sdk': NO_SDK,
      'usage.list': list,
      'settings.get': statusBarUsage ? { statusBarUsage } : {},
    });
  }

  const limitButtons = () =>
    screen.queryAllByRole('button', { name: /^(Claude Code|Codex|Cursor): .* limit$/ });

  it('gives each provider its own item, in a fixed order', async () => {
    setupLimits(LIST);

    await waitFor(() => expect(limitButtons()).toHaveLength(3));
    expect(limitButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Claude Code: Session (5h) limit',
      'Codex: Session (5h) limit',
      'Cursor: Monthly usage limit',
    ]);
    expect(within(limitButtons()[1]).getByText('22%')).toBeInTheDocument();
    expect(within(limitButtons()[2]).getByText('41%')).toBeInTheDocument();
  });

  it('leaves out a provider switched off in Settings', async () => {
    setupLimits(LIST, { 'claude-code': true, codex: false, cursor: true });

    await waitFor(() => expect(limitButtons()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /^Codex:/ })).not.toBeInTheDocument();
  });

  it('leaves out a provider that reports no limit', async () => {
    setupLimits([usage('cursor', []), LIST[1]]);

    await waitFor(() => expect(limitButtons()).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /^Cursor:/ })).not.toBeInTheDocument();
  });

  it("lists the provider's limits and opens its Token Usage card", async () => {
    const { user } = setupLimits(LIST);

    await user.click(await screen.findByRole('button', { name: 'Codex: Session (5h) limit' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Plus')).toBeInTheDocument();
    expect(within(panel).getByText('Weekly')).toBeInTheDocument();
    expect(within(panel).getByText('9%')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Open Token Usage' }));
    expect(navigate).toHaveBeenCalledWith('/usage?provider=codex');
  });
});

/**
 * A read that fails must not take a provider off the bar. Its item keeps the last limits it had,
 * dimmed and marked, or shows a warning when it never had any. Its panel has a refresh button that
 * re-reads only that provider.
 */
describe('the plan limits entries when a read fails', () => {
  const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
  const PRO_PLUS = { id: 'pro-plus', label: 'Pro+' };
  const CHIP = 'Cursor: Monthly usage limit';
  const STALE = 'Cursor: Monthly usage limit, may be out of date';

  function cursorLimit(percent: number) {
    return {
      mode: 'subscription',
      plan: PRO_PLUS,
      windows: [{ key: 'month', label: 'Monthly usage', percent, resetAt: inHours(300) }],
      source: 'account',
    };
  }

  /** A Cursor snapshot, as the usage list hands it out. */
  function cursor(over: Record<string, unknown> = {}) {
    return {
      providerId: 'cursor',
      status: 'ok',
      updatedAt: new Date().toISOString(),
      subscription: cursorLimit(41),
      ...over,
    };
  }

  /** The limits a failed read keeps from its last good read. */
  const LAST_KNOWN = {
    plan: PRO_PLUS,
    windows: [{ key: 'month', label: 'Monthly usage', percent: 41, resetAt: inHours(300) }],
    readAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  };

  function limitsOf(providerId: string, plan: string, windows: unknown[]) {
    return {
      providerId,
      status: 'ok',
      updatedAt: new Date().toISOString(),
      subscription: {
        mode: 'subscription',
        plan: { id: plan.toLowerCase(), label: plan },
        windows,
        source: 'account',
      },
    };
  }

  function usageBar(list: unknown[], extra: Record<string, unknown> = {}) {
    return setup({ 'android.sdk': NO_SDK, 'usage.list': list, 'settings.get': {}, ...extra });
  }

  it('keeps the chip, dimmed and marked, with its last numbers when a read fails', async () => {
    const { bridge, queryClient } = usageBar([cursor()]);
    await screen.findByRole('button', { name: CHIP });

    bridge.$set('usage.list', [
      cursor({
        status: 'error',
        error: 'Cursor did not answer in time.',
        subscription: undefined,
        lastLimits: LAST_KNOWN,
      }),
    ]);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.usageList });
    });

    const chip = await screen.findByRole('button', { name: STALE });
    expect(within(chip).getByText('41%')).toBeInTheDocument();
  });

  it('marks the chip the same way when only its limits failed to load', async () => {
    const { bridge, queryClient } = usageBar([cursor()]);
    await screen.findByRole('button', { name: CHIP });

    bridge.$set('usage.list', [
      cursor({
        subscription: undefined,
        limitsError: 'Cursor returned HTTP 500',
        lastLimits: LAST_KNOWN,
      }),
    ]);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.usageList });
    });

    expect(await screen.findByRole('button', { name: STALE })).toBeInTheDocument();
  });

  it('shows only a warning for a provider that has never been read', async () => {
    usageBar([
      cursor({ status: 'error', error: 'Could not reach Cursor.', subscription: undefined }),
    ]);

    const chip = await screen.findByRole('button', { name: 'Cursor: usage unavailable' });
    expect(within(chip).queryByText(/%/)).not.toBeInTheDocument();
  });

  it('takes the item out of the bar once the account is signed out', async () => {
    const { bridge, queryClient } = usageBar([cursor()]);
    await screen.findByRole('button', { name: CHIP });

    bridge.$set('usage.list', [
      { providerId: 'cursor', status: 'connect', updatedAt: new Date().toISOString() },
    ]);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.usageList });
    });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Cursor:/ })).not.toBeInTheDocument(),
    );
  });

  it('opens the panel without moving focus onto its refresh button', async () => {
    const { user } = usageBar([cursor()]);

    await user.click(await screen.findByRole('button', { name: CHIP }));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByRole('button', { name: 'Refresh Cursor usage' })).not.toHaveFocus();
  });

  it('re-reads one provider from its panel and leaves the other providers as they were', async () => {
    const { user, bridge, queryClient } = usageBar(
      [
        cursor(),
        limitsOf('claude-code', 'Max 5×', [
          { key: 'session', label: 'Session (5h)', percent: 64, resetAt: inHours(3) },
        ]),
        limitsOf('codex', 'Plus', [
          { key: 'session', label: 'Session (5h)', percent: 22, resetAt: inHours(2) },
        ]),
      ],
      { 'usage.refreshProvider': async () => cursor({ subscription: cursorLimit(55) }) },
    );
    await user.click(await screen.findByRole('button', { name: CHIP }));
    const listCallsBefore = bridge.$fn('usage.list').mock.calls.length;

    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Refresh Cursor usage',
      }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole('button', { name: CHIP })).getByText('55%'),
      ).toBeInTheDocument(),
    );
    expect(bridge.$fn('usage.refreshProvider')).toHaveBeenCalledWith('cursor');
    expect(bridge.$fn('usage.list')).toHaveBeenCalledTimes(listCallsBefore);
    expect(
      within(screen.getByRole('button', { name: 'Claude Code: Session (5h) limit' })).getByText(
        '64%',
      ),
    ).toBeInTheDocument();
    // The refresh draws its own spinner, so it must not raise the full-page loading overlay.
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((m) => m.options.meta?.silentLoading === true),
    ).toBe(true);
  });

  it('shows the refresh as busy while it runs, and ignores a second press', async () => {
    let finish!: (value: unknown) => void;
    const reply = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const { user, bridge } = usageBar([cursor()], { 'usage.refreshProvider': () => reply });
    await user.click(await screen.findByRole('button', { name: CHIP }));
    const refresh = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Refresh Cursor usage',
    });

    await user.click(refresh);
    await waitFor(() => expect(refresh).toHaveAttribute('aria-busy', 'true'));
    expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await user.click(refresh);
    expect(bridge.$fn('usage.refreshProvider')).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(cursor({ subscription: cursorLimit(55) }));
    });
    await waitFor(() => expect(refresh).toHaveAttribute('aria-busy', 'false'));
  });

  it('keeps the chip dimmed when the refresh itself comes back with a failed read', async () => {
    const { user } = usageBar([cursor()], {
      'usage.refreshProvider': async () =>
        cursor({
          status: 'error',
          error: 'Cursor did not answer in time.',
          subscription: undefined,
          lastLimits: LAST_KNOWN,
        }),
    });
    await user.click(await screen.findByRole('button', { name: CHIP }));

    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Refresh Cursor usage',
      }),
    );

    const chip = await screen.findByRole('button', { name: STALE });
    await waitFor(() => expect(within(chip).getByText('41%')).toBeInTheDocument());
  });

  it('tells the user when a refresh cannot be made, and keeps the chip', async () => {
    const { user } = usageBar([cursor()], {
      'usage.refreshProvider': () => Promise.reject(new Error('IPC down')),
    });
    await user.click(await screen.findByRole('button', { name: CHIP }));

    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Refresh Cursor usage',
      }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not refresh Cursor usage: IPC down'),
    );
    expect(screen.getByRole('button', { name: CHIP })).toBeInTheDocument();
  });
});

/**
 * The panel says how old its numbers are. That has to be when the limits were read, not when the
 * usage list was put together: the list is rebuilt on every poll, so going by it the panel always
 * said "Updated just now", even over numbers that were minutes or hours old, or only guessed.
 */
describe('how old the plan limits entry says its numbers are', () => {
  const MINUTE = 60_000;
  const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  function claude(subscription: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return {
      providerId: 'claude-code',
      status: 'ok',
      updatedAt: new Date().toISOString(),
      subscription: {
        mode: 'subscription',
        plan: { id: 'max20x', label: 'Max 20×' },
        windows: [{ key: 'session', label: 'Session (5h)', percent: 12, resetAt: inHours(3) }],
        source: 'account',
        ...subscription,
      },
      ...over,
    };
  }

  function usageBar(list: unknown[]) {
    return setup({ 'android.sdk': NO_SDK, 'usage.list': list, 'settings.get': {} });
  }

  it('dates the numbers from when the account answered, not from the latest poll', async () => {
    const { user } = usageBar([claude({ readAt: ago(4 * MINUTE) })]);

    await user.click(
      await screen.findByRole('button', { name: 'Claude Code: Session (5h) limit' }),
    );

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Updated 4m ago')).toBeInTheDocument();
    expect(within(panel).queryByText('Updated just now')).not.toBeInTheDocument();
  });

  it('dates Codex limits from the Codex turn that reported them', async () => {
    const { user } = usageBar([
      {
        providerId: 'codex',
        status: 'ok',
        updatedAt: new Date().toISOString(),
        subscription: {
          mode: 'subscription',
          plan: { id: 'plus', label: 'Plus' },
          windows: [{ key: 'week', label: 'Weekly', percent: 9, resetAt: inHours(90) }],
          source: 'account',
          readAt: ago(3 * 60 * MINUTE),
        },
      },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Codex: Weekly limit' }));

    expect(
      within(await screen.findByRole('dialog')).getByText('Updated 3h ago'),
    ).toBeInTheDocument();
  });

  it('marks numbers estimated from local logs instead of passing them off as current', async () => {
    const { user } = usageBar([
      claude({ source: 'estimate', estimateReason: 'account unreachable' }),
    ]);

    const chip = await screen.findByRole('button', {
      name: 'Claude Code: Session (5h) limit, estimated from local logs',
    });
    expect(within(chip).getByText('~12%')).toBeInTheDocument();

    await user.click(chip);
    const panel = await screen.findByRole('dialog');
    expect(
      within(panel).getByText('Estimated from local logs: account unreachable.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Estimated just now')).toBeInTheDocument();
    expect(within(panel).queryByText(/^Updated/)).not.toBeInTheDocument();
  });

  it("prefers the account's last reading over an estimate, marked as out of date", async () => {
    const { user } = usageBar([
      claude(
        { source: 'estimate', estimateReason: 'account unreachable' },
        {
          lastLimits: {
            plan: { id: 'max20x', label: 'Max 20×' },
            windows: [{ key: 'session', label: 'Session (5h)', percent: 30, resetAt: inHours(3) }],
            readAt: ago(12 * MINUTE),
          },
        },
      ),
    ]);

    const chip = await screen.findByRole('button', {
      name: 'Claude Code: Session (5h) limit, may be out of date',
    });
    expect(within(chip).getByText('30%')).toBeInTheDocument();

    await user.click(chip);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText("Couldn't refresh: account unreachable")).toBeInTheDocument();
    expect(within(panel).getByText('Last read 12m ago')).toBeInTheDocument();
  });

  it('keeps the age moving while no new numbers arrive', async () => {
    // Only the clock the panel redraws on is faked, so the queries and the waits run as usual.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const { user } = usageBar([claude({ readAt: new Date().toISOString() })]);
      await user.click(
        await screen.findByRole('button', { name: 'Claude Code: Session (5h) limit' }),
      );
      const panel = await screen.findByRole('dialog');
      expect(within(panel).getByText('Updated just now')).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3 * MINUTE);
      });

      expect(within(panel).getByText('Updated 3m ago')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
