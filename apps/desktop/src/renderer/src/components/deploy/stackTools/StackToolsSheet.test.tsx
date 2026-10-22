import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { AppsAccess } from '../apps/hooks';
import { appsBridge, SERVER, STACK_ID, sampleDetails } from '../apps/testing/fixtures';
import { SERVER as DOCKER_SERVER, dockerBridge } from '../containers/testing/fixtures';

/**
 * An app's logs and consoles in one sheet, opened from the app's page and from the container
 * list: every service's log together or one container's, and a console or a command in a running
 * container, for Admins only.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/terminal/TerminalPane', () => ({
  TerminalPane: ({ meta }: { meta: { container?: { containerId: string; user?: string } } }) => (
    <span>
      Terminal for {meta.container?.containerId}
      {meta.container?.user ? ` as ${meta.container.user}` : ''}
    </span>
  ),
}));

const { AppDetail } = await import('../apps/AppDetail');
const { ContainersPanel } = await import('../containers/ContainersPanel');

const LOGS = {
  'deployDocker.watchLogs': async (input: { containerId: string }) => `logs-${input.containerId}`,
  'deployDocker.unwatchLogs': async () => true,
};

function access(roles: string[]): AppsAccess {
  const admin = roles.some((role) => ['owner', 'admin'].includes(role));
  return { pending: false, signedIn: true, roles, canOperate: true, canAdmin: admin };
}

async function renderApp(roles = ['owner'], bridge: Record<string, unknown> = {}) {
  const view = renderWithProviders(
    <AppDetail
      serverId={SERVER.id}
      stackId={STACK_ID}
      access={access(roles)}
      onBack={vi.fn()}
      onDeployAgain={vi.fn()}
      onDeleted={vi.fn()}
    />,
    { bridge: { ...appsBridge(roles), ...LOGS, ...bridge } },
  );
  await screen.findByRole('heading', { name: 'shop' }, { timeout: 10_000 });
  return view;
}

describe('StackToolsSheet from an app', () => {
  it('follows every service of the app together from the toolbar', async () => {
    const { user, bridge } = await renderApp();
    await user.click(
      within(screen.getByRole('toolbar', { name: 'App actions' })).getByRole('button', {
        name: 'Logs',
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'shop' });
    expect(within(sheet).getByText('1 container, running')).toBeInTheDocument();
    expect(within(sheet).getByRole('log', { name: 'Log: shop' })).toBeInTheDocument();
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        containerId: 'c1',
        follow: true,
        tail: 500,
      }),
    );
  });

  it('opens one container’s log, and a console in it for an Admin', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Logs of shop-web-1' }));
    let sheet = await screen.findByRole('dialog', { name: 'shop' });
    expect(within(sheet).getByRole('log', { name: 'Log: shop-web-1' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Console in shop-web-1' }));
    sheet = await screen.findByRole('dialog', { name: 'shop' });
    expect(within(sheet).getByRole('tab', { name: 'Console', selected: true })).toBeInTheDocument();
    await user.click(within(sheet).getByLabelText('User'));
    await user.click(await screen.findByRole('option', { name: 'root' }));
    await user.click(within(sheet).getByRole('button', { name: /Open a console/ }));
    expect(within(sheet).getByText('Terminal for c1 as root')).toBeInTheDocument();
  });

  it('keeps consoles from anyone below Admin', async () => {
    const { user } = await renderApp(['operator']);
    const toolbar = screen.getByRole('toolbar', { name: 'App actions' });
    expect(within(toolbar).getByRole('button', { name: 'Console' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Console in shop-web-1' })).toBeDisabled();

    await user.click(within(toolbar).getByRole('button', { name: 'Logs' }));
    const sheet = await screen.findByRole('dialog', { name: 'shop' });
    await user.click(within(sheet).getByRole('tab', { name: 'Console' }));
    expect(within(sheet).getByText('Consoles are for Admins')).toBeInTheDocument();
  });

  it('says when nothing runs to open a console in', async () => {
    const details = sampleDetails();
    const stopped = sampleDetails({
      services: details.services.map((service) => ({
        ...service,
        containers: service.containers.map((container) => ({
          ...container,
          state: 'exited',
          status: 'Exited (0)',
        })),
      })),
    });
    const { user } = await renderApp(['owner'], { 'deployStacks.get': stopped });
    expect(screen.queryByRole('button', { name: 'Console in shop-web-1' })).not.toBeInTheDocument();
    await user.click(
      within(screen.getByRole('toolbar', { name: 'App actions' })).getByRole('button', {
        name: 'Console',
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'shop' });
    expect(within(sheet).getByText('Nothing is running')).toBeInTheDocument();
  });
});

describe('StackToolsSheet from the container list', () => {
  it('follows a compose project’s services from its group header, and only its own', async () => {
    const { user, bridge } = renderWithProviders(<ContainersPanel server={DOCKER_SERVER} />, {
      bridge: { ...dockerBridge(), ...LOGS },
    });
    await screen.findByRole('list', { name: 'Containers' }, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: 'Logs of shop' }));
    const sheet = await screen.findByRole('dialog', { name: 'shop' });
    expect(within(sheet).getByText('4 of 4 containers running')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        bridge
          .$fn('deployDocker.watchLogs')
          .mock.calls.filter((call) => (call[0] as { tail?: number }).tail === 500),
      ).toHaveLength(4),
    );
    await user.click(within(sheet).getByLabelText('Log source'));
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options.every((text) => /shop/.test(text ?? ''))).toBe(true);
  });
});
