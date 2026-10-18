import {
  CLI_REGISTRY,
  DASHBOARD_CHART_IDS,
  type InstalledCli,
  type ProviderUsage,
  type UsagePeriod,
} from '@agentmat/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import {
  type DashboardItemId,
  statItemId,
  summaryItemId,
  usageItemId,
  useDashboardLayoutStore,
} from '@/stores/dashboardLayoutStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { SystemStatsSample } from '../../../shared/apiTypes';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The dashboard is a user-arranged grid: which cards exist comes from the layout store, what they
 * say comes from the bridge. The tests keep those two apart, seeding a layout and then checking
 * that each card reads its own data, that the empty and unreachable cases say so rather than
 * showing a blank chart, and that edit mode writes the rearrangement back.
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

/**
 * The renderer suite already swaps Framer Motion for a stub, but that stub has no
 * `useMotionValueEvent`, which the count-up figures on the usage cards subscribe with, and its
 * motion values have no `jump`. Reduced motion is on in the stub, so nothing animates either way.
 */
vi.mock('framer-motion', async (importOriginal) => {
  const stub = (await importOriginal()) as Record<string, unknown>;
  const motionValue = (initial: number) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: number) => {
        current = next;
      },
      jump: (next: number) => {
        current = next;
      },
      on: () => () => undefined,
    };
  };
  return {
    ...stub,
    useMotionValue: motionValue,
    useSpring: motionValue,
    useTransform: () => motionValue(0),
    useMotionValueEvent: () => undefined,
  };
});

/**
 * The history hook keeps its samples in a module level cache that outlives each test, so what a
 * chart draws depends on every test before it. The temperature tests need to know exactly which
 * samples are in the window (a lone hot one, a missing one), so they can pin it here. The real
 * hook still runs underneath, which leaves every other test on the bridge poll as before.
 */
const pinnedHistory = vi.hoisted(() => ({ current: null as SystemStatsSample[] | null }));
vi.mock('@/hooks/useSystemStatsHistory', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/hooks/useSystemStatsHistory');
  return {
    ...actual,
    useSystemStatsHistory: (...args: Parameters<typeof actual.useSystemStatsHistory>) => {
      const polled = actual.useSystemStatsHistory(...args);
      return pinnedHistory.current ?? polled;
    },
  };
});
afterEach(() => {
  pinnedHistory.current = null;
});

const { default: DashboardPage } = await import('./DashboardPage');

function sample(overrides: Partial<SystemStatsSample> = {}): SystemStatsSample {
  return {
    timestamp: 1_760_000_000_000,
    cpuModel: 'Test CPU 9000',
    cpuCoreCount: 4,
    cpuArch: 'x64',
    cpuTempC: null,
    cpuThermalState: null,
    cpuPercent: 42,
    cpuCorePercents: [11, 22, 33, 44],
    memPercent: 61,
    memUsedBytes: 8 * 1024 ** 3,
    memTotalBytes: 16 * 1024 ** 3,
    disks: [{ id: 'C:', label: 'C:', readBytesPerSec: 1024 * 1024, writeBytesPerSec: 1024 * 1024 }],
    gpus: [
      {
        id: '0',
        label: 'Test GPU',
        percent: 77,
        memUsedBytes: 2 * 1024 ** 3,
        memTotalBytes: 8 * 1024 ** 3,
        tempC: null,
      },
    ],
    netRxBytesPerSec: 3 * 1024 * 1024,
    netTxBytesPerSec: 512 * 1024,
    pings: [
      { host: '1.1.1.1', alive: true, latencyMs: 12 },
      { host: '8.8.8.8', alive: false, latencyMs: null },
    ],
    ...overrides,
  };
}

function period(total: number, costUsd: number | null = null): UsagePeriod {
  return { tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total }, costUsd };
}

const claudeUsage: ProviderUsage = {
  providerId: 'claude-code',
  status: 'ok',
  today: period(1_000, 0.5),
  last7d: period(7_000, 3),
  last30d: period(30_000, 12),
  currency: 'USD',
  updatedAt: '2026-04-01T12:00:00.000Z',
};

const installedCli: InstalledCli = {
  id: 'claude-code',
  installed: true,
  version: '1.2.3',
  executablePath: '/usr/local/bin/claude',
  lastCheckedAt: '2026-04-01T10:00:00.000Z',
};

