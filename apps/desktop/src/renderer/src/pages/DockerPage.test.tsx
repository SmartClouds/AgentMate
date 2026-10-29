import type { DockerContainer } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The Docker page. Two things matter to a user here: that a machine without Docker says so
 * instead of showing an empty list, and that the row buttons really reach the docker CLI with
 * the right container id.
 */

// Toasts are how every action reports back (a failed stop, a removed container), so they are
// mocked to be assertable rather than rendered into a Toaster nobody looks at.
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { default: DockerPage } = await import('./DockerPage');

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: 'c1',
    name: 'container',
    image: 'alpine:latest',
    state: 'running',
    status: 'Up 2 hours',
    composeProject: null,
    cpuPercent: null,
    memUsedBytes: null,
    memLimitBytes: null,
    ...overrides,
  };
}

const web = container({
  id: 'web-id',
  name: 'web',
  image: 'nginx:1.27',
  state: 'exited',
  status: 'Exited (0) 3 days ago',
});
const api = container({
  id: 'api-id',
  name: 'api',
  image: 'node:22',
  status: 'Up 10 minutes',
  cpuPercent: 12.5,
  memUsedBytes: 256 * 1024 ** 2,
  memLimitBytes: 1024 ** 3,
});

/**
 * The number one of the three stat tiles is showing. A tile puts its label and its value in
 * sibling nodes, so the tile itself is the nearest ancestor whose text is the two joined, which
 * also keeps "Running" apart from the state badge of the same name on a row.
 */
function statValue(label: string): string {
  for (const node of screen.getAllByText(label)) {
    let element: HTMLElement | null = node.parentElement;
    while (element) {
      const match = (element.textContent ?? '').match(new RegExp(`^\\s*${label}\\s*(\\d+)\\s*$`));
      if (match) return match[1];
      element = element.parentElement;
    }
  }
  throw new Error(`No stat tile found for "${label}"`);
}

/** The page plus the app's shared confirmation modal, which stop and stop-all both go through. */
function renderPage(containers: DockerContainer[], extra: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <DockerPage />
      <ConfirmDialogHost />
    </>,
    {
      route: '/docker',
      bridge: {
        // A primitive answer is handed back as a plain property by the fake bridge, so anything
        // the page *calls* for a boolean has to be spelled as a function.
        'docker.availability': async () => true,
        'docker.list': containers,
        'docker.start': { ok: true },
        'docker.stop': { ok: true },
        'docker.restart': { ok: true },
        'docker.remove': { ok: true },
        ...extra,
      },
    },
  );
}

