import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { connection, issue, link, page } from '../errorTracking/testing/fixtures';
import { detail, project, target } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { MonitoringView } = await import('./MonitoringView');

function Where(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="location">{location.search}</output>;
}

function renderView(
  route = '/monitoring',
  bridge: Record<string, unknown> = {},
  projectId?: string,
) {
  return renderWithProviders(
    <>
      <MonitoringView projectId={projectId} />
      <Where />
    </>,
    {
      route,
      path: 'monitoring',
      bridge: {
        'projects.list': [project()],
        'environments.list': [],
        'health.list': [target()],
        'health.get': async () => detail(),
        'errorTracking.listConnections': [connection()],
        'errorTracking.listLinks': [link()],
        'errorTracking.environments': [],
        'errorTracking.listIssues': async () =>
          page({ issues: [issue(), issue({ id: '4502', title: 'Second' })] }),
        ...bridge,
      },
    },
  );
}

/** `hidden`, since an open panel marks the rest of the page hidden from screen readers. */
function tabs() {
  return screen.getByRole('navigation', { name: 'Monitoring view', hidden: true });
}

describe('MonitoringView', () => {
  it('starts on Uptime', async () => {
    renderView();
    expect(await screen.findByRole('article', { name: 'API' })).toBeInTheDocument();
    expect(within(tabs()).getByRole('button', { name: /Uptime/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.queryByRole('list', { name: 'Issues' })).toBeNull();
  });

  it('switches to Errors and keeps it in the address', async () => {
    const { user } = renderView('/monitoring?tab=monitoring');
    await screen.findByRole('article', { name: 'API' });
    await user.click(within(tabs()).getByRole('button', { name: /Errors/ }));
    expect(await screen.findByRole('list', { name: 'Issues' })).toBeInTheDocument();
    const search = screen.getByRole('status', { name: 'location' }).textContent ?? '';
    expect(search).toContain('view=errors');
    expect(search).toContain('tab=monitoring');

    await user.click(within(tabs()).getByRole('button', { name: /Uptime/ }));
    expect(await screen.findByRole('article', { name: 'API' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'location' }).textContent).not.toContain('view=');
  });

  it('opens on Errors from ?view=errors', async () => {
    renderView('/monitoring?view=errors');
    expect(await screen.findByRole('list', { name: 'Issues' })).toBeInTheDocument();
  });

  it('lands a ?target link on Uptime', async () => {
    renderView('/monitoring?target=t1');
    expect(await screen.findByRole('dialog', { name: 'API' })).toBeInTheDocument();
    expect(within(tabs()).getByRole('button', { name: /Uptime/, hidden: true })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('counts the unresolved issues on the Errors tab once they load', async () => {
    renderView();
    await waitFor(
      () =>
        expect(within(tabs()).getByRole('button', { name: /Errors/ })).toHaveTextContent('Errors2'),
      // Three reads in a row (connections, links, issues), so allow for a busy machine.
      { timeout: 5000 },
    );
  });

  it('asks Sentry nothing while no connection exists', async () => {
    const { bridge } = renderView('/monitoring', { 'errorTracking.listConnections': [] });
    await screen.findByRole('article', { name: 'API' });
    await waitFor(() => expect(bridge.$fn('errorTracking.listConnections')).toHaveBeenCalled());
    expect(() => bridge.$fn('errorTracking.listIssues')).toThrow();
  });

  it('passes the project through on a project tab', async () => {
    const { user, bridge } = renderView('/monitoring', {}, 'p1');
    await screen.findByRole('article', { name: 'API' });
    await user.click(within(tabs()).getByRole('button', { name: /Errors/ }));
    await screen.findByRole('list', { name: 'Issues' });
    expect(bridge.$fn('errorTracking.listIssues')).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1' }),
    );
  });
});