/**
 * Seeds the layout the page draws. Nothing populates it on mount (the app does that at startup),
 * so a test that wants cards has to say which ones.
 */
function seedLayout(
  items: DashboardItemId[],
  extra: Partial<ReturnType<typeof useDashboardLayoutStore.getState>> = {},
): void {
  useDashboardLayoutStore.setState({
    rows: [{ id: 'row-1', columns: 2, items }],
    chartCards: [...DASHBOARD_CHART_IDS],
    ...extra,
  });
}

/** A bridge that always answers the system poll, so the charts have something to draw. */
function withStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { 'system.sample': async () => sample(), ...overrides };
}

function renderPage(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<DashboardPage />, { route: '/', bridge });
}

/** The glass card a title heads, so one card's controls can be told from another's. */
function cardFor(title: string): HTMLElement {
  const card = screen.getByText(title).closest('div.glass');
  if (!card) throw new Error(`No card found around "${title}"`);
  return card as HTMLElement;
}

/** The value a stat tile currently shows, read next to its label. */
function tileValue(label: string): string {
  const tile = screen.getByText(label).parentElement?.parentElement;
  if (!tile) throw new Error(`No tile around "${label}"`);
  return tile.lastElementChild?.textContent ?? '';
}

describe('DashboardPage with an empty layout', () => {
  it('renders its shortcuts and the updates card with nothing else configured', async () => {
    renderPage(withStats());

    expect(screen.getByRole('button', { name: /New Project/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open Prompt Builder/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open Workspace/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit layout' })).toBeTruthy();
    // No rows were seeded, so the grid is empty and only the updates card is left.
    expect(screen.queryByText('CPU Usage')).toBeNull();
    expect(
      await screen.findByText(/No AI CLIs or agent tools detected yet/, {}, { timeout: 5_000 }),
    ).toBeTruthy();
  });

  it('keeps going when the CLI scan itself fails', async () => {
    renderPage(withStats({ 'cli.detectAll': () => Promise.reject(new Error('spawn ENOENT')) }));

    expect(
      await screen.findByText(/No AI CLIs or agent tools detected yet/, {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit layout' })).toBeTruthy();
  });
});

describe('DashboardPage system charts', () => {
  it('draws each chart card from the latest sample', async () => {
    seedLayout(['cpu', 'memory', 'disk', 'gpu', 'network', 'pings']);
    renderPage(withStats());

    const cpu = await waitFor(() => cardFor('CPU Usage'));
    await waitFor(() => expect(within(cpu).getByText('42%')).toBeTruthy());
    expect(within(cpu).getByText('Test CPU 9000 · 4 cores · x64')).toBeTruthy();

    const memory = cardFor('Memory Usage');
    expect(within(memory).getByText('61%')).toBeTruthy();
    expect(within(memory).getByText('8.0 GB / 16.0 GB')).toBeTruthy();

    // One megabyte read plus one written is what the headline adds up. The same figure repeats
    // in the per-drive legend below it, so the assertion aims at the headline row.
    const diskHeadline = within(cardFor('Disk I/O')).getByText('combined read + write')
      .parentElement as HTMLElement;
    expect(within(diskHeadline).getByText('2.0 MB/s')).toBeTruthy();
    expect(within(cardFor('GPU Usage')).getByText('77%')).toBeTruthy();
    expect(within(cardFor('Network Throughput')).getByText('3.0 MB/s')).toBeTruthy();

    const pings = cardFor('Network Status');
    expect(within(pings).getByText('1/2')).toBeTruthy();
    expect(within(pings).getByText('Online')).toBeTruthy();
    expect(within(pings).getByText('Offline')).toBeTruthy();
    // Half the probes came back, which is not a healthy link.
    expect(within(pings).getByText('Poor')).toBeTruthy();

    expect(screen.getAllByRole('img', { name: 'Time series chart' }).length).toBe(6);
  });

  it('breaks the CPU chart out per core on request', async () => {
    seedLayout(['cpu']);
    const { user } = renderPage(withStats());
    const cpu = await waitFor(() => cardFor('CPU Usage'));
    await waitFor(() => expect(within(cpu).getByText('42%')).toBeTruthy());

    await user.click(within(cpu).getByRole('tab', { name: 'Per core' }));

    expect(within(cpu).getByText('11%')).toBeTruthy();
    expect(within(cpu).getByText('44%')).toBeTruthy();
    expect(within(cpu).getByText(/^C0/)).toBeTruthy();

    await user.click(within(cpu).getByRole('tab', { name: 'Total' }));

    expect(within(cpu).queryByText('11%')).toBeNull();
  });

  it('says what a machine does not report rather than drawing an empty chart', async () => {
    seedLayout(['disk', 'gpu', 'pings']);
    renderPage(
      withStats({ 'system.sample': async () => sample({ disks: [], gpus: [], pings: [] }) }),
    );

    expect(await screen.findByText('No disk activity detected.')).toBeTruthy();
    expect(screen.getByText('No supported GPU detected.')).toBeTruthy();
    expect(screen.getByText(/No ping targets configured/)).toBeTruthy();
    // The GPU headline has no number to show either, instead of reading 0%.
    expect(within(cardFor('GPU Usage')).getByText('N/A')).toBeTruthy();
  });

  it('offers a terminal to investigate a ping target', async () => {
    seedLayout(['pings']);
    const { user } = renderPage(withStats());
    await waitFor(() => expect(screen.getByRole('button', { name: '1.1.1.1' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '1.1.1.1' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Traceroute/ }));

    const session = useTerminalStore
      .getState()
      .sessions.find((one) => one.title === 'Traceroute 1.1.1.1');
    expect(session?.initialInput).toBe('tracert -d 1.1.1.1');
    expect(toast.info).toHaveBeenCalledWith(
      'Press Enter in the terminal to trace the route to 1.1.1.1.',
    );
  });

  it('names an HTTP probe target by its site, without ping or traceroute', async () => {
    seedLayout(['pings']);
    const url = 'https://www.gstatic.com/generate_204';
    const { user } = renderPage(
      withStats({
        'system.sample': async () => sample({ pings: [{ host: url, alive: true, latencyMs: 30 }] }),
      }),
    );

    const name = await waitFor(() => within(cardFor('Network Status')).getByText('gstatic'));
    expect(screen.queryByRole('button', { name: 'gstatic' })).toBeNull();
    expect(screen.queryByText(url)).toBeNull();

    // The full URL is still there on hover.
    await user.hover(name);
    expect((await screen.findAllByText(url)).length).toBeGreaterThan(0);
  });
});

/** Pins the chart window to these samples and serves the last one from the bridge too. */
function renderHistory(history: SystemStatsSample[]) {
  pinnedHistory.current = history;
  return renderPage(withStats({ 'system.sample': async () => history.at(-1) }));
}

function chartIn(card: HTMLElement): SVGSVGElement {
  return within(card).getByRole('img', { name: 'Time series chart' }) as unknown as SVGSVGElement;
}

function pathsIn(card: HTMLElement): SVGPathElement[] {
  return Array.from(chartIn(card).querySelectorAll('path'));
}

function dashedPathsIn(card: HTMLElement): SVGPathElement[] {
  return pathsIn(card).filter((p) => p.getAttribute('stroke-dasharray'));
}

/** Points at the last sample of a card's chart, which opens its tooltip. */
function hoverLastSample(card: HTMLElement): void {
  const svg = chartIn(card);
  svg.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 88 }) as DOMRect;
  fireEvent.pointerMove(svg, { clientX: 300 });
}

/** The chart tooltip is portaled to the body, apart from the card it describes. */
function tooltipValue(label: string): string {
  const tooltip = document.querySelector<HTMLElement>('body > div.fixed.z-50');
  if (!tooltip) throw new Error('No chart tooltip is showing');
  return within(tooltip).getByText(label).parentElement?.lastElementChild?.textContent ?? '';
}

function gpu(overrides: Partial<SystemStatsSample['gpus'][number]> = {}) {
  return {
    id: '0',
    label: 'Test GPU',
    percent: 77,
    memUsedBytes: 2 * 1024 ** 3,
    memTotalBytes: 8 * 1024 ** 3,
    tempC: null,
    ...overrides,
  };
}

describe('DashboardPage temperatures', () => {
  it('shows the CPU temperature beside the usage and draws it dashed on the chart', async () => {
    seedLayout(['cpu']);
    const { user } = renderHistory([sample({ cpuTempC: 50 }), sample({ cpuTempC: 52 })]);
    const cpu = await waitFor(() => cardFor('CPU Usage'));

    expect(within(cpu).getByText('52 °C')).toBeTruthy();
    // CPU keeps its area and line, the temperature adds one dashed line and no area.
    expect(pathsIn(cpu)).toHaveLength(3);
    expect(dashedPathsIn(cpu)).toHaveLength(1);

    hoverLastSample(cpu);
    expect(tooltipValue('Temperature')).toBe('52 °C');
    expect(tooltipValue('CPU')).toBe('42%');

    await user.click(within(cpu).getByRole('tab', { name: 'Per core' }));
    // Four cores with an area and a line each, plus the same temperature line.
    expect(pathsIn(cpu)).toHaveLength(9);
    expect(dashedPathsIn(cpu)).toHaveLength(1);
  });

  it('lifts the CPU chart ceiling for a spike past 100 °C and skips a missing sample', async () => {
    seedLayout(['cpu']);
    renderHistory([sample({ cpuTempC: null }), sample({ cpuTempC: 105 })]);
    const cpu = await waitFor(() => cardFor('CPU Usage'));

    expect(pathsIn(cpu).some((p) => p.getAttribute('d')?.includes('NaN'))).toBe(false);
    // 105 is the top of the scale now, so it sits on the top padding line rather than past it.
    expect(dashedPathsIn(cpu)[0].getAttribute('d')).toBe('M 300.00 6.00');
    // And 42% is drawn against that same 105 ceiling.
    const usageLine = pathsIn(cpu).find(
      (p) => p.getAttribute('fill') === 'none' && !p.getAttribute('stroke-dasharray'),
    );
    expect(usageLine?.getAttribute('d')).toBe('M 0.00 51.60 L 300.00 51.60');
  });

  it('keeps the CPU chart at 0-100 while the temperature stays under it', async () => {
    seedLayout(['cpu']);
    renderHistory([sample({ cpuTempC: null }), sample({ cpuTempC: 50 })]);
    const cpu = await waitFor(() => cardFor('CPU Usage'));

    expect(pathsIn(cpu).some((p) => p.getAttribute('d')?.includes('NaN'))).toBe(false);
    const usageLine = pathsIn(cpu).find(
      (p) => p.getAttribute('fill') === 'none' && !p.getAttribute('stroke-dasharray'),
    );
    expect(usageLine?.getAttribute('d')).toBe('M 0.00 50.08 L 300.00 50.08');
  });

  it('adds nothing to the CPU and GPU cards when no temperature is reported', async () => {
    seedLayout(['cpu', 'gpu']);
    const { container, user } = renderHistory([sample(), sample()]);
    const cpu = await waitFor(() => cardFor('CPU Usage'));
    const gpuCard = cardFor('GPU Usage');

    expect(pathsIn(cpu)).toHaveLength(2);
    expect(pathsIn(gpuCard)).toHaveLength(2);
    expect(dashedPathsIn(cpu)).toHaveLength(0);
    expect(dashedPathsIn(gpuCard)).toHaveLength(0);
    expect(within(gpuCard).getByText('77% · 2.0 GB/8.0 GB')).toBeTruthy();
    expect(container.textContent).not.toMatch(/°C/);
    for (const state of ['Nominal', 'Fair', 'Serious', 'Critical']) {
      expect(within(cpu).queryByText(state)).toBeNull();
    }

    await user.click(within(cpu).getByRole('tab', { name: 'Per core' }));
    expect(pathsIn(cpu)).toHaveLength(8);
  });

  it('shows the macOS thermal state as a badge, toned by how serious it is', async () => {
    seedLayout(['cpu']);
    const first = renderHistory([sample({ cpuThermalState: 'nominal' })]);
    const nominal = await waitFor(() => within(cardFor('CPU Usage')).getByText('Nominal'));
    expect(nominal.className).not.toMatch(/text-(warning|destructive)/);
    first.unmount();

    const second = renderHistory([sample({ cpuThermalState: 'serious' })]);
    const serious = await waitFor(() => within(cardFor('CPU Usage')).getByText('Serious'));
    expect(serious.className).toContain('text-warning');
    second.unmount();

    renderHistory([sample({ cpuThermalState: 'critical' })]);
    const critical = await waitFor(() => within(cardFor('CPU Usage')).getByText('Critical'));
    expect(critical.className).toContain('text-destructive');
    // macOS gives no reading in degrees, so there is no °C next to the badge.
    expect(within(cardFor('CPU Usage')).queryByText(/°C/)).toBeNull();
  });

  it('names the architecture after the core count', async () => {
    seedLayout(['cpu']);
    renderHistory([sample({ cpuModel: 'Apple M4', cpuCoreCount: 10, cpuArch: 'arm64' })]);

    expect(
      await waitFor(() => within(cardFor('CPU Usage')).getByText('Apple M4 · 10 cores · ARM64')),
    ).toBeTruthy();
  });

  it('falls back to the architecture when the OS has no CPU model name', async () => {
    seedLayout(['cpu']);
    const first = renderHistory([sample({ cpuModel: 'unknown', cpuArch: 'arm' })]);
    expect(
      await waitFor(() => within(cardFor('CPU Usage')).getByText('ARM CPU · 4 cores')),
    ).toBeTruthy();
    first.unmount();

    renderHistory([sample({ cpuModel: '', cpuArch: 'riscv64' })]);
    expect(
      await waitFor(() => within(cardFor('CPU Usage')).getByText('riscv64 CPU · 4 cores')),
    ).toBeTruthy();
  });

  it('adds each GPU temperature to its legend and as a dashed line in its colour', async () => {
    seedLayout(['gpu']);
    const twoGpus = (hotTemp: number | null) =>
      sample({
        gpus: [
          gpu({ tempC: hotTemp }),
          gpu({ id: '1', label: 'Other GPU', percent: 10, tempC: null }),
        ],
      });
    renderHistory([twoGpus(null), twoGpus(105)]);
    const gpuCard = await waitFor(() => cardFor('GPU Usage'));

    expect(within(gpuCard).getByText('77% · 2.0 GB/8.0 GB · 105 °C')).toBeTruthy();
    expect(within(gpuCard).getByText('10% · 2.0 GB/8.0 GB')).toBeTruthy();
    // Two GPUs with an area and a line each, and a temperature line only for the one that has it.
    expect(pathsIn(gpuCard)).toHaveLength(5);
    const [tempLine] = dashedPathsIn(gpuCard);
    expect(dashedPathsIn(gpuCard)).toHaveLength(1);
    const firstGpuLine = pathsIn(gpuCard).filter((p) => p.getAttribute('fill') === 'none')[0];
    expect(tempLine.getAttribute('stroke')).toBe(firstGpuLine.getAttribute('stroke'));
    // The spike sets the ceiling, and the missing first sample leaves a gap rather than a NaN.
    expect(tempLine.getAttribute('d')).toBe('M 300.00 6.00');

    hoverLastSample(gpuCard);
    expect(tooltipValue('Test GPU temp')).toBe('105 °C');
    expect(tooltipValue('Test GPU')).toBe('77%');
  });
});

describe('DashboardPage stat tiles', () => {
  it('counts what the bridge reports for each tile', async () => {
    seedLayout(
      [statItemId('installed-clis'), statItemId('active-projects'), statItemId('skill-repos')],
      { statCards: ['installed-clis', 'active-projects', 'skill-repos'] },
    );
    renderPage(
      withStats({
        'cli.detectAll': [installedCli],
        'projects.list': [
          { id: 'p1', name: 'One', folderPath: '/one', archived: false },
          { id: 'p2', name: 'Two', folderPath: '/two', archived: false },
          { id: 'p3', name: 'Old', folderPath: '/old', archived: true },
        ],
        'skills.listRepositories': [{ id: 'r1', name: 'Community' }],
      }),
    );

    await waitFor(() => expect(tileValue('Installed CLIs')).toBe(`1/${CLI_REGISTRY.length}`));
    // The archived project is not an active one.
    expect(tileValue('Active Projects')).toBe('2');
    expect(tileValue('Skill Repositories')).toBe('1');
  });

  it('shows the looked-up address and copies it on click', async () => {
    seedLayout([statItemId('location')], { statCards: ['location'] });
    renderPage(
      withStats({ 'ipGeo.lookup': { ip: '203.0.113.9', country: 'Germany', countryCode: 'DE' } }),
    );

    const ip = await screen.findByRole('button', { name: '203.0.113.9' }, { timeout: 5_000 });
    fireEvent.click(ip);

    // Read back rather than asserting on the spy: setting userEvent up swaps navigator.clipboard
    // for its own stub, so what matters is that the address really landed on the clipboard.
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('203.0.113.9'));
    expect(toast.success).toHaveBeenCalledWith('IP address copied.');
  });

  it('asks for a fresh lookup, skipping the cache, when the tile is refreshed', async () => {
    seedLayout([statItemId('location')], { statCards: ['location'] });
    const { user, bridge } = renderPage(
      withStats({ 'ipGeo.lookup': { ip: '203.0.113.9', country: 'Germany', countryCode: 'DE' } }),
    );
    await screen.findByRole('button', { name: '203.0.113.9' }, { timeout: 5_000 });
    expect(bridge.$fn('ipGeo.lookup')).toHaveBeenCalledWith(false);

    const tile = screen.getByText('Your Location').parentElement as HTMLElement;
    await user.click(within(tile).getByRole('button'));

    await waitFor(() => expect(bridge.$fn('ipGeo.lookup')).toHaveBeenCalledWith(true));
  });

  it('says the location is unavailable when the lookup fails', async () => {
    seedLayout([statItemId('location')], { statCards: ['location'] });
    renderPage(withStats({ 'ipGeo.lookup': () => Promise.reject(new Error('offline')) }));

    expect(await screen.findByText('Unavailable', {}, { timeout: 5_000 })).toBeTruthy();
  });
});

describe('DashboardPage token usage cards', () => {
  it('shows the pinned summary tiles from the same totals the Usage page uses', async () => {
    seedLayout([summaryItemId('tokens-today'), summaryItemId('cost-today')], {
      summaryCards: ['tokens-today', 'cost-today'],
    });
    renderPage(withStats({ 'settings.get': {}, 'usage.list': [claudeUsage] }));

    await waitFor(() => expect(tileValue('Tokens today')).toBe('1.0K'));
    expect(tileValue('Cost today')).toBe('$0.50');
  });

  it('draws a pinned provider card, and says so when it is no longer tracked', async () => {
    seedLayout([usageItemId('claude-code')], { usageCards: ['claude-code'] });
    const { unmount } = renderPage(withStats({ 'settings.get': {}, 'usage.list': [claudeUsage] }));

    expect(await screen.findByText('Claude Code')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('tokens today')).toBeTruthy());
    unmount();

    seedLayout([usageItemId('claude-code')], { usageCards: ['claude-code'] });
    renderPage(withStats({ 'settings.get': {}, 'usage.list': [] }));

    expect(await screen.findByText('No longer tracked on the Token Usage page.')).toBeTruthy();
  });
});

describe('DashboardPage editing the layout', () => {
  it('reveals the layout controls and hides them again', async () => {
    seedLayout(['cpu']);
    const { user } = renderPage(withStats());

    await user.click(screen.getByRole('button', { name: 'Edit layout' }));

    expect(screen.getByRole('button', { name: /Add card/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add row/ })).toBeTruthy();
    expect(screen.getByText('Drop a card here')).toBeTruthy();
    expect(screen.getByText('1 card')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Done editing' }));

    expect(screen.queryByRole('button', { name: /Add card/ })).toBeNull();
    expect(screen.queryByText('Drop a card here')).toBeNull();
  });

  it('saves the column count a row is set to', async () => {
    seedLayout(['cpu', 'memory']);
    const { user, bridge } = renderPage(withStats());
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));

    await user.click(screen.getByRole('button', { name: '3', pressed: false }));

    expect(useDashboardLayoutStore.getState().rows[0].columns).toBe(3);
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith(
        expect.objectContaining({
          dashboardLayout: [{ id: 'row-1', columns: 3, items: ['cpu', 'memory'] }],
        }),
      ),
    );
  });

  it('adds a row for cards to be dropped into', async () => {
    seedLayout(['cpu']);
    const { user } = renderPage(withStats());
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));

    await user.click(screen.getByRole('button', { name: /Add row/ }));

    expect(useDashboardLayoutStore.getState().rows).toHaveLength(2);
    expect(screen.getByText('Empty row')).toBeTruthy();
  });

  it('hides a card from the dashboard and brings it back from the Add card menu', async () => {
    seedLayout(['cpu', 'memory']);
    const { user } = renderPage(withStats());
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));
    const cpu = cardFor('CPU Usage');

    // [top apps, remove]: the drag handle is a span, not a button.
    const buttons = within(cpu).getAllByRole('button');
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(screen.queryByText('CPU Usage')).toBeNull());
    expect(useDashboardLayoutStore.getState().chartCards).not.toContain('cpu');
    expect(toast.info).toHaveBeenCalledWith('CPU Usage removed from the dashboard.');

    await user.click(screen.getByRole('button', { name: /Add card/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'CPU Usage' }));

    await waitFor(() => expect(useDashboardLayoutStore.getState().chartCards).toContain('cpu'));
    expect(screen.getByText('CPU Usage')).toBeTruthy();
  });

  it('brings back the Docker and emulator cards from the Add card menu', async () => {
    const without = DASHBOARD_CHART_IDS.filter(
      (id) => id !== 'resource-usage' && id !== 'idle-resources',
    );
    seedLayout(['cpu'], { chartCards: without });
    const { user } = renderPage(withStats());
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));
    expect(screen.queryByText('Idle Docker and Emulators')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Add card/ }));
    await user.click(
      await screen.findByRole('menuitemcheckbox', { name: 'Idle Docker and Emulators' }),
    );
    await waitFor(() =>
      expect(useDashboardLayoutStore.getState().chartCards).toContain('idle-resources'),
    );
    expect(screen.getByText('Idle Docker and Emulators')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add card/ }));
    await user.click(
      await screen.findByRole('menuitemcheckbox', { name: 'Docker and Emulator Usage' }),
    );
    await waitFor(() =>
      expect(useDashboardLayoutStore.getState().chartCards).toContain('resource-usage'),
    );
    expect(screen.getByText('Docker and Emulator Usage')).toBeTruthy();
  });

  it('pins a Token Usage summary tile from the Add card menu', async () => {
    seedLayout(['cpu']);
    const { user } = renderPage(withStats({ 'settings.get': {}, 'usage.list': [claudeUsage] }));
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));

    await user.click(screen.getByRole('button', { name: /Add card/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Tokens today' }));

    await waitFor(() =>
      expect(useDashboardLayoutStore.getState().summaryCards).toContain('tokens-today'),
    );
    await waitFor(() => expect(tileValue('Tokens today')).toBe('1.0K'));
  });

  it('resets the layout to the new-install default once confirmed', async () => {
    seedLayout(['cpu'], { statCards: [], usageCards: [], summaryCards: [] });
    const { user, bridge } = renderPage(withStats());
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));

    await user.click(screen.getByRole('button', { name: /Reset to default/ }));
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    // Nothing changes until the user says yes.
    expect(useDashboardLayoutStore.getState().rows[0].items).toEqual(['cpu']);
    resolveConfirm(true);

    await waitFor(() =>
      expect(useDashboardLayoutStore.getState().rows.map((row) => row.columns)).toEqual([
        4, 2, 3, 2, 2,
      ]),
    );
    const state = useDashboardLayoutStore.getState();
    expect(state.rows[0].items).toEqual([
      summaryItemId('tokens-today'),
      summaryItemId('tokens-week'),
      summaryItemId('cost-today'),
      statItemId('location'),
    ]);
    expect(state.usageCards).toEqual(['claude-code']);
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardStatCards: ['location'],
        dashboardUsageSummaryCards: ['tokens-today', 'tokens-week', 'cost-today'],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Dashboard reset to default.');
  });
});