describe('DockerPage availability', () => {
  it('treats an availability check that gave no answer as an empty machine, not a crash', async () => {
    renderWithProviders(<DockerPage />, {
      route: '/docker',
      bridge: {
        'docker.availability': async () => {
          throw new Error('main process went away');
        },
      },
    });

    expect(await screen.findByText('No containers on this machine')).toBeTruthy();
    expect(screen.queryByText(/Docker isn't available/)).toBeNull();
  });

  it('explains that Docker is missing instead of showing an empty container list', async () => {
    renderWithProviders(<DockerPage />, {
      route: '/docker',
      bridge: { 'docker.availability': async () => false },
    });

    expect(await screen.findByText("Docker isn't available")).toBeTruthy();
    expect(screen.queryByText('No containers on this machine')).toBeNull();
    // Nothing should ask for a list on a machine that has no docker command.
    expect(screen.queryByLabelText('Search containers')).toBeNull();
  });

  it('keeps rendering when listing containers fails', async () => {
    renderWithProviders(<DockerPage />, {
      route: '/docker',
      bridge: {
        'docker.availability': async () => true,
        'docker.list': () => Promise.reject(new Error('docker daemon not responding')),
      },
    });

    // The failed list leaves the page on its empty state; the important part is that the
    // rejection does not take the whole page down.
    expect(await screen.findByText('No containers on this machine')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy();
  });
});

describe('DockerPage container list', () => {
  it('shows each container with its image, status and state, and counts them', async () => {
    renderPage([web, api]);

    expect(await screen.findByText('web')).toBeTruthy();
    expect(screen.getByText('nginx:1.27 · Exited (0) 3 days ago')).toBeTruthy();
    expect(screen.getByText('Exited')).toBeTruthy();

    expect(screen.getByText('api')).toBeTruthy();
    expect(screen.getByText('node:22 · Up 10 minutes')).toBeTruthy();
    // Which lifecycle button a row offers is how the state reads in practice: the running
    // container can be stopped, the exited one started.
    expect(screen.getByRole('button', { name: 'Stop api' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start web' })).toBeTruthy();
    // Live usage only shows for a running container, and only when docker stats came back.
    expect(screen.getByText('12.5%')).toBeTruthy();
    expect(screen.getByText('256 MB')).toBeTruthy();

    expect(statValue('Running')).toBe('1');
    expect(statValue('Stopped')).toBe('1');
    expect(statValue('Total')).toBe('2');
  });

  it('filters by name or image and says so when nothing matches', async () => {
    const { user } = renderPage([web, api]);
    await screen.findByText('web');

    const search = screen.getByLabelText('Search containers');
    await user.type(search, 'nginx');
    expect(screen.getByText('web')).toBeTruthy();
    expect(screen.queryByText('api')).toBeNull();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(await screen.findByText('No containers match "zzz".')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('api')).toBeTruthy();
  });

  it('groups containers started by compose under their project name', async () => {
    renderPage([
      container({ id: 'db-id', name: 'infra-db', composeProject: 'infra' }),
      container({ id: 'cache-id', name: 'infra-cache', composeProject: 'infra' }),
      web,
    ]);

    expect(await screen.findByText('infra-db')).toBeTruthy();
    expect(screen.getByText('infra-cache')).toBeTruthy();

    // The project gets a heading of its own (the name also repeats as a badge on every row in
    // it), and the Stop all shortcut belongs to that heading, not to the loose containers.
    const heading = screen.getByText('infra', { selector: 'p' });
    const headingRow = heading.parentElement;
    if (!headingRow) throw new Error('The compose heading has no row around it');
    expect(within(headingRow).getByRole('button', { name: /Stop all/ })).toBeTruthy();
    // `web` was not started by compose, so it sits outside the group, in a card of its own.
    expect(screen.getByText('web')).toBeTruthy();
    const others = screen.getByRole('region', { name: 'Other containers' });
    expect(within(others).getByText('web')).toBeTruthy();
    expect(within(others).queryByText('infra-db')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'infra' })).getByText('infra-db'),
    ).toBeTruthy();
  });

  it('tells the user when a container reached by a deep link is gone', async () => {
    // `/docker?container=<id>` is the link the status bar's Docker popover opens. A container
    // that has since been removed must say so rather than silently scrolling nowhere.
    renderWithProviders(<DockerPage />, {
      route: '/docker?container=ghost-id',
      bridge: { 'docker.availability': async () => true, 'docker.list': [web] },
    });

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('That container is no longer listed.'),
    );
    expect(screen.getByText('web')).toBeTruthy();
  });
});

describe('DockerPage actions', () => {
  it('starts a stopped container through the docker bridge', async () => {
    const { user, bridge } = renderPage([web]);
    await screen.findByText('web');

    await user.click(screen.getByRole('button', { name: 'Start web' }));

    await waitFor(() => expect(bridge.$fn('docker.start')).toHaveBeenCalledWith('web-id'));
  });

  it('restarts a container through the docker bridge', async () => {
    const { user, bridge } = renderPage([api]);
    await screen.findByText('api');

    await user.click(screen.getByRole('button', { name: 'Restart api' }));

    await waitFor(() => expect(bridge.$fn('docker.restart')).toHaveBeenCalledWith('api-id'));
  });

  it('asks before stopping a running container, then stops it', async () => {
    const { user, bridge } = renderPage([api]);
    await screen.findByText('api');

    await user.click(screen.getByRole('button', { name: 'Stop api' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Stop api?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(bridge.$fn('docker.stop')).toHaveBeenCalledWith('api-id'));
  });

  it('leaves the container alone when the stop confirmation is cancelled', async () => {
    const { user, bridge } = renderPage([api]);
    await screen.findByText('api');

    await user.click(screen.getByRole('button', { name: 'Stop api' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Nothing was ever sent, so the mock behind the path does not even exist yet.
    expect(() => bridge.$fn('docker.stop')).toThrow();
  });

  it('stops every running container in a compose project at once', async () => {
    const { user, bridge } = renderPage([
      container({ id: 'db-id', name: 'infra-db', composeProject: 'infra' }),
      container({ id: 'cache-id', name: 'infra-cache', composeProject: 'infra' }),
      container({ id: 'old-id', name: 'infra-old', composeProject: 'infra', state: 'exited' }),
    ]);
    await screen.findByText('infra-db');

    await user.click(screen.getByRole('button', { name: /Stop all/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Stop all 2 containers in infra?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stop all' }));

    await waitFor(() => expect(bridge.$fn('docker.stop')).toHaveBeenCalledTimes(2));
    expect(bridge.$fn('docker.stop')).toHaveBeenCalledWith('db-id');
    expect(bridge.$fn('docker.stop')).toHaveBeenCalledWith('cache-id');
    // The already-exited container is left out of both the count and the calls.
    expect(bridge.$fn('docker.stop')).not.toHaveBeenCalledWith('old-id');
    expect(toast.success).toHaveBeenCalledWith('Stopped 2 containers.');
  });

  it('reports the docker error when an action fails', async () => {
    const { user } = renderPage([web], {
      'docker.start': { ok: false, error: 'port is already allocated' },
    });
    await screen.findByText('web');

    await user.click(screen.getByRole('button', { name: 'Start web' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('port is already allocated'));
  });

  it('passes the extra removal choices the dialog collected', async () => {
    const { user, bridge } = renderPage([api]);
    await screen.findByText('api');

    await user.click(screen.getByRole('button', { name: 'Remove api' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove api?')).toBeTruthy();

    await user.click(within(dialog).getByRole('checkbox', { name: /Also remove the image/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove container' }));

    await waitFor(() =>
      expect(bridge.$fn('docker.remove')).toHaveBeenCalledWith('api-id', {
        removeVolumes: false,
        removeImage: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Container removed.');
  });

  it('keeps the remove dialog open and explains why when removal fails', async () => {
    const { user } = renderPage([api], {
      'docker.remove': { ok: false, error: 'container is paused' },
    });
    await screen.findByText('api');

    await user.click(screen.getByRole('button', { name: 'Remove api' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove container' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('container is paused'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('DockerPage views', () => {
  const nginxImage = {
    id: 'sha256:aaaaaaaaaaaa01',
    tags: ['nginx:1.27'],
    dangling: false,
    createdAt: null,
    createdSince: '2 weeks ago',
    sizeBytes: 1024 ** 2,
    containers: 1,
  };

  function renderAt(route: string) {
    return renderWithProviders(<DockerPage />, {
      route,
      bridge: {
        'docker.availability': async () => true,
        'docker.list': [web],
        'docker.listImages': [nginxImage],
        'dockerHub.status': { state: 'signedOut', username: null },
      },
    });
  }

  it('opens on the containers, and switches to the images on this machine', async () => {
    const { user } = renderAt('/docker');
    await screen.findByText('web');
    const views = screen.getByRole('navigation', { name: 'Docker views' });

    await user.click(within(views).getByRole('button', { name: 'Images' }));

    expect(await screen.findByRole('listitem', { name: 'nginx:1.27' })).toBeInTheDocument();
    expect(screen.queryByText('web')).not.toBeInTheDocument();
    expect(within(views).getByRole('button', { name: 'Images' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('switches the images between this machine and Docker Hub', async () => {
    const { user } = renderAt('/docker?view=images');
    await screen.findByRole('listitem', { name: 'nginx:1.27' });
    const source = screen.getByRole('group', { name: 'Image source' });

    await user.click(within(source).getByRole('button', { name: 'Docker Hub' }));

    expect(
      await screen.findByRole('button', { name: 'Sign in to Docker Hub' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'nginx:1.27' })).not.toBeInTheDocument();
  });

  it('opens straight on Docker Hub from its link', async () => {
    renderAt('/docker?view=hub');

    expect(
      await screen.findByRole('button', { name: 'Sign in to Docker Hub' }),
    ).toBeInTheDocument();
  });

  it('brings a container deep link back to the containers view', async () => {
    renderAt('/docker?view=images&container=web-id');

    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'nginx:1.27' })).not.toBeInTheDocument();
  });

  it('shows no views at all when Docker is missing', async () => {
    renderWithProviders(<DockerPage />, {
      route: '/docker?view=images',
      bridge: { 'docker.availability': async () => false },
    });

    expect(await screen.findByText("Docker isn't available")).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Docker views' })).not.toBeInTheDocument();
  });
});

describe('DockerPage logs', () => {
  it("opens a container's log from its row and closes it again", async () => {
    const logs = vi.fn().mockResolvedValue([
      {
        stream: 'stdout',
        timestamp: '2024-05-01T10:00:00.000000000Z',
        atUnixMs: Date.parse('2024-05-01T10:00:00.000Z'),
        text: 'server started',
      },
    ]);
    const { user } = renderPage([web, api], { 'docker.logs': logs });

    await user.click(await screen.findByRole('button', { name: 'Show logs of api' }));

    const dialog = await screen.findByRole('dialog', { name: 'api' });
    expect(await within(dialog).findByText('server started')).toBeInTheDocument();
    expect(logs).toHaveBeenCalledWith('api-id', { tail: 500 });

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
