import type { DeployServer } from '@shared/deployTypes';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { InstallPanel } from './InstallPanel';

/**
 * The check of a server before its core goes on. A server that logs in and then stops answering
 * must end in a message and a way to try again, never in a skeleton that shimmers for good.
 */

const SERVER: DeployServer = {
  id: 'srv-1',
  nickname: 'Staging',
  host: 'staging.example',
  port: 22,
  username: 'sam',
  core: null,
  enrolled: false,
};

const SILENT =
  'Staging accepted the login but did not answer within 30 seconds. It may be overloaded or out of resources.';

/** The app's own retry rule, with no delay, so a retry would show up as a second call at once. */
function appLikeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, retryDelay: 0, staleTime: 0, gcTime: Infinity } },
  });
}

describe('InstallPanel check', () => {
  it('says the server is being checked while it waits', () => {
    renderWithProviders(<InstallPanel server={SERVER} />, {
      bridge: { 'deploy.preflight': () => new Promise(() => undefined) },
    });

    expect(screen.getByRole('status').textContent).toBe('Checking Staging.');
  });

  it('shows why a check failed, asks only once, and checks again on request', async () => {
    const preflight = vi.fn(async () => {
      throw new Error(`Error invoking remote method 'deploy:preflight': Error: ${SILENT}`);
    });
    const { user } = renderWithProviders(<InstallPanel server={SERVER} />, {
      bridge: { 'deploy.preflight': preflight },
      queryClient: appLikeClient(),
    });

    expect(await screen.findByText(SILENT)).toBeTruthy();
    expect(preflight).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Check again/ }));

    await waitFor(() => expect(preflight).toHaveBeenCalledTimes(2));
  });
});
