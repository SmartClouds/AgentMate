import { type HealthDayBucket, healthDays } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { HealthAvailabilityChart } from './HealthAvailabilityChart';
import { NOW, target } from './testing/fixtures';

/** 30 empty days ending today, on the same local midnights the main process uses. */
const EMPTY = healthDays([], { days: 30, now: NOW });

function daily(fill: Record<number, [checks: number, failures: number]>): HealthDayBucket[] {
  // Keys count back from today: 0 is today, 1 is yesterday.
  return EMPTY.map((day, i) => {
    const back = EMPTY.length - 1 - i;
    const [checks, failures] = fill[back] ?? [0, 0];
    return { ...day, checks, failures };
  });
}

function dayName(back: number): string {
  return new Date(EMPTY[EMPTY.length - 1 - back].start).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

const targets = [
  target({ id: 't1', name: 'API', daily: daily({ 0: [400, 0], 1: [400, 3], 2: [400, 40] }) }),
  target({ id: 't2', name: 'Checkout', daily: daily({ 0: [100, 0], 2: [100, 10] }) }),
];

function renderChart(overrides: Partial<Parameters<typeof HealthAvailabilityChart>[0]> = {}) {
  const onOpenTarget = vi.fn();
  const result = renderWithProviders(
    <HealthAvailabilityChart
      targets={targets}
      loading={false}
      now={NOW}
      onOpenTarget={onOpenTarget}
      {...overrides}
    />,
  );
  return { ...result, onOpenTarget };
}

function bars(): HTMLElement[] {
  const chart = screen.getByRole('group', { name: 'Days' });
  return within(chart).getAllByRole('button');
}

describe('HealthAvailabilityChart', () => {
  it('adds the targets together, one bar per day for the last week', () => {
    renderChart();
    const region = screen.getByRole('region', { name: 'Availability by day' });
    expect(bars()).toHaveLength(7);
    // 1400 checks over the week, 53 of them failed.
    expect(region).toHaveTextContent('96.2% up over 7 days');

    expect(
      screen.getByRole('button', { name: `${dayName(0)}: 100% up, 0 of 500 checks failed` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `${dayName(1)}: 99.25% up, 3 of 400 checks failed` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${dayName(3)}: no checks` })).toBeInTheDocument();
  });

  it('colours each day by how much of it was up', () => {
    renderChart();
    const tone = (back: number) =>
      screen.getByRole('button', { name: new RegExp(`^${dayName(back)}:`) }).dataset.tone;
    expect(tone(0)).toBe('good');
    expect(tone(1)).toBe('warning');
    expect(tone(2)).toBe('bad');
    expect(tone(3)).toBe('none');
  });

  it('switches to 30 days', async () => {
    const { user } = renderChart();
    await user.click(screen.getByRole('button', { name: '30 days' }));
    expect(bars()).toHaveLength(30);
    expect(screen.getByRole('region', { name: 'Availability by day' })).toHaveTextContent(
      'over 30 days',
    );
  });

  it('names the targets that failed on a day, and opens one from the picked day', async () => {
    const { user, onOpenTarget } = renderChart();
    await user.hover(screen.getByRole('button', { name: new RegExp(`^${dayName(2)}:`) }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('API');
    expect(tip).toHaveTextContent('Checkout');

    const bad = screen.getByRole('button', { name: new RegExp(`^${dayName(2)}:`) });
    await user.click(bad);
    expect(bad).toHaveAttribute('aria-pressed', 'true');
    const list = screen.getByRole('list', { name: `Failed checks on ${dayName(2)}` });
    const items = within(list).getAllByRole('button');
    // Most failures first.
    expect(items.map((item) => item.textContent)).toEqual(['API40 failed', 'Checkout10 failed']);
    await user.click(items[1]);
    expect(onOpenTarget).toHaveBeenCalledWith('t2');

    await user.click(bad);
    expect(screen.queryByRole('list', { name: /Failed checks on/ })).toBeNull();
  });

  it('does not pick a day without failures', async () => {
    const { user } = renderChart();
    const good = screen.getByRole('button', { name: new RegExp(`^${dayName(0)}:`) });
    await user.click(good);
    expect(good).not.toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('list', { name: /Failed checks on/ })).toBeNull();
  });

  it('says there were no checks when the range is empty', () => {
    renderChart({ targets: [target({ daily: [] })] });
    expect(bars()).toHaveLength(7);
    expect(screen.getByRole('region', { name: 'Availability by day' })).toHaveTextContent(
      'No checks in the last 7 days',
    );
  });

  it('shimmers while loading', () => {
    renderChart({ loading: true });
    expect(screen.getByRole('status', { name: 'Loading availability' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Days' })).toBeNull();
  });
});
