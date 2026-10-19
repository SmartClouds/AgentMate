import { healthDays } from '@agentmat/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePageHeaderStore } from '@/stores/pageHeaderStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import {
  detail,
  environment,
  incident,
  NOW,
  project,
  target,
} from '../components/health/testing/fixtures';

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

const { default: HealthPage } = await import('./HealthPage');
const { HealthBoard } = await import('../components/health/HealthBoard');

const projects = [project(), project({ id: 'p2', name: 'Admin' })];
const environments = async (projectId: string) =>
  projectId === 'p1'
    ? [environment(), environment({ id: 'env-staging', name: 'Staging', order: 1 })]
    : [];

const targets = [
  target({ id: 't1', name: 'API', environmentId: 'env-prod' }),
  target({
    id: 't2',
    name: 'Checkout',
    environmentId: 'env-staging',
    state: 'fail',
    headline: 'postgres: Connection refused',
    openIncident: incident({ targetId: 't2' }),
  }),
  target({
    id: 't3',
    projectId: 'p2',
    name: 'Dashboard',
    environmentId: null,
    state: 'paused',
    paused: true,
  }),
];

function renderPage(route = '/monitoring', bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<HealthPage />, {
    route,
    path: 'monitoring',
    bridge: {
      'projects.list': projects,
      'environments.list': environments,
      'health.list': targets,
      'health.get': async (id: string) => detail({ target: targets.find((t) => t.id === id) }),
      ...bridge,
    },
  });
}

