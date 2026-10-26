import type {
  ContainerList,
  ContainerSummary,
  StackDetails,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import {
  STACK_ID,
  sampleDetails,
  sampleJob,
  sampleRevision,
  sampleStack,
} from '../apps/testing/fixtures';
import { SERVER, signedIn } from '../security/testing/fixtures';
import { EXPOSURE, PRESETS, status } from './testing/fixtures';

/**
 * "Make private" from the exposure view: a Runova app is redeployed after a confirmation and
 * followed until the new revision is live; a container Runova did not start gets the edit to
 * make instead; refusals and failures are said where the button is.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { FirewallPanel } = await import('./FirewallPanel');

beforeEach(() => {
  confirm.mockClear();
  confirm.mockImplementation(async () => true);
});

const container = (extra: Partial<ContainerSummary> = {}): ContainerSummary => ({
  id: '3f1c0a9e7b2d',
  name: 'shop-db-1',
  image: 'postgres:17',
  imageId: 'sha256:1',
  state: 'running',
  status: 'Up',
  health: 'none',
  createdAtUnixMs: 1,
  ports: [],
  composeProject: 'shop',
  composeService: 'db',
  ...extra,
});

const list = (summary: ContainerSummary): ContainerList =>
  ({ groups: [{ project: summary.composeProject, containers: [summary] }] }) as ContainerList;

const owning = (ids: string[], revisions = sampleDetails().revisions): StackDetails =>
  sampleDetails({
    revisions,
    services: [{ name: 'db', containers: ids.map((id) => container({ id })), ports: [] }],
  });

function renderPanel(overrides: Record<string, unknown> = {}, roles = ['operator']) {
  return renderWithProviders(<FirewallPanel server={SERVER} />, {
    bridge: {
      'deploy.access': async () => signedIn(roles),
      'deploy.connection': async () => ({ serverId: SERVER.id, state: 'online', since: 0 }),
      'deployFirewall.status': async () => status(),
      'deployFirewall.presets': async () => PRESETS,
      'deployFirewall.history': async () => [],
      'deployFirewall.exposure': async () => EXPOSURE,
      'deployDocker.listContainers': async () => list(container()),
      'deployStacks.list': async () => [sampleStack()],
      'deployStacks.get': async () => owning(['3f1c0a9e7b2d']),
      'deployStacks.makePrivate': async () => ({
        revision: sampleRevision({ number: 3, state: 'deploying' }),
        job: sampleJob(),
      }),
      ...overrides,
    },
    route: `/deploy?server=${SERVER.id}&view=firewall`,
  });
}

async function clickMakePrivate(user: ReturnType<typeof renderPanel>['user']) {
  const row = await screen.findByRole('listitem', { name: 'shop-db-1' });
  const button = within(row).getByRole('button', { name: 'Make private' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  await user.click(button);
  return row;
}

describe('Make private', () => {
  it('redeploys a Runova app with the service on loopback after asking', async () => {
    let live = false;
    const { user, bridge } = renderPanel({
      'deployStacks.get': async () =>
        owning(
          ['3f1c0a9e7b2d'],
          [sampleRevision({ number: 3, state: live ? 'live' : 'deploying' }), sampleRevision()],
        ),
    });
    const row = await clickMakePrivate(user);

    await waitFor(() => expect(bridge.$fn('deployStacks.makePrivate')).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Make db private?',
        description: expect.stringContaining('0.0.0.0:15432'),
        confirmLabel: 'Make private',
      }),
    );
    expect(bridge.$fn('deployStacks.makePrivate')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      stackId: STACK_ID,
      services: ['db'],
    });
    expect(await within(row).findByText(/Deploying shop again as revision 3/)).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Follow it in Apps' }));
    live = true;
    expect(
      await within(row).findByText(/Private now: revision 3 of shop is live/, undefined, {
        timeout: 5_000,
      }),
    ).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Put it on a domain in Websites' }));
  });

  it('does nothing when the question is turned down', async () => {
    confirm.mockImplementation(async () => false);
    const makePrivate = vi.fn();
    const { user } = renderPanel({ 'deployStacks.makePrivate': makePrivate });
    await clickMakePrivate(user);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(makePrivate).not.toHaveBeenCalled();
  });

  it('shows the compose change for a project Runova did not deploy, even one with an app name', async () => {
    const makePrivate = vi.fn();
    const { user } = renderPanel({
      'deployStacks.get': async () => owning(['someone-else']),
      'deployStacks.makePrivate': makePrivate,
    });
    await clickMakePrivate(user);
    const dialog = await screen.findByRole('dialog', {
      name: "shop-db-1 can't be changed from here",
    });
    expect(within(dialog).getByLabelText('Compose change').textContent).toBe(
      'services:\n  db:\n    ports:\n      - "127.0.0.1:15432:5432"',
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(makePrivate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Copy the change' }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain('127.0.0.1:15432:5432'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the docker run change for a container started on its own', async () => {
    const { user } = renderPanel({
      'deployDocker.listContainers': async () =>
        list(container({ composeProject: undefined, composeService: undefined })),
    });
    await clickMakePrivate(user);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Run change').textContent).toBe(
      'docker run -p 127.0.0.1:15432:5432 ... postgres:17',
    );
  });

  it('says why when the server refuses or nothing could be deployed', async () => {
    const refused = renderPanel({
      'deployStacks.makePrivate': async () => {
        throw new Error('db already publishes on 127.0.0.1 only in revision 2.');
      },
    });
    const row = await clickMakePrivate(refused.user);
    expect(await within(row).findByText(/already publishes on 127.0.0.1/)).toBeTruthy();
    refused.unmount();

    const invalid = renderPanel({
      'deployStacks.makePrivate': async () => ({
        revision: sampleRevision({ number: 3, state: 'invalid', error: 'Compose refused it.' }),
        job: null,
      }),
    });
    const second = await clickMakePrivate(invalid.user);
    expect(await within(second).findByText('Compose refused it.')).toBeTruthy();
    invalid.unmount();

    const lookup = renderPanel({
      'deployDocker.listContainers': async () => {
        throw new Error('Docker is not answering.');
      },
    });
    await clickMakePrivate(lookup.user);
    expect(await screen.findByText('Docker is not answering.')).toBeTruthy();
  });
});
