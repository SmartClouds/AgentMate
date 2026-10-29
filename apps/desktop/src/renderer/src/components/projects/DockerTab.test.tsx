import type { DockerContainer } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { project } from '../health/testing/fixtures';
import { DockerTab } from './DockerTab';

/**
 * A project's Docker tab shares its rows with the Docker page, so a container's log has to open
 * from here as well, for the containers this project's compose file started.
 */

const db: DockerContainer = {
  id: 'db-id',
  name: 'shop-db-1',
  image: 'postgres:16',
  state: 'running',
  status: 'Up 5 minutes',
  composeProject: 'shop',
  cpuPercent: null,
  memUsedBytes: null,
  memLimitBytes: null,
};

describe('DockerTab', () => {
  it("opens a container's log from its row", async () => {
    const logs = vi.fn().mockResolvedValue([
      {
        stream: 'stderr',
        timestamp: '2024-05-01T10:00:00.000000000Z',
        atUnixMs: Date.parse('2024-05-01T10:00:00.000Z'),
        text: 'database system is ready to accept connections',
      },
    ]);
    const { user } = renderWithProviders(<DockerTab project={project()} />, {
      bridge: {
        'docker.availability': async () => true,
        'docker.listForProject': [db],
        'docker.logs': logs,
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Show logs of shop-db-1' }));

    const dialog = await screen.findByRole('dialog', { name: 'shop-db-1' });
    expect(
      await within(dialog).findByText('database system is ready to accept connections'),
    ).toBeInTheDocument();
    expect(logs).toHaveBeenCalledWith('db-id', { tail: 500 });
  });
});
