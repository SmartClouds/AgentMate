import type { HealthLatencyPoint } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { HealthLatencyChart } from './HealthLatencyChart';
import { incident, NOW } from './testing/fixtures';

const HOUR = 3_600_000;

function point(hoursAgo: number, p50: number | null, p95: number | null = p50): HealthLatencyPoint {
  return {
    start: NOW - hoursAgo * HOUR,
    checks: p50 === null ? 0 : 60,
    failures: 0,
    p50,
    p95,
  };
}

const latency = [point(3, 120, 300), point(2, null), point(1, 90, 200), point(0, 80, 140)];

describe('HealthLatencyChart', () => {
  it('draws the median and the 95th percentile of the hours that had readings', () => {
    const { container } = renderWithProviders(
      <HealthLatencyChart latency={latency} incidents={[]} now={NOW} />,
    );
    const plot = screen.getByRole('img', { name: /^Response time, 3 readings/ });
    expect(plot).toHaveAccessibleName(/Latest: Median 80 ms, 95th percentile 140 ms\.$/);
    expect(container.querySelectorAll('path[data-series]')).toHaveLength(2);
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('Median')).toBeInTheDocument();
    expect(within(legend).getByText('95th percentile')).toBeInTheDocument();
  });

  it('shades the incidents inside the window, an open one up to now', () => {
    const { container } = renderWithProviders(
      <HealthLatencyChart
        latency={latency}
        incidents={[
          incident({ id: 'open', openedAt: NOW - 30 * 60_000, resolvedAt: null }),
          incident({ id: 'old', openedAt: NOW - 30 * HOUR, resolvedAt: NOW - 29 * HOUR }),
        ]}
        now={NOW}
      />,
    );
    const bands = container.querySelectorAll('rect[data-band]');
    expect([...bands].map((band) => band.getAttribute('data-band'))).toEqual(['open']);
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Incident')).toBeTruthy();
  });

  it('says so instead of drawing a chart from fewer than two readings', () => {
    renderWithProviders(
      <HealthLatencyChart latency={[point(1, null), point(0, 90)]} incidents={[]} now={NOW} />,
    );
    expect(screen.getByText('Not enough checks yet for a chart.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
