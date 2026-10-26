import type { AlertInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { dockerBridge, SERVER, seededDocker } from '../containers/testing/fixtures';
import { ProblemsFeed } from './ProblemsFeed';

/**
 * The problems feed on a server with a crash-looping container, a full disk and a container
 * published to the internet: each card says what is wrong in words, Diagnose with AI opens the
 * drawer on it, and Fix in project hands a container to its project's CLI.
 */

const DISK: AlertInfo = {
  id: 1,
  revision: 1,
  kind: 'diskPressure',
  severity: 'critical',
  resource: '/var',
  message: '/var is 96% full: 2 GB of 50 GB left.',
  firstSeenAtUnixMs: 0,
  lastSeenAtUnixMs: 0,
  occurrences: 1,
};

function bridge(extra: Record<string, unknown> = {}) {
  const docker = seededDocker();
  docker.setState('shop-worker-1', 'restarting', 'restart');
  return {
    ...dockerBridge(['admin']),
    'deployDocker.listContainers': docker.list(),
    'deployStacks.list': [],
    'deployCerts.list': [],
    'deployFirewall.exposure': {
      sockets: [],
      dockerAvailable: true,
      collectedAtUnixMs: 0,
      containers: [
        {
          containerId: 'grafana-id',
          containerName: 'monitoring-grafana-1',
          image: 'grafana',
          protocol: 'tcp',
          hostAddress: '0.0.0.0',
          hostPort: 3001,
          containerPort: 3000,
          scope: 'public',
          firewall: 'open',
        },
      ],
    },
    'deployAlerts.list': [DISK],
    'deployAlerts.watch': async () => 'alerts-1',
    'deployAlerts.unwatch': async () => true,
    ...extra,
  };
}

beforeEach(() => {
  useDeployAssistantStore.setState({ openServerId: null, draft: null, runs: {} });
});

describe('ProblemsFeed', () => {
  it('shimmers per card while its sources answer for the first time', async () => {
    const never = () => new Promise(() => undefined);
    renderWithProviders(<ProblemsFeed server={SERVER} />, {
      bridge: bridge({
        'deployDocker.listContainers': never,
        'deployStacks.list': never,
        'deployFirewall.exposure': never,
        'deployAlerts.list': never,
      }),
    });

    const list = await screen.findByRole('list', { name: 'Problems' });
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(within(list).queryByRole('listitem', { name: /keeps restarting/ })).toBeNull();
  });

  it('lists each problem with its severity in words, critical first', async () => {
    renderWithProviders(<ProblemsFeed server={SERVER} />, { bridge: bridge() });

    const list = await screen.findByRole('list', { name: 'Problems' });
    const crash = await within(list).findByRole('listitem', {
      name: 'shop-worker-1 keeps restarting',
    });
    expect(within(crash).getByText('Critical')).toBeInTheDocument();
    expect(within(crash).getByText('Crash loop')).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: '/var is filling up' })).toHaveTextContent(
      '/var is 96% full',
    );
    const exposed = within(list).getByRole('listitem', {
      name: 'monitoring-grafana-1 is reachable from the internet',
    });
    expect(within(exposed).getByText('Warning')).toBeInTheDocument();
    const names = within(list)
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('aria-label'));
    expect(names[0]).toBe('shop-worker-1 keeps restarting');
  });

  it('opens the Deploy AI on a problem with its container as context', async () => {
    const { user } = renderWithProviders(<ProblemsFeed server={SERVER} />, { bridge: bridge() });
    const crash = await screen.findByRole('listitem', { name: 'shop-worker-1 keeps restarting' });
    await user.click(within(crash).getByRole('button', { name: 'Diagnose with AI' }));

    const state = useDeployAssistantStore.getState();
    expect(state.openServerId).toBe(SERVER.id);
    expect(state.draft).toMatchObject({
      serverId: SERVER.id,
      prompt: expect.stringContaining('keeps restarting'),
      context: {
        title: 'Crash loop: shop-worker-1 keeps restarting',
        containerId: expect.any(String),
      },
    });
  });

  it('hands a container to its project for Fix in project, but not a disk', async () => {
    const { user } = renderWithProviders(<ProblemsFeed server={SERVER} />, { bridge: bridge() });
    const crash = await screen.findByRole('listitem', { name: 'shop-worker-1 keeps restarting' });
    expect(
      within(screen.getByRole('listitem', { name: '/var is filling up' })).queryByRole('button', {
        name: 'Fix in project',
      }),
    ).not.toBeInTheDocument();
    await user.click(within(crash).getByRole('button', { name: 'Fix in project' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Which project runs shop-worker-1?',
    );
  });

  it('says so when nothing needs attention', async () => {
    renderWithProviders(<ProblemsFeed server={SERVER} />, {
      bridge: bridge({
        'deployDocker.listContainers': seededDocker().list(),
        'deployFirewall.exposure': {
          sockets: [],
          containers: [],
          dockerAvailable: true,
          collectedAtUnixMs: 0,
        },
        'deployAlerts.list': [],
      }),
    });
    expect(await screen.findByText('Nothing needs attention right now.')).toBeInTheDocument();
  });
});