describe('HealthPage', () => {
  it('names the page in the header', async () => {
    renderPage();
    await screen.findByRole('article', { name: 'API' });
    expect(usePageHeaderStore.getState().title).toBe('Monitoring');
  });

  it('starts with the three steps when nothing is watched yet', async () => {
    const { user } = renderPage('/monitoring', { 'health.list': [] });
    const steps = await screen.findByRole('list', { name: 'How to start' });
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Have your AI build the endpoint');
    expect(items[1]).toHaveTextContent('Add a target');
    expect(items[2]).toHaveTextContent('Test the connection');
    expect(screen.queryByRole('region', { name: 'Availability by day' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add a target' }));
    expect(await screen.findByRole('dialog', { name: 'Add a health check' })).toBeInTheDocument();
  });

  it('opens Build with AI from the first steps and from the toolbar', async () => {
    const empty = renderPage('/monitoring', { 'health.list': [] });
    await screen.findByRole('list', { name: 'How to start' });
    await empty.user.click(screen.getByRole('button', { name: 'Build with AI' }));
    expect(
      await screen.findByRole('dialog', { name: 'Build the endpoint with AI' }),
    ).toBeInTheDocument();
    empty.unmount();

    const { user } = renderPage();
    await screen.findByRole('article', { name: 'API' });
    await user.click(screen.getByRole('button', { name: 'Build with AI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    // With more than one project nothing is picked for the user: the prompt waits for a choice.
    expect(within(dialog).getByRole('combobox', { name: 'Project' })).toHaveTextContent(
      'Pick a project',
    );
    expect(within(dialog).queryByRole('region', { name: 'Prompt for your agent' })).toBeNull();
    const choices = within(dialog).getByRole('list', {
      name: 'Which project is the endpoint for?',
    });
    await user.click(within(choices).getByRole('button', { name: /Admin/ }));
    expect(within(dialog).getByRole('region', { name: 'Prompt for your agent' })).toHaveTextContent(
      'Add a healthcheck endpoint to Admin',
    );
  });

  it('starts Build with AI on the project the filter shows, or the only project', async () => {
    const { user } = renderPage();
    await screen.findByRole('article', { name: 'API' });
    await user.click(screen.getByRole('button', { name: 'Admin' }));
    await user.click(screen.getByRole('button', { name: 'Build with AI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    expect(within(dialog).getByRole('combobox', { name: 'Project' })).toHaveTextContent('Admin');
  });

  it('charts availability by day for the targets in view, following the project filter', async () => {
    // Today is the last of the 30 days; only today had checks.
    const days = (checks: number, failures: number) =>
      healthDays([], { days: 30, now: NOW }).map((day, i) =>
        i === 29 ? { ...day, checks, failures } : day,
      );
    const withDays = [
      { ...targets[0], daily: days(100, 0) },
      { ...targets[1], daily: days(100, 0) },
      { ...targets[2], daily: days(100, 50) },
    ];
    const { user } = renderPage('/monitoring', { 'health.list': withDays });
    const chart = await screen.findByRole('region', { name: 'Availability by day' });
    await waitFor(() => expect(chart).toHaveTextContent('83.3% up over 7 days'));

    await user.click(screen.getByRole('button', { name: 'Admin' }));
    expect(chart).toHaveTextContent('50.0% up over 7 days');
    await user.click(screen.getByRole('button', { name: 'All projects' }));

    // Search and the status filter narrow the cards, not the chart.
    await user.type(screen.getByLabelText('Search targets'), 'dash');
    expect(chart).toHaveTextContent('83.3% up over 7 days');
  });

  it('groups targets by project, then by environment', async () => {
    renderPage();
    const storefront = await screen.findByRole('region', { name: 'Storefront' });
    const production = within(storefront).getByRole('region', { name: 'Production' });
    const staging = within(storefront).getByRole('region', { name: 'Staging' });
    expect(within(production).getByRole('article', { name: 'API' })).toBeInTheDocument();
    expect(within(staging).getByRole('article', { name: 'Checkout' })).toBeInTheDocument();
    const admin = screen.getByRole('region', { name: 'Admin' });
    expect(within(admin).getByRole('region', { name: 'No environment' })).toBeInTheDocument();

    // Projects are in name order, so Admin comes before Storefront.
    const order = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(order.indexOf('Admin')).toBeLessThan(order.indexOf('Storefront'));
  });

  it('counts the states in the overview', async () => {
    renderPage();
    const overview = await screen.findByRole('region', { name: 'Monitoring overview' });
    await waitFor(() =>
      expect(within(overview).getByRole('button', { name: 'Down, 1' })).toBeInTheDocument(),
    );
    expect(within(overview).getByRole('button', { name: 'Healthy, 1' })).toBeInTheDocument();
    expect(
      within(overview).getByRole('button', { name: 'Paused or locked, 1' }),
    ).toBeInTheDocument();
  });

  it('opens the panel from a ?target deep link', async () => {
    renderPage('/monitoring?target=t2');
    expect(await screen.findByRole('dialog', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('opens the panel from a card', async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open API' }));
    expect(await screen.findByRole('dialog', { name: 'API' })).toBeInTheDocument();
  });

  it('narrows the list by status, project, environment and search', async () => {
    const { user } = renderPage();
    await screen.findByRole('article', { name: 'API' });

    const status = screen.getByRole('group', { name: 'Status' });
    await user.click(within(status).getByRole('button', { name: /Down/ }));
    expect(screen.queryByRole('article', { name: 'API' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Checkout' })).toBeInTheDocument();
    await user.click(within(status).getByRole('button', { name: /All/ }));

    await user.click(screen.getByRole('button', { name: 'Admin' }));
    expect(screen.queryByRole('article', { name: 'API' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Dashboard' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All projects' }));

    await user.click(screen.getByRole('combobox', { name: 'Environment filter' }));
    await user.click(await screen.findByRole('option', { name: 'Staging' }));
    expect(screen.queryByRole('article', { name: 'API' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Checkout' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Environment filter' }));
    await user.click(await screen.findByRole('option', { name: 'All environments' }));

    await user.type(screen.getByLabelText('Search targets'), 'dash');
    expect(screen.getByRole('article', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Checkout' })).toBeNull();
  });

  it('shimmers per card while the first list loads, without a page overlay', async () => {
    // A project of its own, since the page keeps the last good list between visits.
    const { queryClient } = renderWithProviders(<HealthBoard projectId="never-loaded" />, {
      bridge: { 'projects.list': projects, 'health.list': () => new Promise(() => undefined) },
    });
    expect(await screen.findAllByTestId('health-card-skeleton')).toHaveLength(3);
    expect(screen.getByRole('region', { name: 'Monitoring overview' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    // Every health read opts out of the full-page loading overlay.
    const loud = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'health' && !query.meta?.silentLoading);
    expect(loud).toHaveLength(0);
  });
});

describe('HealthBoard on a project tab', () => {
  it('lists only that project, without the project filter', async () => {
    const { bridge } = renderWithProviders(<HealthBoard projectId="p1" />, {
      bridge: {
        'projects.list': projects,
        'environments.list': environments,
        'health.list': targets,
      },
    });
    await screen.findByRole('article', { name: 'API' });
    expect(bridge.$fn('health.list')).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(screen.queryByRole('article', { name: 'Dashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All projects' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Production' })).toBeInTheDocument();
  });
});
