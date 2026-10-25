import type {
  GithubActionsHistoryItem,
  GithubRunner,
  RunnerMachineLink,
  RunnerMachineSample,
  RunnerMachineStatsResult,
  SshSavedServer,
} from '@shared/apiTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * A runner tile can be linked to the machine the runner runs on (a saved SSH server or this
 * computer) and then shows that machine's CPU, memory and disk. These cases drive it through the
 * panel, the way it is used.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { RunnersPanel } = await import('./RunnersPanel');

const GB = 1024 ** 3;

const RUNS: GithubActionsHistoryItem[] = [
  {
    id: 1,
    projectId: 'p1',
    projectName: 'Aurora',
    repo: 'acme/aurora',
    workflowName: 'CI',
    displayTitle: 'Tighten the retry loop',
    runNumber: 41,
    headBranch: 'main',
    status: 'completed',
    conclusion: 'success',
    htmlUrl: 'https://github.com/acme/aurora/actions/runs/1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:04:00.000Z',
  },
];

function runner(overrides: Partial<GithubRunner> & { name: string }): GithubRunner {
  return {
    scope: { kind: 'org', name: 'acme' },
    os: 'Linux',
    arch: 'X64',
    state: 'idle',
    labels: ['self-hosted', 'Linux', 'X64'],
    customLabels: [],
    ...overrides,
  };
}

const smart = runner({ name: 'SmartAgent' });
const mac = runner({ name: 'macmini', os: 'macOS', arch: 'ARM64', onThisComputer: true });
const dead = runner({ name: 'old-box', state: 'offline' });

const SERVERS: SshSavedServer[] = [
  {
    id: 'srv-vpn',
    nickname: 'smartvpn',
    host: 'smartagent.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'privateKey',
    hasSecret: false,
    createdAt: 1,
    lastConnectedAt: null,
  },
  {
    id: 'srv-web',
    nickname: 'web-1',
    host: '10.0.0.7',
    port: 22,
    username: 'root',
    authMethod: 'password',
    hasSecret: true,
    createdAt: 2,
    lastConnectedAt: null,
  },
];

function sample(overrides: Partial<RunnerMachineSample> = {}): RunnerMachineSample {
  return {
    at: 1,
    cpuPercent: 42.4,
    cpuCount: 16,
    load1: 3.5,
    memUsedBytes: 8 * GB,
    memTotalBytes: 16 * GB,
    diskUsedBytes: 480 * GB,
    diskTotalBytes: 500 * GB,
    diskMount: '/',
    ...overrides,
  };
}

interface Options {
  links?: Record<string, RunnerMachineLink>;
  stats?: (link: RunnerMachineLink) => Promise<RunnerMachineStatsResult>;
  update?: (patch: { runnerMachineLinks?: Record<string, RunnerMachineLink> }) => Promise<unknown>;
  runners?: GithubRunner[];
}

function renderPanel(options: Options = {}) {
  let links = options.links ?? {};
  const stats = vi.fn(
    options.stats ??
      (async (): Promise<RunnerMachineStatsResult> => ({ ok: true, sample: sample() })),
  );
  const view = renderWithProviders(
    <RunnersPanel runs={RUNS} onFocusRun={vi.fn()} onGrantAccess={vi.fn()} />,
    {
      bridge: {
        'pipelines.runners': async () => ({
          ok: true,
          runners: options.runners ?? [smart, mac, dead],
          waiting: [],
          hiddenOrgs: [],
        }),
        'pipelines.runnerMachineStats': stats,
        'ssh.listServers': async () => SERVERS,
        'settings.get': async () => ({ runnerMachineLinks: links }),
        'settings.update':
          options.update ??
          (async (patch: { runnerMachineLinks?: Record<string, RunnerMachineLink> }) => {
            links = patch.runnerMachineLinks ?? links;
            return { runnerMachineLinks: links };
          }),
      },
    },
  );
  return { ...view, stats };
}

async function tile(name: string): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Self-hosted runners' });
  return waitFor(() => {
    const item = within(region)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes(name));
    if (!item) throw new Error(`No tile for "${name}"`);
    return item;
  });
}

async function openMenu(user: ReturnType<typeof renderPanel>['user'], name: string) {
  const item = await tile(name);
  await user.click(within(item).getByRole('button', { name: new RegExp(`of ${name}$`) }));
  return screen.findByRole('menu');
}

