import type { ResourceActivitySnapshot, ResourceUsagePoint } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ResourceUsageCard } from './ResourceUsageCard';

/**
 * The chart is hand drawn SVG, so what can be checked here is everything around it: that it waits
 * for data without claiming nothing is running, says why it is empty, only draws the kinds that
 * exist, and switches between CPU and memory.
 */

function point(overrides: Partial<ResourceUsagePoint> = {}): ResourceUsagePoint {
  return {
    at: 1_000,
    dockerCpu: 0,
    dockerMem: 0,
    dockerCount: 0,
    emulatorCpu: 0,
    emulatorMem: 0,
    emulatorCount: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ResourceActivitySnapshot> = {}): ResourceActivitySnapshot {
  return {
    generatedAt: 10_000_000,
    watchingSince: 0,
    idleMinutes: 20,
    docker: 'ready',
    emulators: 'ready',
    resources: [],
    history: [],
    ...overrides,
  };
}

const DOCKER_ONLY = [
  point({ at: 1_000, dockerCount: 2, dockerCpu: 10, dockerMem: 100 * 1024 ** 2 }),
  point({ at: 2_000, dockerCount: 2, dockerCpu: 12.5, dockerMem: 150 * 1024 ** 2 }),
];

const BOTH = [
  point({ at: 1_000, dockerCount: 2, dockerCpu: 10, dockerMem: 100 * 1024 ** 2 }),
  point({
    at: 2_000,
    dockerCount: 2,
    dockerCpu: 12.5,
    dockerMem: 150 * 1024 ** 2,
    emulatorCount: 1,
    emulatorCpu: 80,
    emulatorMem: 2 * 1024 ** 3,
  }),
];

function renderCard(
  data: ResourceActivitySnapshot | Promise<ResourceActivitySnapshot>,
  props: { onRemove?: () => void } = {},
) {
  return renderWithProviders(<ResourceUsageCard chartHeight={88} {...props} />, {
    bridge: { 'resourceActivity.snapshot': () => Promise.resolve(data) },
  });
}

describe('ResourceUsageCard', () => {
  it('shimmers until the first reading arrives', () => {
    const { container } = renderCard(new Promise(() => undefined));

    expect(container.querySelectorAll('.shimmer').length).toBeGreaterThan(0);
    expect(screen.queryByText(/No containers or emulators/)).toBeNull();
  });

  it('says nothing is running when it is not', async () => {
    renderCard(snapshot());
    expect(await screen.findByText('No containers or emulators are running.')).toBeTruthy();
  });

  it('says Docker is down when that is why the chart is empty', async () => {
    renderCard(snapshot({ docker: 'unavailable' }));
    expect(await screen.findByText('Docker is not running, and no emulators are up.')).toBeTruthy();
  });

  it('waits for a second reading before drawing a line', async () => {
    renderCard(snapshot({ history: [DOCKER_ONLY[0] as ResourceUsagePoint] }));
    expect(await screen.findByText('Collecting usage...')).toBeTruthy();
  });

  it('draws Docker alone when no emulator was ever running', async () => {
    const { container } = renderCard(snapshot({ history: DOCKER_ONLY }));

    expect(await screen.findByText('Docker')).toBeTruthy();
    expect(screen.queryByText('Emulators')).toBeNull();
    expect(container.querySelector('svg path')).toBeTruthy();
    expect(screen.getByText('2 containers')).toBeTruthy();
  });

  it('shows each kind with its latest CPU, on a scale where 100% is one core', async () => {
    renderCard(snapshot({ history: BOTH }));

    expect(await screen.findByText('Emulators')).toBeTruthy();
    expect(screen.getByText('Docker')).toBeTruthy();
    expect(screen.getByText('13%')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('2 containers · 1 emulator')).toBeTruthy();
  });

  it('switches the legend to memory', async () => {
    const { user } = renderCard(snapshot({ history: BOTH }));
    await screen.findByText('Emulators');

    await user.click(screen.getByRole('button', { name: 'Memory' }));

    expect(screen.getByText('150 MB')).toBeTruthy();
    expect(screen.getByText('2.00 GB')).toBeTruthy();
    expect(screen.queryByText('13%')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'CPU' }));
    expect(screen.getByText('13%')).toBeTruthy();
  });

  it('starts on CPU', async () => {
    renderCard(snapshot({ history: BOTH }));
    await screen.findByText('Emulators');
    expect(screen.getByRole('button', { name: 'CPU' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('offers Remove only when the dashboard is being edited', async () => {
    const onRemove = vi.fn();
    const { user, unmount } = renderCard(snapshot(), { onRemove });

    await user.click(await screen.findByRole('button', { name: 'Remove from dashboard' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    unmount();

    renderCard(snapshot());
    await screen.findByText('No containers or emulators are running.');
    expect(screen.queryByRole('button', { name: 'Remove from dashboard' })).toBeNull();
  });
});