describe('DashboardPage updates card', () => {
  it('reports that everything installed is current', async () => {
    renderPage(
      withStats({
        'cli.detectAll': [installedCli],
        'tools.detectAll': [],
        'cli.checkForUpdate': async () => ({
          cliId: 'claude-code',
          supported: true,
          currentVersion: '1.2.3',
          latestVersion: '1.2.3',
          updateAvailable: false,
        }),
      }),
    );

    expect(
      await screen.findByText(
        'All 1 installed CLI and agent tool is up to date.',
        {},
        {
          timeout: 5_000,
        },
      ),
    ).toBeTruthy();
  });

  it('offers the update command in a terminal when a newer version is out', async () => {
    const { user } = renderPage(
      withStats({
        'cli.detectAll': [installedCli],
        'tools.detectAll': [],
        'cli.checkForUpdate': async () => ({
          cliId: 'claude-code',
          supported: true,
          currentVersion: '1.2.3',
          latestVersion: '2.0.0',
          updateAvailable: true,
        }),
        'cli.getUpdateCommand': async () => 'claude update',
        'cli.checkCommandPrerequisite': async () => null,
      }),
    );

    expect(await screen.findByText('1 update', {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByText('v2.0.0')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Update/ }));

    // Nothing is run for the user: the command is typed into a session they still accept.
    await waitFor(() => {
      const session = useTerminalStore
        .getState()
        .sessions.find((one) => one.title === 'Update Claude Code CLI');
      expect(session?.initialInput).toBe('claude update');
    });
    expect(toast.info).toHaveBeenCalledWith(
      'Press Enter in the terminal to update Claude Code CLI.',
    );
  });

  it('says what is missing instead of opening an update terminal that would fail', async () => {
    const { user } = renderPage(
      withStats({
        'cli.detectAll': [installedCli],
        'tools.detectAll': [],
        'cli.checkForUpdate': async () => ({
          cliId: 'claude-code',
          supported: true,
          currentVersion: '1.2.3',
          latestVersion: '2.0.0',
          updateAvailable: true,
        }),
        // A copy installed with npm updates with npm, which this machine no longer has.
        'cli.getUpdateCommand': async () => 'npm install -g @anthropic-ai/claude-code@latest',
        'cli.checkCommandPrerequisite': { name: 'Node.js', url: 'https://nodejs.org/en/download' },
      }),
    );

    expect(await screen.findByText('1 update', {}, { timeout: 5_000 })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Update/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Claude Code CLI needs Node.js, which isn't installed.",
        expect.anything(),
      ),
    );
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalledWith(
      'Press Enter in the terminal to update Claude Code CLI.',
    );
  });
});

