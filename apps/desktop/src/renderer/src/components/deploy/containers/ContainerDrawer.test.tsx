import { API_TOKEN, DB_PASSWORD } from '@shared/deploy/testing/fakeDockerData';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { dockerBridge, logLines, SERVER, seededDocker, statsBatch, T0 } from './testing/fixtures';

/**
 * One container up close: its facts, live figures, log with search, variables by name with an
 * Admin's reveal behind a step-up, mounts, ports, console, and a removal that asks for the name
 * when volumes go too (AC2).
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/terminal/TerminalPane', () => ({
  TerminalPane: ({
    meta,
    onExit,
  }: {
    meta: { container?: { containerId: string; command?: string[]; user?: string } };
    onExit: () => void;
  }) => (
    <button type="button" onClick={onExit}>
      Terminal for {meta.container?.containerId}
      {meta.container?.command ? ` running ${JSON.stringify(meta.container.command)}` : ''}
      {meta.container?.user ? ` as ${meta.container.user}` : ''}
    </button>
  ),
}));

const { ContainersPanel } = await import('./ContainersPanel');

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}`}</span>;
}

const STEP_UP = new Error(
  "Error invoking remote method 'deployDocker:revealEnv': Error: [core:stepUpRequired] Confirm your password.",
);

async function openContainer(name: string, bridge: Record<string, unknown> = {}, roles?: string[]) {
  const view = renderWithProviders(
    <>
      <ContainersPanel server={SERVER} />
      <ConfirmDialogHost />
      <LocationProbe />
    </>,
    { bridge: { ...dockerBridge(roles), ...bridge } },
  );
  // The first render of a file pays for loading the screen; give it time on a busy machine.
  const list = await screen.findByRole('list', { name: 'Containers' }, { timeout: 10_000 });
  await view.user.click(within(list).getByRole('button', { name: `Open ${name}` }));
  const drawer = await screen.findByRole('dialog', { name: name }, { timeout: 10_000 });
  return { ...view, drawer };
}

describe('ContainerDrawer', () => {
  it('shows what the container is', async () => {
    const { drawer } = await openContainer('shop-api-1');
    expect(within(drawer).getByText('shop-api:latest', { selector: 'p' })).toBeInTheDocument();
    expect(await within(drawer).findByText('node server.js')).toBeInTheDocument();
    expect(within(drawer).getByText(/unless-stopped, restarted 0 times/)).toBeInTheDocument();
    expect(within(drawer).getByText(/512 MB/)).toBeInTheDocument();
    expect(within(drawer).getByText(/shop_default \(172\.20\.0\.5\)/)).toBeInTheDocument();
  });

  it('draws live figures once they come in', async () => {
    const { user, bridge, drawer } = await openContainer('shop-api-1');
    await user.click(within(drawer).getByRole('tab', { name: 'Stats' }));
    expect(within(drawer).getByRole('tabpanel').querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() =>
      bridge.$emit('deployDocker.onStats', {
        subscriptionId: 'stats-1',
        serverId: SERVER.id,
        batches: [statsBatch(T0, 0), statsBatch(T0 + 2_000, 1), statsBatch(T0 + 4_000, 2)],
      }),
    );
    expect(within(drawer).getByRole('group', { name: 'Processor' })).toHaveTextContent('%');
    expect(within(drawer).getByRole('group', { name: 'Memory' })).toHaveTextContent('of 2.00 GB');
    expect(within(drawer).getByRole('group', { name: 'Network' })).toHaveTextContent('in');
    expect(within(drawer).getByRole('list', { name: 'Disk legend' })).toHaveTextContent('Written');
  });

  it('says a stopped container has no figures', async () => {
    const { user, drawer } = await openContainer('migrate-once');
    await user.click(within(drawer).getByRole('tab', { name: 'Stats' }));
    expect(
      within(drawer).getByText(/is not running, so there are no live figures/),
    ).toBeInTheDocument();
  });

  it('follows the log, marks stderr in words, and finds matches', async () => {
    const { user, bridge, drawer } = await openContainer('shop-api-1');
    await user.click(within(drawer).getByRole('tab', { name: 'Logs' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenCalledWith(
        expect.objectContaining({ containerId: expect.any(String), follow: true, tail: 500 }),
      ),
    );
    const containerId = seededDocker().require('shop-api-1').summary.id;
    act(() =>
      bridge.$emit('deployDocker.onLogs', {
        subscriptionId: 'logs-1',
        serverId: SERVER.id,
        containerId,
        lines: logLines([
          ['listening on 3000', 'stdout'],
          ['database error: timeout', 'stderr'],
          ['retrying after error', 'stdout'],
        ]),
      }),
    );
    const log = within(drawer).getByRole('log', { name: 'Log of shop-api-1' });
    expect(log).toHaveTextContent('database error: timeout');
    expect(log.querySelector('[data-stream="stderr"]')).toHaveTextContent('err');

    await user.type(within(drawer).getByRole('textbox', { name: 'Search the log' }), 'error');
    expect(within(drawer).getByText('1 of 2')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Next match' }));
    expect(within(drawer).getByText('2 of 2')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Previous match' }));
    expect(within(drawer).getByText('1 of 2')).toBeInTheDocument();
    expect(log.querySelectorAll('mark')).toHaveLength(2);

    act(() =>
      bridge.$emit('deployDocker.onLogs', {
        subscriptionId: 'logs-1',
        serverId: SERVER.id,
        containerId,
        lines: [],
        ended: {},
      }),
    );
    expect(within(drawer).getByText('The log stream ended.')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /Read again/ }));
    await user.click(within(drawer).getByRole('switch', { name: 'Follow new lines' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenLastCalledWith(
        expect.objectContaining({ follow: false }),
      ),
    );
  });

  it('says when the log cannot be read', async () => {
    const { user, drawer } = await openContainer('shop-api-1', {
      'deployDocker.watchLogs': () =>
        Promise.reject(new Error('Four container logs are already open.')),
    });
    await user.click(within(drawer).getByRole('tab', { name: 'Logs' }));
    expect(
      await within(drawer).findByText('Four container logs are already open.'),
    ).toBeInTheDocument();
    expect(within(drawer).getByText('Nothing to show.')).toBeInTheDocument();
  });

  it('lists variables by name and shows values to an Admin after a step-up', async () => {
    let calls = 0;
    const { user, bridge, drawer } = await openContainer('shop-api-1', {
      'deployDocker.revealEnv': async (input: { password?: string }) => {
        calls += 1;
        if (!input.password) throw STEP_UP;
        return [
          { name: 'DATABASE_URL', value: `postgres://shop:${DB_PASSWORD}@db:5432/shop` },
          { name: 'API_TOKEN', value: API_TOKEN },
        ];
      },
    });
    await user.click(within(drawer).getByRole('tab', { name: 'Inspect' }));
    const variables = await within(drawer).findByRole('list', { name: 'Variables' });
    expect(variables).toHaveTextContent('DATABASE_URL');
    expect(variables).not.toHaveTextContent(DB_PASSWORD);

    await user.click(within(drawer).getByRole('button', { name: /Show values/ }));
    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    await user.type(within(proof).getByLabelText('Password'), 'correct horse');
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(variables).toHaveTextContent(API_TOKEN));
    expect(calls).toBe(2);
    expect(bridge.$fn('deployDocker.revealEnv')).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: 'correct horse' }),
    );
    await user.click(within(drawer).getByRole('button', { name: /Hide values/ }));
    expect(variables).not.toHaveTextContent(API_TOKEN);
  });

  it('keeps values from anyone below Admin', async () => {
    const { user, drawer } = await openContainer('shop-api-1', {}, ['operator']);
    await user.click(within(drawer).getByRole('tab', { name: 'Inspect' }));
    expect(await within(drawer).findByText('Values are for Admins')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Show values/ })).toBeNull();
    await user.click(within(drawer).getByRole('tab', { name: 'Console' }));
    expect(within(drawer).getByText(/Consoles are for Admins/)).toBeInTheDocument();
  });

  it('says why a reveal failed', async () => {
    const { user, drawer } = await openContainer('shop-api-1', {
      'deployDocker.revealEnv': () =>
        Promise.reject(new Error('[core:forbidden] Your role cannot do that.')),
    });
    await user.click(within(drawer).getByRole('tab', { name: 'Inspect' }));
    await user.click(await within(drawer).findByRole('button', { name: /Show values/ }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Your role cannot do that.');
  });

  it('shows mounts, ports and labels', async () => {
    const { user, drawer } = await openContainer('shop-web-1');
    await user.click(within(drawer).getByRole('tab', { name: 'Mounts' }));
    const mounts = await within(drawer).findByRole('table', { name: 'Mounts' });
    expect(mounts).toHaveTextContent('/srv/uploads');
    expect(mounts).toHaveTextContent('Read only');
    await user.click(within(drawer).getByRole('tab', { name: 'Ports' }));
    expect(within(drawer).getByRole('list', { name: 'Ports' })).toHaveTextContent(
      '127.0.0.1:8080 -> 80/tcp',
    );
    await user.click(within(drawer).getByRole('tab', { name: 'Inspect' }));
    expect(await within(drawer).findByRole('region', { name: 'Labels' })).toHaveTextContent(
      'com.docker.compose.project',
    );
  });

  it('marks a public port, and a container with nothing mounted or published', async () => {
    const { user, drawer } = await openContainer('monitoring-grafana-1');
    await user.click(within(drawer).getByRole('tab', { name: 'Ports' }));
    expect(within(drawer).getAllByText(/Public: anyone who can reach the server/)).toHaveLength(2);
    await user.click(within(drawer).getByRole('tab', { name: 'Mounts' }));
    expect(
      await within(drawer).findByText('Nothing is mounted into this container.'),
    ).toBeInTheDocument();
  });

  it('opens a console for an Admin and offers a new one when the shell ends', async () => {
    const { user, drawer } = await openContainer('toolbox');
    await user.click(within(drawer).getByRole('tab', { name: 'Console' }));
    await user.click(within(drawer).getByRole('button', { name: /Open a console/ }));
    const terminal = within(drawer).getByRole('button', { name: /Terminal for/ });
    await user.click(terminal);
    expect(within(drawer).getByText('The shell has ended.')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Open a new one' }));
    await user.click(within(drawer).getByRole('button', { name: 'Close the console' }));
    expect(within(drawer).getByRole('button', { name: /Open a console/ })).toBeInTheDocument();
  });

  it('runs a chosen command as a chosen user, and runs it again only when asked', async () => {
    const { user, drawer } = await openContainer('toolbox');
    await user.click(within(drawer).getByRole('tab', { name: 'Console' }));
    await user.type(within(drawer).getByLabelText('Command'), 'php artisan migrate | tail -n 5');
    await user.click(within(drawer).getByLabelText('User'));
    await user.click(await screen.findByRole('option', { name: 'root' }));
    await user.click(within(drawer).getByRole('button', { name: /^Run$/ }));

    const terminal = within(drawer).getByRole('button', { name: /Terminal for/ });
    expect(terminal).toHaveTextContent(
      'running ["/bin/sh","-c","php artisan migrate | tail -n 5"] as root',
    );
    expect(within(drawer).getByRole('status')).toHaveTextContent(
      'Running php artisan migrate | tail -n 5 as root in toolbox',
    );
    await user.click(terminal);
    expect(within(drawer).getByText('The command has ended.')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Run it again' }));
    await user.click(within(drawer).getByRole('button', { name: 'Close the console' }));
    // The form keeps what was typed.
    expect(within(drawer).getByLabelText('Command')).toHaveValue('php artisan migrate | tail -n 5');
  });

  it('refuses a user name docker exec would not take', async () => {
    const { user, drawer } = await openContainer('toolbox');
    await user.click(within(drawer).getByRole('tab', { name: 'Console' }));
    await user.click(within(drawer).getByLabelText('User'));
    await user.type(screen.getByPlaceholderText('A user, or uid:gid'), 'not a user');
    await user.click(await screen.findByRole('option', { name: 'Run as not a user' }));
    expect(within(drawer).getByRole('alert')).toHaveTextContent(/not a user name or id/);
    expect(within(drawer).getByRole('button', { name: /Open a console/ })).toBeDisabled();
  });

  it('reads as many log lines as asked', async () => {
    const { user, bridge, drawer } = await openContainer('shop-api-1');
    await user.click(within(drawer).getByRole('tab', { name: 'Logs' }));
    await user.click(within(drawer).getByLabelText('Lines to read'));
    await user.click(await screen.findByRole('option', { name: 'Last 5,000 lines' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenLastCalledWith(
        expect.objectContaining({ tail: 5_000 }),
      ),
    );
  });

  it('cannot open a console in a stopped container', async () => {
    const { user, drawer } = await openContainer('migrate-once');
    await user.click(within(drawer).getByRole('tab', { name: 'Console' }));
    expect(within(drawer).getByText(/Start it to open a console/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /Start/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Started migrate-once.'));
  });

  it('asks for the name typed out before removing a container with its volumes (AC2)', async () => {
    const { user, bridge, drawer } = await openContainer('shop-db-1');
    await user.click(within(drawer).getByRole('button', { name: 'Actions for shop-db-1' }));
    await user.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove shop-db-1?' });
    await user.click(within(dialog).getByRole('checkbox'));
    const remove = within(dialog).getByRole('button', { name: 'Remove with its volumes' });
    expect(remove).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'shop-db');
    expect(remove).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), '-1');
    await user.click(remove);
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.remove')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        containerId: expect.any(String),
        removeVolumes: true,
        force: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Removed shop-db-1 and its volumes.');
  });

  it('removes without volumes for an Operator, and keeps the dialog when it fails', async () => {
    const { user, drawer } = await openContainer(
      'migrate-once',
      {
        'deployDocker.remove': () => Promise.reject(new Error('The engine said no.')),
      },
      ['operator'],
    );
    await user.click(within(drawer).getByRole('button', { name: 'Actions for migrate-once' }));
    await user.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove migrate-once?' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Remove the container' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The engine said no.'));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Remove migrate-once?' })).toBeNull(),
    );
  });

  it('offers the lifecycle that fits the state, and says when the details do not load', async () => {
    const paused = { ...seededDocker().require('toolbox').summary, state: 'paused' as const };
    const docker = seededDocker();
    const list = docker.list();
    for (const group of list.groups) {
      group.containers = group.containers.map((one) => (one.name === 'toolbox' ? paused : one));
    }
    const { user, bridge, drawer } = await openContainer('toolbox', {
      'deployDocker.listContainers': list,
      'deployDocker.inspect': () => Promise.reject(new Error('No such container: toolbox')),
    });
    expect(await within(drawer).findByRole('alert')).toHaveTextContent(
      'Could not read this container: No such container: toolbox',
    );
    await user.click(within(drawer).getByRole('button', { name: /Resume/ }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.act')).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'unpause' }),
      ),
    );
  });

  it('restarts and stops a running container from its panel, and closes', async () => {
    const { user, bridge, drawer } = await openContainer('shop-web-1');
    await user.click(within(drawer).getByRole('button', { name: /Restart/ }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.act')).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'restart' }),
      ),
    );
    await user.click(within(drawer).getByRole('button', { name: /^Stop$/ }));
    await waitFor(() => expect(bridge.$fn('deployDocker.act')).toHaveBeenCalledTimes(2));
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'shop-web-1' })).toBeNull());
  });

  it('opens the prompt for the project CLI from the panel and from the log', async () => {
    const { user, drawer } = await openContainer('shop-api-1');
    await user.click(within(drawer).getByRole('button', { name: /Send logs to the project CLI/ }));
    expect(
      await screen.findByRole('dialog', { name: /Which project runs shop-api-1/ }),
    ).toBeInTheDocument();
  });
});

describe('ContainerDrawer, Browse files (E27)', () => {
  it('opens the Files section on this container', async () => {
    const { user, drawer } = await openContainer('shop-api-1');
    await user.click(within(drawer).getByRole('button', { name: 'Browse files' }));
    expect(screen.getByTestId('path').textContent).toBe(
      '/deploy?server=srv-1&view=files&source=container&target=shop-api-1',
    );
  });

  it('is there for a stopped container too', async () => {
    const { drawer } = await openContainer('migrate-once');
    expect(within(drawer).getByRole('button', { name: 'Browse files' })).toBeEnabled();
  });

  it('is off below Admin, and says why', async () => {
    const { user, drawer } = await openContainer('shop-api-1', {}, ['operator']);
    const button = within(drawer).getByRole('button', { name: 'Browse files' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement as HTMLElement);
    expect(
      await screen.findByRole('tooltip', {
        name: 'Browsing files in a container is for Admins.',
      }),
    ).toBeTruthy();
  });
});
