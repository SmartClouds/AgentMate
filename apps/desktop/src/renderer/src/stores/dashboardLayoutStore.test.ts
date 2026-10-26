import { DASHBOARD_CHART_IDS, type DashboardRow, DEFAULT_DASHBOARD } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { initDashboardLayout, useDashboardLayoutStore } from './dashboardLayoutStore';

/**
 * A chart added in a later release has to reach people who already arranged their dashboard,
 * exactly once, without bringing back a card they deliberately removed. The settings file keeps
 * a list of the charts each profile has been offered, and these tests drive that through the
 * real init.
 */

const ORIGINAL = ['cpu', 'memory', 'disk', 'gpu', 'network', 'pings', 'github'];

function layoutOf(rows: DashboardRow[]): string[][] {
  return rows.map((row) => row.items);
}

function start(settings: Record<string, unknown>) {
  const bridge = installRunovaBridge({ 'settings.get': settings });
  return bridge;
}

beforeEach(() => {
  useDashboardLayoutStore.setState({ rows: [], chartCards: [], editing: false });
});

describe('initDashboardLayout introduces charts added later', () => {
  const existing = {
    // Stat tiles are left out so only the charts decide where the new cards land.
    dashboardStatCards: [],
    dashboardChartCards: [...ORIGINAL, 'github-actions'],
    dashboardIntroducedCharts: [...ORIGINAL, 'github-actions'],
    dashboardLayout: [
      { id: 'a', columns: 2, items: ['network', 'pings'] },
      { id: 'b', columns: 2, items: ['cpu', 'gpu'] },
      { id: 'c', columns: 2, items: ['memory', 'disk'] },
      { id: 'd', columns: 2, items: ['github', 'github-actions'] },
    ],
  };

  it('adds both usage cards to a dashboard arranged before they existed', async () => {
    start(existing);

    await initDashboardLayout();

    const state = useDashboardLayoutStore.getState();
    expect(state.chartCards).toContain('resource-usage');
    expect(state.chartCards).toContain('idle-resources');
    // Every row was full, so they open a new one and sit side by side.
    expect(layoutOf(state.rows).at(-1)).toEqual(['resource-usage', 'idle-resources']);
    expect(layoutOf(state.rows).slice(0, 4)).toEqual([
      ['network', 'pings'],
      ['cpu', 'gpu'],
      ['memory', 'disk'],
      ['github', 'github-actions'],
    ]);
  });

  it('records that they were introduced, so it only ever happens once', async () => {
    const bridge = start(existing);

    await initDashboardLayout();

    const saved = bridge.$fn('settings.update').mock.calls.at(-1)?.[0] as {
      dashboardIntroducedCharts: string[];
      dashboardChartCards: string[];
    };
    expect(saved.dashboardIntroducedCharts).toEqual([...DASHBOARD_CHART_IDS]);
    expect(saved.dashboardChartCards).toEqual(expect.arrayContaining(['idle-resources']));
  });

  it('does not bring back a card the user removed after being offered it', async () => {
    start({
      ...existing,
      dashboardIntroducedCharts: [
        ...ORIGINAL,
        'github-actions',
        'resource-usage',
        'idle-resources',
      ],
      dashboardChartCards: [...ORIGINAL, 'github-actions', 'resource-usage'],
    });

    await initDashboardLayout();

    const state = useDashboardLayoutStore.getState();
    expect(state.chartCards).toContain('resource-usage');
    expect(state.chartCards).not.toContain('idle-resources');
    expect(layoutOf(state.rows).flat()).not.toContain('idle-resources');
  });

  it('leaves a profile that already has everything alone, without saving anything', async () => {
    const bridge = start({
      ...existing,
      dashboardChartCards: [...DASHBOARD_CHART_IDS],
      dashboardIntroducedCharts: [...DASHBOARD_CHART_IDS],
      dashboardLayout: [
        ...existing.dashboardLayout,
        { id: 'e', columns: 2, items: ['resource-usage', 'idle-resources'] },
      ],
    });

    await initDashboardLayout();

    expect(layoutOf(useDashboardLayoutStore.getState().rows).at(-1)).toEqual([
      'resource-usage',
      'idle-resources',
    ]);
    expect(() => bridge.$fn('settings.update')).toThrow();
  });

  it('opens a brand new install with the two cards together in the default layout', async () => {
    start({
      dashboardChartCards: [...DEFAULT_DASHBOARD.dashboardChartCards],
      dashboardIntroducedCharts: [...DASHBOARD_CHART_IDS],
      dashboardStatCards: DEFAULT_DASHBOARD.dashboardStatCards,
      dashboardUsageCards: DEFAULT_DASHBOARD.dashboardUsageCards,
      dashboardUsageSummaryCards: DEFAULT_DASHBOARD.dashboardUsageSummaryCards,
      dashboardLayout: DEFAULT_DASHBOARD.dashboardLayout,
    });

    await initDashboardLayout();

    const rows = useDashboardLayoutStore.getState().rows;
    expect(rows.find((row) => row.items.includes('idle-resources'))?.items).toEqual([
      'resource-usage',
      'idle-resources',
    ]);
    // Each card appears once.
    const all = layoutOf(rows).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
