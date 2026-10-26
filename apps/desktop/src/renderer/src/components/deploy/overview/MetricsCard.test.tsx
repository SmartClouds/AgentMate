import type { MetricsSample } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { memoryAmounts } from '@/lib/deploy/overview/metrics';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { MetricsCard } from './MetricsCard';
import { SERVER, samples } from './testing/fixtures';

/** The history card: the range switch, stored history, its empty and failed states, the table. */

function renderCard(props: Partial<Parameters<typeof MetricsCard>[0]> = {}, bridge = {}) {
  return renderWithProviders(
    <MetricsCard
      serverId={SERVER.id}
      live={samples(4)}
      liveReady
      liveError={null}
      stale={false}
      {...props}
    />,
    { bridge },
  );
}

describe('MetricsCard', () => {
  it('starts live, with four charts and a legend where two series share one', () => {
    renderCard();
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('img')).toHaveLength(4);
    expect(screen.getAllByRole('list', { name: 'Legend' })).toHaveLength(2);
    expect(screen.getByText(/the last 15 minutes/)).toBeInTheDocument();
  });

  it('reads the memory used and total at the reading under the pointer', () => {
    renderCard();
    const memory = screen.getByRole('img', { name: /^Memory, 4 readings/ });
    fireEvent.keyDown(memory, { key: 'End' });
    const reading = samples(4).at(-1);
    expect(screen.getByRole('tooltip')).toHaveTextContent(memoryAmounts(reading as MetricsSample));
    expect(memory.getAttribute('aria-label')).toContain(
      `(${memoryAmounts(reading as MetricsSample)})`,
    );
  });

  it('shimmers until the live readings are in, and waits for the first one', () => {
    const { unmount } = renderCard({ liveReady: false, live: [] });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    unmount();
    renderCard({ live: [] });
    expect(screen.getByText('Waiting for the first reading from the server.')).toBeInTheDocument();
  });

  it('reads stored minutes for a longer range, and says when there are none', async () => {
    const { user, bridge } = renderCard(
      {},
      { 'deploySystem.metricsHistory': { resolution: 'minute', intervalSeconds: 60, samples: [] } },
    );
    await user.click(screen.getByRole('radio', { name: '6 hours' }));
    expect(await screen.findByText(/No readings stored for this range yet/)).toBeInTheDocument();
    expect(bridge.$fn('deploySystem.metricsHistory')).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER.id,
        resolution: 'minute',
        fromUnixMs: expect.any(Number),
      }),
    );
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() =>
      expect(bridge.$fn('deploySystem.metricsHistory')).toHaveBeenLastCalledWith(
        expect.objectContaining({ resolution: 'quarterHour' }),
      ),
    );
  });

  it('says why stored history did not load', async () => {
    const { user } = renderCard(
      {},
      { 'deploySystem.metricsHistory': () => Promise.reject(new Error('nope')) },
    );
    await user.click(screen.getByRole('radio', { name: '2 days' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The readings did not load: nope');
  });

  it('keeps the newest 60 readings in the table and dims while the connection is down', async () => {
    const { user } = renderCard({ live: samples(70), stale: true });
    await user.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByRole('table', { name: 'Readings' });
    expect(within(table).getAllByRole('row')).toHaveLength(61);
    expect(screen.getByText('The newest 60 of 70 readings.')).toBeInTheDocument();
    expect(table.parentElement?.parentElement).toHaveClass('opacity-50');
    await user.click(screen.getByRole('button', { name: 'Charts' }));
    expect(screen.getAllByRole('img')).toHaveLength(4);
  });

  it('says why live readings did not load when there are none', () => {
    renderCard({ live: [], liveError: 'down' });
    expect(screen.getByRole('alert')).toHaveTextContent('The readings did not load: down');
  });
});