describe('runner machine stats', () => {
  it('reads nothing for a runner nobody linked', async () => {
    const { stats } = renderPanel();

    const item = await tile('SmartAgent');
    expect(
      within(item).getByRole('button', { name: 'Show CPU, memory and disk of SmartAgent' }),
    ).toBeTruthy();
    expect(within(item).queryByRole('group', { name: /^CPU/ })).toBeNull();
    expect(stats).not.toHaveBeenCalled();
  });

  it('offers this computer and every saved server, with name matches first', async () => {
    const { user } = renderPanel();

    const menu = await openMenu(user, 'SmartAgent');
    const items = within(menu).getAllByRole('menuitemradio');

    expect(items.map((item) => item.textContent)).toEqual([
      'This computer',
      'smartvpndeploy@smartagent.example.comSuggested',
      'web-1root@10.0.0.7',
    ]);
  });

  it('suggests this computer for a runner named after it', async () => {
    const { user } = renderPanel();

    const menu = await openMenu(user, 'macmini');

    expect(within(menu).getByRole('menuitemradio', { name: /This computer/ }).textContent).toBe(
      'This computer' + 'Suggested',
    );
  });

  it('saves the link and starts showing the machine', async () => {
    const { user, bridge, stats } = renderPanel();

    const menu = await openMenu(user, 'SmartAgent');
    await user.click(within(menu).getByRole('menuitemradio', { name: /smartvpn/ }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        runnerMachineLinks: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' } },
      }),
    );
    const item = await tile('SmartAgent');
    expect(await within(item).findByRole('group', { name: 'CPU 42%' })).toBeTruthy();
    expect(stats).toHaveBeenCalledWith({ kind: 'ssh', serverId: 'srv-vpn' });
  });

  it('shows CPU, memory and disk with the details in a tooltip', async () => {
    const { user } = renderPanel({
      links: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' } },
    });

    const item = await tile('SmartAgent');
    const cpu = await within(item).findByRole('group', { name: 'CPU 42%' });
    const ram = within(item).getByRole('group', { name: 'RAM 50%' });
    const disk = within(item).getByRole('group', { name: 'Disk 96%' });

    // Nearly full is called out in the alert colour.
    expect(within(disk).getByText('96%').className).toContain('text-destructive');
    expect(within(ram).getByText('50%').className).toContain('text-foreground');

    await user.hover(cpu);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Load 3.50 on 16 cores');
  });

  it('opens the disk details from the keyboard too', async () => {
    const { user } = renderPanel({
      links: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' } },
    });

    const item = await tile('SmartAgent');
    const disk = await within(item).findByRole('group', { name: 'Disk 96%' });
    for (let step = 0; step < 15 && document.activeElement !== disk; step += 1) {
      await user.tab();
    }

    expect(disk).toHaveFocus();
    expect((await screen.findAllByText('480 GB of 500 GB used on /')).length).toBeGreaterThan(0);
  });

  it('says n/a when the machine gave no CPU figure', async () => {
    renderPanel({
      links: { 'acme/SmartAgent': { kind: 'local' } },
      stats: async () => ({ ok: true, sample: sample({ cpuPercent: null }) }),
    });

    const item = await tile('SmartAgent');
    expect(await within(item).findByRole('group', { name: 'CPU n/a' })).toBeTruthy();
  });

  it('does not try to read an offline runner', async () => {
    const { stats } = renderPanel({
      links: { 'acme/old-box': { kind: 'ssh', serverId: 'srv-web' } },
    });

    const item = await tile('old-box');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(within(item).queryByRole('group', { name: /^CPU/ })).toBeNull();
    expect(stats).not.toHaveBeenCalled();
  });

  it('offers to unlock the Servers vault when the login is sealed in it', async () => {
    const { user } = renderPanel({
      links: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' } },
      stats: async () => ({ ok: false, reason: 'locked', error: 'The vault is locked.' }),
    });

    const item = await tile('SmartAgent');
    expect(await within(item).findByText('The Servers vault is locked')).toBeTruthy();
    await user.click(within(item).getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('names the server it could not reach and keeps the error in a tooltip', async () => {
    const { user } = renderPanel({
      links: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' } },
      stats: async () => ({
        ok: false,
        reason: 'unreachable',
        error: 'Could not connect to smartagent.example.com:22 (timed out).',
      }),
    });

    const item = await tile('SmartAgent');
    const line = await within(item).findByText('Could not reach smartvpn');
    await user.hover(line);

    expect((await screen.findByRole('tooltip')).textContent).toContain('(timed out)');
  });

  it('lets a link to a removed server be dropped', async () => {
    const { user, bridge } = renderPanel({
      links: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'gone' } },
      stats: async () => ({
        ok: false,
        reason: 'missing',
        error: 'This saved server no longer exists.',
      }),
    });

    const item = await tile('SmartAgent');
    await within(item).findByText('The linked server was removed');
    await user.click(within(item).getByRole('button', { name: 'Unlink' }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ runnerMachineLinks: {} }),
    );
    await waitFor(() =>
      expect(within(item).queryByText('The linked server was removed')).toBeNull(),
    );
  });

  it('stops showing stats from the menu', async () => {
    const { user, bridge } = renderPanel({
      links: {
        'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' },
        'acme/macmini': { kind: 'local' },
      },
    });

    const menu = await openMenu(user, 'SmartAgent');
    await user.click(within(menu).getByRole('menuitem', { name: 'Stop showing stats' }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        runnerMachineLinks: { 'acme/macmini': { kind: 'local' } },
      }),
    );
  });

  it('says so when the link could not be saved', async () => {
    const { user } = renderPanel({
      update: async () => {
        throw new Error('disk full');
      },
    });

    const menu = await openMenu(user, 'SmartAgent');
    await user.click(within(menu).getByRole('menuitemradio', { name: /This computer/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls.at(-1)?.[0])).toContain('disk full');
  });

  it('never uses the native title attribute', async () => {
    renderPanel({ links: { 'acme/SmartAgent': { kind: 'ssh', serverId: 'srv-vpn' } } });

    const item = await tile('SmartAgent');
    await within(item).findByRole('group', { name: 'CPU 42%' });

    expect(item.querySelector('[title]')).toBeNull();
  });
});
