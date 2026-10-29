import { sampleJob } from '@shared/deploy/testing/fakeCoreData';
import { sampleDockerStatus } from '@shared/deploy/testing/fakeDockerData';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { connection } from '../overview/testing/fixtures';
import { dockerBridge, SERVER, statsBatch, T0 } from './testing/fixtures';

/**
 * The Containers section in the renderer: shimmer, sign-in, failure and install states, the
 * grouped list with live figures, what each role may do, and the lists read again on events.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { ContainersPanel } = await import('./ContainersPanel');
const { useConnectionUpdates } = await import('../overview/hooks');

function Harness() {
  useConnectionUpdates();
  return (
    <>
      <ContainersPanel server={SERVER} />
      <ConfirmDialogHost />
    </>
  );
}

function renderPanel(bridge: Record<string, unknown> = {}, roles?: string[]) {
  return renderWithProviders(<Harness />, { bridge: { ...dockerBridge(roles), ...bridge } });
}

describe('ContainersPanel states', () => {
  it('shimmers while it finds out whether this computer is signed in', () => {
    renderPanel({ 'deploy.access': () => new Promise(() => undefined) });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('asks for a sign-in first', async () => {
    renderPanel({ 'deploy.access': { state: 'needs-sign-in' } });
    expect(await screen.findByText(/Sign in to Production on its Overview/)).toBeInTheDocument();
  });

  it('says when Docker cannot be asked about, and tries again', async () => {
    let calls = 0;
    const { user } = renderPanel({
      'deployDocker.status': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The server core is not answering (503).');
        return sampleDockerStatus();
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('not answering');
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('list', { name: 'Containers' })).toBeInTheDocument();
  });

  it('says when the containers do not list', async () => {
    renderPanel({
      'deployDocker.listContainers': () => Promise.reject(new Error('Docker went away.')),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not list the containers: Docker went away.',
    );
  });

  it('shows an empty server as an invitation', async () => {
    renderPanel({ 'deployDocker.listContainers': { groups: [] } });
    expect(await screen.findByText(/No containers on this server yet/)).toBeInTheDocument();
  });
});

describe('ContainersPanel install', () => {
  it('lists what is in the way and waits for agreement before installing (T1)', async () => {
    const job = sampleJob({ kind: 'dockerInstall', title: 'Install Docker' });
    const { user, bridge } = renderPanel({
      'deployDocker.status': sampleDockerStatus({
        installed: false,
        running: false,
        conflictingPackages: ['podman', 'buildah', 'runc'],
      }),
      'deployDocker.install': async () => job,
    });
    const card = await screen.findByRole('region', { name: 'Docker' });
    expect(within(card).getByRole('list', { name: 'Packages in the way' })).toHaveTextContent(
      'podman',
    );
    const install = within(card).getByRole('button', { name: /Install Docker/ });
    expect(install).toBeDisabled();
    await user.click(within(card).getByRole('checkbox'));
    await user.click(install);
    expect(bridge.$fn('deployDocker.install')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      removeConflictingPackages: true,
    });
    expect(await screen.findByRole('dialog')).toHaveTextContent('Install Docker');
  });

  it('opens the install log again when the page comes back to it', async () => {
    const job = sampleJob({ kind: 'dockerInstall', title: 'Install Docker' });
    const bridge = {
      'deployDocker.status': sampleDockerStatus({ installed: false, running: false }),
      'deployDocker.install': async () => job,
    };
    const first = renderPanel(bridge);
    const card = await screen.findByRole('region', { name: 'Docker' });
    await first.user.click(within(card).getByRole('button', { name: /Install Docker/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Install Docker');
    first.unmount();

    renderPanel(bridge);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Install Docker');
  });

  it('says what went wrong when the install is refused', async () => {
    const { user } = renderPanel({
      'deployDocker.status': sampleDockerStatus({ installed: false, running: false }),
      'deployDocker.install': () =>
        Promise.reject(new Error('[core:forbidden] Your role cannot do that.')),
    });
    await user.click(await screen.findByRole('button', { name: /Install Docker/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role cannot do that.');
  });

  it('leaves the install to Admins', async () => {
    renderPanel(
      { 'deployDocker.status': sampleDockerStatus({ installed: false, running: false }) },
      ['operator'],
    );
    expect(
      await screen.findByText('Ask an Admin of this server to install Docker.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install Docker/ })).toBeNull();
  });

  it('offers to start a Docker that is installed but stopped', async () => {
    const job = sampleJob({ kind: 'serviceRestart', title: 'Restart Docker' });
    const { user, bridge } = renderPanel({
      'deployDocker.status': sampleDockerStatus({ running: false }),
      'deploySystem.restartService': async () => job,
    });
    await user.click(await screen.findByRole('button', { name: /Start Docker/ }));
    expect(bridge.$fn('deploySystem.restartService')).toHaveBeenCalledWith(SERVER.id, 'docker');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Restart Docker');
  });
});

describe('ContainersPanel list', () => {
  it('groups containers by project, says each state in words, and shows live figures', async () => {
    const { bridge } = renderPanel();
    const list = await screen.findByRole('list', { name: 'Containers' });
    expect(within(list).getByRole('heading', { name: 'shop' })).toBeInTheDocument();
    expect(within(list).getByRole('heading', { name: 'monitoring' })).toBeInTheDocument();
    expect(within(list).getByText('Not in a compose project')).toBeInTheDocument();
    const migrate = within(list).getByRole('listitem', { name: 'migrate-once' });
    expect(within(migrate).getByText('Exited')).toBeInTheDocument();
    expect(screen.getByLabelText('Docker version')).toHaveTextContent(
      'Docker 29.1.3, Compose 2.39.4, cgroup v2',
    );

    await waitFor(() => expect(bridge.$listenerCount('deployDocker.onStats')).toBe(1));
    act(() =>
      bridge.$emit('deployDocker.onStats', {
        subscriptionId: 'stats-1',
        serverId: SERVER.id,
        batches: [statsBatch(T0, 0), statsBatch(T0 + 2_000, 1)],
      }),
    );
    const api = within(list).getByRole('listitem', { name: 'shop-api-1' });
    expect(within(api).getByLabelText('Processor for shop-api-1')).toHaveTextContent('%');
    expect(within(api).getByLabelText('Memory for shop-api-1')).toHaveTextContent('MB');
    expect(within(migrate).getByLabelText('Processor for migrate-once')).toHaveTextContent('–');

    act(() =>
      bridge.$emit('deployDocker.onStats', {
        subscriptionId: 'stats-1',
        serverId: SERVER.id,
        batches: [],
        error: 'Docker is not running on this server.',
      }),
    );
    expect(screen.getByText(/Live figures are not coming in right now/)).toBeInTheDocument();
  });

  it('finds containers and folds projects', async () => {
    const { user } = renderPanel();
    const list = await screen.findByRole('list', { name: 'Containers' });
    await user.type(screen.getByRole('textbox', { name: 'Find a container' }), 'grafana');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await user.clear(screen.getByRole('textbox', { name: 'Find a container' }));
    await user.click(within(list).getByRole('button', { name: /^shop, / }));
    expect(within(list).queryByRole('listitem', { name: 'shop-api-1' })).toBeNull();
  });

  it('reads the list again a moment after engine events', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridge } = renderPanel();
      await screen.findByRole('list', { name: 'Containers' });
      await waitFor(() => expect(bridge.$listenerCount('deployDocker.onEvents')).toBe(1));
      act(() =>
        bridge.$emit('deployDocker.onEvents', {
          subscriptionId: 'events-1',
          serverId: SERVER.id,
          events: [
            { type: 'container', action: 'die', actorId: 'abc', atUnixMs: T0, cursor: '1' },
            { type: 'image', action: 'pull', actorId: 'img', atUnixMs: T0, cursor: '2' },
            { type: 'volume', action: 'create', actorId: 'vol', atUnixMs: T0, cursor: '3' },
            { type: 'network', action: 'create', actorId: 'net', atUnixMs: T0, cursor: '4' },
          ],
        }),
      );
      await act(() => vi.advanceTimersByTimeAsync(400));
      await waitFor(() =>
        expect(bridge.$fn('deployDocker.listContainers')).toHaveBeenCalledTimes(2),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('dims the list while reconnecting and reads it again once the connection is back', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('list', { name: 'Containers' });
    await waitFor(() => expect(bridge.$fn('deploy.connection')).toHaveBeenCalled());
    act(() => bridge.$emit('deploy.onConnection', connection('reconnecting')));
    // The version line sits in the toolbar card now; the whole panel, toolbar and list, dims.
    await waitFor(() =>
      expect(
        screen.getByRole('list', { name: 'Containers' }).closest('.opacity-60'),
      ).not.toBeNull(),
    );
    expect(screen.getByLabelText('Docker version').closest('.opacity-60')).not.toBeNull();
    act(() => bridge.$emit('deploy.onConnection', connection('online')));
    await waitFor(() => expect(bridge.$fn('deployDocker.listContainers')).toHaveBeenCalledTimes(2));
  });

  it('runs the lifecycle from a row and asks before a kill', async () => {
    const { user, bridge } = renderPanel();
    const list = await screen.findByRole('list', { name: 'Containers' });
    await user.click(within(list).getByRole('button', { name: 'Actions for toolbox' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Stop' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.act')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        containerId: expect.any(String),
        action: 'stop',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Stopped toolbox.');

    await user.click(within(list).getByRole('button', { name: 'Actions for shop-web-1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Kill' }));
    const confirm = await screen.findByRole('dialog', { name: 'Kill shop-web-1?' });
    await user.click(within(confirm).getByRole('button', { name: 'Kill' }));
    await waitFor(() => expect(bridge.$fn('deployDocker.act')).toHaveBeenCalledTimes(2));
  });

  it('says why an action was refused', async () => {
    const { user } = renderPanel({
      'deployDocker.act': () => Promise.reject(new Error('No such container: toolbox')),
    });
    const list = await screen.findByRole('list', { name: 'Containers' });
    await user.click(within(list).getByRole('button', { name: 'Actions for toolbox' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restart' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No such container: toolbox'));
  });

  it('lets a Viewer look at everything and change nothing', async () => {
    renderPanel({}, ['viewer']);
    const list = await screen.findByRole('list', { name: 'Containers' });
    expect(within(list).queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });
});