describe('DashboardPage Docker and emulator cards', () => {
  const MIN = 60_000;
  const IDLE_SETTINGS = { idleResourceMinutes: 20, idleResourceNotify: true };
  const idleSnapshot = {
    generatedAt: 10_000_000,
    watchingSince: 0,
    idleMinutes: 20,
    docker: 'ready',
    emulators: 'ready',
    resources: [
      {
        key: 'docker:a',
        kind: 'docker',
        id: 'a',
        name: 'postgres',
        detail: 'postgres:16',
        cpuPercent: 0.2,
        memBytes: 50 * 1024 ** 2,
        measurable: true,
        firstSeenAt: 0,
        lastActiveAt: 0,
        idleForMs: 33 * MIN,
        idle: true,
      },
    ],
    history: [
      {
        at: 1_000,
        dockerCpu: 1,
        dockerMem: 50 * 1024 ** 2,
        dockerCount: 1,
        emulatorCpu: 0,
        emulatorMem: 0,
        emulatorCount: 0,
      },
      {
        at: 2_000,
        dockerCpu: 2,
        dockerMem: 50 * 1024 ** 2,
        dockerCount: 1,
        emulatorCpu: 0,
        emulatorMem: 0,
        emulatorCount: 0,
      },
    ],
  };

  it('draws the usage chart and the idle list from what the main process tracked', async () => {
    seedLayout(['resource-usage', 'idle-resources']);
    renderPage(
      withStats({
        'resourceActivity.snapshot': async () => idleSnapshot,
        'settings.get': IDLE_SETTINGS,
      }),
    );

    const usage = await waitFor(() => cardFor('Docker and Emulator Usage'));
    await waitFor(() => expect(within(usage).getByText('2.0%')).toBeTruthy());
    expect(within(usage).getByText('1 container')).toBeTruthy();

    const idle = cardFor('Idle Docker and Emulators');
    expect(await within(idle).findByText('postgres')).toBeTruthy();
    expect(within(idle).getByText('idle 33 min')).toBeTruthy();
    expect(within(idle).getByText('idle of 1 running')).toBeTruthy();
  });

  it('removes each card in edit mode and says so', async () => {
    seedLayout(['resource-usage', 'idle-resources']);
    const { user } = renderPage(
      withStats({
        'resourceActivity.snapshot': async () => idleSnapshot,
        'settings.get': IDLE_SETTINGS,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));

    await user.click(
      within(cardFor('Idle Docker and Emulators')).getByRole('button', {
        name: 'Remove from dashboard',
      }),
    );

    await waitFor(() => expect(screen.queryByText('Idle Docker and Emulators')).toBeNull());
    expect(useDashboardLayoutStore.getState().chartCards).not.toContain('idle-resources');
    expect(toast.info).toHaveBeenCalledWith(
      'Idle Docker and Emulators removed from the dashboard.',
    );
    expect(screen.getByText('Docker and Emulator Usage')).toBeTruthy();
  });
});
