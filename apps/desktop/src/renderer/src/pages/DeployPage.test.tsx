import type { CloudflareStatus } from '@shared/cloudflareTypes';
import type {
  DeployAccess,
  DeployCoreRecord,
  DeployHealth,
  DeployPreflight,
  DeployServer,
  DeploySetupProgressEvent,
} from '@shared/deployTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { AssistantTopBarButton } from '@/components/deploy/assistant/AssistantLauncher';
import { useFilesRunEvents } from '@/components/deploy/files/hooks';
import { fileSite, snapshot } from '@/components/deploy/files/testing/fixtures';
import { wpSite } from '@/components/deploy/wordpress/testing/fixtures';
import { useDeploySetupStore } from '@/stores/deploySetupStore';
import {
  dragItemDown,
  mockStackedRows,
  reorderIds,
  settleDragClick,
} from '../../../test/renderer/dragLayout';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The Deploy page: pick a saved server, see whether its core answers, and install or remove the
 * core without typing a command. Each state (loading, empty, failed, working) has to say what is
 * going on in words, and a sudo password is only asked for when nothing saved can stand in.
 */

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

// The add and edit dialog for FTP and SFTP sites has its own tests; here it only has to open with
// the right site and hand a saved one back.
const siteForm = vi.hoisted(() => ({
  saved: null as unknown,
  last: null as null | { site: unknown; initialProjectId?: string | null },
}));
vi.mock('@/components/deploy/files/SiteFormDialog', () => ({
  SiteFormDialog: (props: {
    open: boolean;
    site: { label: string } | null;
    initialProjectId?: string | null;
    onOpenChange: (open: boolean) => void;
    onSaved: (site: unknown) => void;
  }) => {
    siteForm.last = { site: props.site, initialProjectId: props.initialProjectId };
    if (!props.open) return null;
    return (
      <div
        role="dialog"
        aria-label={props.site ? `Edit ${props.site.label}` : 'Add an FTP or SFTP site'}
      >
        <button
          type="button"
          onClick={() => {
            props.onSaved(siteForm.saved);
            props.onOpenChange(false);
          }}
        >
          Save the site
        </button>
      </div>
    );
  },
}));

// A WordPress site's deploy review shows diffs; the real editor needs Monaco's web workers.
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  MonacoDiffEditor: () => null,
}));

const { default: DeployPage } = await import('./DeployPage');

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}`}</span>;
}

const CORE: DeployCoreRecord = {
  version: '1.53.0',
  release: '/opt/runova-core/releases/1.53.0-abababababab',
  transport: 'streamlocal',
  installedAt: Date.now() - 3 * 86_400_000,
  os: 'Ubuntu 24.04.1 LTS',
  architecture: 'x86_64',
};

const NO_CLOUDFLARE: CloudflareStatus = { configured: false, locked: false, accounts: [] };

function server(overrides: Partial<DeployServer> = {}): DeployServer {
  return {
    id: 'srv-1',
    nickname: 'Production',
    host: 'prod.example',
    port: 22,
    username: 'deployer',
    core: null,
    enrolled: false,
    ...overrides,
  };
}

const PREFLIGHT: DeployPreflight = {
  os: 'Ubuntu 24.04.1 LTS',
  supported: true,
  architecture: 'x86_64',
  architectureSupported: true,
  systemd: true,
  sudo: 'password',
  loginUser: 'deployer',
  hasSavedPassword: true,
  transport: 'streamlocal',
  selinux: 'absent',
  freeDiskMb: 19_531,
  serverDownload: false,
  installed: null,
  available: '1.53.0',
  problems: [],
};

const HEALTH: DeployHealth = {
  version: '1.53.0',
  apiVersion: 1,
  startedAtUnixMs: Date.now() - (2 * 60 + 5) * 60_000,
  checkedAt: Date.now(),
};

/** The owner a first install creates, typed into the account fields. */
const OWNER = { userName: 'maria', password: 'correct horse battery staple' };

async function fillOwner(user: ReturnType<typeof renderPage>['user']): Promise<void> {
  await user.type(await screen.findByLabelText('User name'), OWNER.userName);
  await user.type(screen.getByLabelText('Password'), OWNER.password);
  await user.type(screen.getByLabelText('Confirm the password'), OWNER.password);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The app shell's listener for FTP and SFTP runs, which the page itself no longer mounts. */
function FilesRunEvents(): null {
  useFilesRunEvents();
  return null;
}

/**
 * The settings the page reads and writes, kept between calls: the server ids chosen for Deploy.
 * `initial` is the choice itself, or a function that makes it on the first read.
 */
function chosenSettings(initial: string[] | (() => Promise<string[]>)) {
  let ids: string[] | null = Array.isArray(initial) ? initial : null;
  return {
    'settings.get': async () => {
      if (ids === null && typeof initial === 'function') ids = await initial();
      return { deployServerIds: ids };
    },
    'settings.update': async (updates: { deployServerIds?: string[] }) => {
      if (updates.deployServerIds) ids = updates.deployServerIds;
      return { deployServerIds: ids };
    },
  };
}

const notLoaded = () => Promise.reject(new Error('not loaded in this test'));

function renderPage(bridge: Record<string, unknown> = {}, route = '/deploy') {
  const listServers = (bridge['deploy.listServers'] ?? (async () => [server()])) as () => Promise<
    DeployServer[]
  >;
  return renderWithProviders(
    <>
      {/* The app shell's top bar, where the Deploy AI button lives. */}
      <AssistantTopBarButton />
      <FilesRunEvents />
      <DeployPage />
      <ConfirmDialogHost />
      <LocationProbe />
    </>,
    {
      route,
      bridge: {
        // Overview and Docker panels these tests are not about. They fail to load, the same
        // error state an empty answer leaves them in, without React Query logging about it.
        'deploySystem.info': notLoaded,
        'deploySystem.updates': notLoaded,
        'deployDocker.listContainers': notLoaded,
        'deployFirewall.exposure': notLoaded,
        'deploy.listServers': listServers,
        // Deploy lists only the servers the user chose. Unless a test says otherwise, they chose
        // every server it lists, as it lists them when the choice is read.
        ...chosenSettings(async () =>
          (await window.runova.deploy.listServers()).map((one) => one.id),
        ),
        'deploy.preflight': async () => PREFLIGHT,
        'deploy.health': async () => HEALTH,
        'deploy.access': async (): Promise<DeployAccess> => ({ state: 'not-enrolled' }),
        'ssh.vaultStatus': async () => ({ hasPasskey: false, unlocked: false }),
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  useDeploySetupStore.setState({ runs: {} });
  toast.success.mockClear();
  toast.warning.mockClear();
});

describe('DeployPage states', () => {
  it('shimmers while the servers load', () => {
    const { container } = renderPage({ 'deploy.listServers': () => new Promise(() => undefined) });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('points to Remote when there are no saved servers', async () => {
    renderPage({ 'deploy.listServers': async () => [] });

    expect(await screen.findByText('No servers yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open Remote/ })).toBeTruthy();
  });

  it('opens the Cloudflare page, with servers or without', async () => {
    const { user, unmount } = renderPage({
      'deploy.listServers': async () => [],
      'cloudflare.status': async () => NO_CLOUDFLARE,
    });
    await user.click(await screen.findByRole('button', { name: /Manage Cloudflare/ }));
    expect(await screen.findByRole('heading', { name: 'Cloudflare' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    const again = renderPage({ 'cloudflare.status': async () => NO_CLOUDFLARE });
    const rail = await screen.findByRole('navigation', { name: 'Servers' });
    await again.user.click(within(rail).getByRole('button', { name: /Cloudflare/ }));
    expect(await screen.findByRole('heading', { name: 'Cloudflare' })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: /Cloudflare/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('says why the list failed and offers to try again', async () => {
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => {
        throw new Error("Error invoking remote method 'deploy:listServers': Error: disk is gone");
      },
    });

    expect(await screen.findByText('disk is gone')).toBeTruthy();
    bridge.$set('deploy.listServers', async () => [server()]);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
  });

  it('shows a live health card for a server whose core answers', async () => {
    renderPage({ 'deploy.listServers': async () => [server({ core: CORE })] });

    expect(await screen.findByText('Online')).toBeTruthy();
    expect(screen.getByText('2 h 5 min')).toBeTruthy();
    expect(screen.getByText('Ubuntu 24.04.1 LTS')).toBeTruthy();
    const rail = screen.getByRole('navigation', { name: 'Servers' });
    expect(await within(rail).findByText('Online, core 1.53.0')).toBeTruthy();
  });

  it('scrolls the section strip in a narrow window instead of cutting sections off', async () => {
    renderPage({ 'deploy.listServers': async () => [server({ core: CORE })] });

    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    expect(sections.className).toContain('overflow-x-auto');
    for (const button of within(sections).getAllByRole('button')) {
      expect(button.className).toContain('whitespace-nowrap');
      expect(button.className).toContain('shrink-0');
    }
    expect(within(sections).getByRole('button', { name: 'Security' })).toBeTruthy();
  });

  it('says so, in words, when the core stops answering', async () => {
    renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deploy.health': async () => {
        throw new Error('The server core did not answer GET /api/v1/health in time.');
      },
    });

    const rail = await screen.findByRole('navigation', { name: 'Servers' });
    // The health card's status chip says it as well as the rail.
    await waitFor(() =>
      expect(
        screen.getAllByText('Not answering').filter((element) => !rail.contains(element)),
      ).toHaveLength(1),
    );
    expect(screen.getByText(/did not answer GET \/api\/v1\/health/)).toBeTruthy();
    expect(within(rail).getByText('Not answering')).toBeTruthy();
  });

  it('asks to unlock the saved servers when a passkey locks them', async () => {
    renderPage({ 'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: false }) });

    expect(await screen.findByText(/locked with a passkey/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
  });

  it('marks the DevHost and offers no install or removal for it', async () => {
    renderPage({
      'deploy.listServers': async () => [
        server({
          id: 'devhost',
          nickname: 'DevHost',
          dev: true,
          core: { ...CORE, transport: 'dev-tcp' },
        }),
      ],
    });

    expect(await screen.findByText('Development')).toBeTruthy();
    expect(await screen.findByText('Online')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});

describe('DeployPage install', () => {
  it('checks a server without a core on its own and lists what it found', async () => {
    renderPage();

    expect(await screen.findByText('Ubuntu 24.04.1 LTS')).toBeTruthy();
    expect(screen.getByText('sudo, with the saved login password')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Install core 1\.53\.0/ })).toBeTruthy();
  });

  it('installs with one click, shows each step, and says when it is done', async () => {
    const call = deferred<unknown>();
    const { user, bridge } = renderPage({ 'deploy.install': () => call.promise });

    const install = await screen.findByRole('button', { name: /Install core 1\.53\.0/ });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    await fillOwner(user);
    await user.click(install);

    expect(bridge.$fn('deploy.install')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: null,
      account: OWNER,
    });
    const emit = (progress: DeploySetupProgressEvent['progress']) =>
      bridge.$emit('deploy.onSetupProgress', { serverId: 'srv-1', progress });
    emit({ phase: 'preflight', title: 'Check the server', status: 'done' });
    emit({ phase: 'upload', title: 'Upload', status: 'running', percent: 42 });
    const steps = await screen.findByRole('list', { name: 'Install steps' });
    expect(within(steps).getByText('Check the server')).toBeTruthy();
    expect(await screen.findByRole('progressbar', { name: /42 percent/ })).toBeTruthy();

    bridge.$set('deploy.listServers', async () => [server({ core: CORE })]);
    call.resolve({
      version: '1.53.0',
      release: CORE.release,
      transport: 'streamlocal',
      previousVersion: null,
    });

    expect(await screen.findByText('Online')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Server core 1.53.0 is running on Production.');
  });

  it('asks for the sudo password when the login has none saved', async () => {
    const { user, bridge } = renderPage({
      'deploy.preflight': async () => ({ ...PREFLIGHT, hasSavedPassword: false }),
      'deploy.install': () => new Promise(() => undefined),
    });

    const install = await screen.findByRole('button', { name: /Install core/ });
    await fillOwner(user);
    expect((install as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Sudo password for deployer'), 's3cret');
    await user.click(install);

    expect(bridge.$fn('deploy.install')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: 's3cret',
      account: OWNER,
    });
  });

  it('asks again when the server turns the password down', async () => {
    const { user } = renderPage({
      'deploy.install': async () => {
        throw new Error(
          "Error invoking remote method 'deploy:install': Error: [ssh:sudo-password-rejected] prod.example did not accept the sudo password for deployer.",
        );
      },
    });

    await fillOwner(user);
    await user.click(await screen.findByRole('button', { name: /Install core/ }));

    expect(await screen.findByText('The server did not accept that password.')).toBeTruthy();
    expect(screen.getByLabelText('Sudo password for deployer')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });

  it('explains a failed install and keeps the core log out of the way', async () => {
    const { user } = renderPage({
      'deploy.install': async () => {
        throw new Error(
          'Server core 1.53.0 did not start. The server went back to 1.52.0.\n\nWhat the core logged:\nUnhandled exception. Boom.',
        );
      },
    });

    await fillOwner(user);
    await user.click(await screen.findByRole('button', { name: /Install core/ }));

    expect(
      await screen.findByText(/did not start\. The server went back to 1\.52\.0\./),
    ).toBeTruthy();
    expect(screen.getByText('What the core logged')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check the server again/ })).toBeTruthy();
  });

  it('can try a failed install again after the page was left and opened again', async () => {
    useDeploySetupStore.setState({
      runs: {
        'srv-1': {
          kind: 'install',
          planned: ['preflight', 'download'],
          events: [{ phase: 'download', title: 'Get', status: 'failed', detail: 'offline' }],
          status: 'failed',
          error: 'The server core download kept failing.',
          errorCode: null,
          result: null,
        },
      },
    });
    const { user, bridge } = renderPage({ 'deploy.install': () => new Promise(() => undefined) });

    // The account typed before went away with the page, so it is asked for again.
    const retry = await screen.findByRole('button', { name: /Try again/ });
    await fillOwner(user);
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    await user.click(retry);

    expect(bridge.$fn('deploy.install')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: null,
      account: OWNER,
    });
  });

  it('keeps Install off until the owner account follows the rules, and says which one', async () => {
    const { user } = renderPage();

    const install = await screen.findByRole('button', { name: /Install core 1\.53\.0/ });
    await user.type(screen.getByLabelText('User name'), 'maria');
    await user.type(screen.getByLabelText('Password'), 'short');

    expect(await screen.findByText('The password needs at least 12 characters.')).toBeTruthy();
    expect((install as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('Password'), ' but longer now');
    await user.type(screen.getByLabelText('Confirm the password'), 'something else entirely');
    expect(await screen.findByText('The two passwords differ.')).toBeTruthy();
    expect((install as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns, without failing the install, when access could not be set up', async () => {
    const { user } = renderPage({
      'deploy.install': async () => ({
        version: '1.53.0',
        release: CORE.release,
        transport: 'streamlocal',
        previousVersion: null,
        enrollmentError: 'The core refused the password: it is too common.',
      }),
    });

    await fillOwner(user);
    await user.click(await screen.findByRole('button', { name: /Install core 1\.53\.0/ }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Your access to Production is not set up yet: The core refused the password: it is too common. Set it up from the server card.',
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Server core 1.53.0 is running on Production.');
  });

  it('will not start an install the check says cannot work', async () => {
    renderPage({
      'deploy.preflight': async () => ({
        ...PREFLIGHT,
        supported: false,
        os: 'Alpine Linux v3.20',
        problems: ['Alpine Linux v3.20 is not supported.'],
      }),
    });

    expect(await screen.findByText('This server cannot take the core yet')).toBeTruthy();
    expect(screen.getByText('Alpine Linux v3.20 is not supported.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Install core/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('DeployPage checks and updates', () => {
  it('says why a check failed and checks again on request', async () => {
    let calls = 0;
    const { user } = renderPage({
      'deploy.preflight': async () => {
        calls += 1;
        if (calls === 1) throw new Error('Could not reach prod.example: connection refused');
        return PREFLIGHT;
      },
    });

    expect(await screen.findByText(/connection refused/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Check again/ }));

    expect(await screen.findByRole('button', { name: /Install core 1\.53\.0/ })).toBeTruthy();
  });

  it('takes a different sudo password even when one is saved', async () => {
    const { user, bridge } = renderPage({ 'deploy.install': () => new Promise(() => undefined) });

    await fillOwner(user);
    await user.click(await screen.findByRole('button', { name: 'Use a different password' }));
    await user.type(screen.getByLabelText('Sudo password for deployer'), 'other-pw');
    await user.keyboard('{Enter}');

    expect(bridge.$fn('deploy.install')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: 'other-pw',
      account: OWNER,
    });
  });

  it('offers an update from the health card and lets the user back out', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: { ...CORE, version: '1.52.0' } })],
      'deploy.preflight': async () => ({ ...PREFLIGHT, installed: { version: '1.52.0' } }),
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Update or reinstall over SSH/ }));

    expect(await screen.findByRole('button', { name: /Update to core 1\.53\.0/ })).toBeTruthy();
    expect(screen.getByText('Update or reinstall the server core')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Server core')).toBeTruthy();
  });

  it('lets an update join a core this computer is not on, or leave that for later', async () => {
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [server({ core: { ...CORE, version: '1.52.0' } })],
      'deploy.preflight': async () => ({ ...PREFLIGHT, installed: { version: '1.52.0' } }),
      'deploy.install': () => new Promise(() => undefined),
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Update or reinstall over SSH/ }));
    const update = await screen.findByRole('button', { name: /Update to core 1\.53\.0/ });
    expect(screen.getByText('Your account on this core')).toBeTruthy();
    expect(screen.queryByLabelText('Confirm the password')).toBeNull();
    expect((update as HTMLButtonElement).disabled).toBe(false);

    await user.click(update);

    expect(bridge.$fn('deploy.install')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: null,
    });
  });

  it('sends the account along when one is given during an update', async () => {
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [server({ core: { ...CORE, version: '1.52.0' } })],
      'deploy.preflight': async () => ({ ...PREFLIGHT, installed: { version: '1.52.0' } }),
      'deploy.install': () => new Promise(() => undefined),
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Update or reinstall over SSH/ }));
    const update = await screen.findByRole('button', { name: /Update to core 1\.53\.0/ });
    await user.type(screen.getByLabelText('User name'), OWNER.userName);
    expect((update as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Password'), OWNER.password);
    await user.click(update);

    expect(bridge.$fn('deploy.install')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: null,
      account: OWNER,
    });
  });

  it('asks for no account when this computer is already on the core', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [
        server({ core: { ...CORE, version: '1.52.0' }, enrolled: true }),
      ],
      'deploy.preflight': async () => ({ ...PREFLIGHT, installed: { version: '1.52.0' } }),
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Update or reinstall over SSH/ }));

    expect(await screen.findByRole('button', { name: /Update to core 1\.53\.0/ })).toBeTruthy();
    expect(screen.queryByLabelText('User name')).toBeNull();
  });

  it('asks the core again when "Check now" is pressed', async () => {
    let calls = 0;
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deploy.health': async () => {
        calls += 1;
        return { ...HEALTH, version: calls > 1 ? '1.53.1' : '1.53.0' };
      },
    });
    await screen.findByText('Online');

    await user.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('1.53.1')).toBeTruthy();
  });
});

describe('DeployPage core updates without SSH', () => {
  const OLDER = server({ core: { ...CORE, version: '1.52.0' }, enrolled: true });
  const updateBridge = (extra: Record<string, unknown> = {}) => ({
    'deploy.listServers': async () => [OLDER],
    'deploy.health': async () => ({ ...HEALTH, version: '1.52.0' }),
    'deploy.coreRelease': async () => ({ version: '1.53.0', serverDownload: true }),
    'deploy.stepUpSaved': async () => null,
    ...extra,
  });

  async function openUpdate(user: ReturnType<typeof renderPage>['user']): Promise<HTMLElement> {
    expect(await screen.findByText('Core 1.53.0 is available')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Update to 1.53.0' }));
    return screen.findByRole('button', { name: /Update to core 1\.53\.0/ });
  }

  it('offers a newer core on the health card and updates through the core', async () => {
    const call = deferred<unknown>();
    const { user, bridge } = renderPage(updateBridge({ 'deploy.updateCore': () => call.promise }));

    await user.click(await openUpdate(user));

    expect(bridge.$fn('deploy.updateCore')).toHaveBeenCalledWith({ serverId: 'srv-1' });
    const emit = (progress: DeploySetupProgressEvent['progress']) =>
      bridge.$emit('deploy.onSetupProgress', { serverId: 'srv-1', progress });
    emit({ phase: 'fetch', title: 'Download', status: 'done' });
    emit({ phase: 'switch', title: 'Switch', status: 'running' });
    const steps = await screen.findByRole('list', { name: 'Update steps' });
    expect(within(steps).getByText('Download the server core on the server')).toBeTruthy();
    expect(within(steps).getByText('Check that it answers')).toBeTruthy();

    call.resolve({
      outcome: 'updated',
      version: '1.53.0',
      previousVersion: '1.52.0',
      via: 'server-download',
    });

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Server core 1.53.0 is running on Production.'),
    );
    expect(await screen.findByText('Server core')).toBeTruthy();
  });

  it('asks for the password when the core wants a step-up, then tries again with it', async () => {
    let calls = 0;
    const { user, bridge } = renderPage(
      updateBridge({
        'deploy.updateCore': async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error(
              "Error invoking remote method 'deploy:updateCore': Error: [core:stepUpRequired] Confirm your password to update the core.",
            );
          }
          return new Promise(() => undefined);
        },
      }),
    );

    await user.click(await openUpdate(user));
    const dialog = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    await user.type(within(dialog).getByLabelText('Password'), OWNER.password);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(bridge.$fn('deploy.updateCore')).toHaveBeenLastCalledWith({
        serverId: 'srv-1',
        password: OWNER.password,
      }),
    );
  });

  it('hands a core that cannot update itself to the SSH installer', async () => {
    const { user } = renderPage(
      updateBridge({
        'deploy.updateCore': async () => ({
          outcome: 'needs-ssh',
          reason: 'This server runs an older core that cannot update itself.',
        }),
        'deploy.preflight': async () => ({ ...PREFLIGHT, installed: { version: '1.52.0' } }),
      }),
    );

    await user.click(await openUpdate(user));
    expect(
      await screen.findByText('This server runs an older core that cannot update itself.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Continue over SSH/ }));

    expect(await screen.findByText('Update or reinstall the server core')).toBeTruthy();
  });

  it('says why an update failed and offers to try again or use SSH', async () => {
    const { user } = renderPage(
      updateBridge({
        'deploy.updateCore': async () => {
          throw new Error('Server core 1.53.0 did not stay up, so the server went back to 1.52.0.');
        },
      }),
    );

    await user.click(await openUpdate(user));

    expect(await screen.findByText(/did not stay up/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Update over SSH instead/ })).toBeTruthy();
  });

  it('keeps quiet when the server already runs the newest core', async () => {
    renderPage(updateBridge({ 'deploy.health': async () => ({ ...HEALTH, version: '1.53.0' }) }));

    expect(await screen.findByText('latest')).toBeTruthy();
    expect(screen.queryByText(/is available/)).toBeNull();
  });
});

describe('DeployPage removal', () => {
  it('removes the core after a confirmation and keeps its data by default', async () => {
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deploy.uninstall': async () => undefined,
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /keep its data/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove the core' }));

    await waitFor(() =>
      expect(bridge.$fn('deploy.uninstall')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        keepData: true,
        sudoPassword: null,
      }),
    );
  });

  it('warns before removing the core together with its data', async () => {
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deploy.uninstall': async () => undefined,
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /and its data/ }));

    expect(await screen.findByText('Deleted data cannot be brought back.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove the core and its data' }));
    await waitFor(() =>
      expect(bridge.$fn('deploy.uninstall')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        keepData: false,
        sudoPassword: null,
      }),
    );
  });

  it('shows why a removal stopped and retries with the sudo password', async () => {
    let calls = 0;
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deploy.uninstall': async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            '[ssh:sudo-password-required] Running this as root on prod.example needs the sudo password for deployer.',
          );
        }
        return new Promise(() => undefined);
      },
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /keep its data/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove the core' }));

    expect(await screen.findByText('This server needs the sudo password to go on.')).toBeTruthy();
    const retry = screen.getByRole('button', { name: /Try again/ });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Sudo password for deployer'), 'pw');
    await user.click(retry);

    expect(bridge.$fn('deploy.uninstall')).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      keepData: true,
      sudoPassword: 'pw',
    });
    expect(screen.getByRole('list', { name: 'Removal steps' })).toBeTruthy();
  });

  it('goes back to the health card when a failed removal is dismissed', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deploy.uninstall': async () => {
        throw new Error('Stop the server core failed: Failed to stop runova-core.service');
      },
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /keep its data/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove the core' }));
    expect(await screen.findByText(/Failed to stop runova-core\.service/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByText('Online')).toBeTruthy();
  });
});

describe('DeployPage security', () => {
  it("opens the selected server's Security area, and goes back to the overview", async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
      'deploy.access': async (): Promise<DeployAccess> => ({
        state: 'signed-in',
        user: { userName: 'maria', roles: ['viewer'], twoFactorEnabled: false },
      }),
      'deploySecurity.listDevices': async () => [],
      'deploySecurity.listSessions': async () => [],
    });

    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    await user.click(within(sections).getByRole('button', { name: /Security/ }));

    expect(await screen.findByText('No computers are enrolled on this core.')).toBeTruthy();
    expect(
      within(sections)
        .getByRole('button', { name: /Security/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    await user.click(within(sections).getByRole('button', { name: 'Overview' }));
    expect(await screen.findByText('Online')).toBeTruthy();
  });

  it("opens the selected server's Websites section", async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
      'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
    });

    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    await user.click(within(sections).getByRole('button', { name: /Websites/ }));

    expect(await screen.findByText(/Sign in to see the websites on/)).toBeTruthy();
    expect(
      within(sections)
        .getByRole('button', { name: /Websites/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens the Security area straight from a link', async () => {
    renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
        'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
      },
      '/deploy?server=srv-1&view=security',
    );

    expect(await screen.findByText(/Sign in to see who can reach Production/)).toBeTruthy();
  });

  it('offers to join a core that already runs there with an enrollment code, no sudo needed', async () => {
    let joined = false;
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [
        joined ? server({ core: CORE, enrolled: true }) : server(),
      ],
      'deploy.preflight': async () => ({
        ...PREFLIGHT,
        sudo: null,
        installed: { version: '1.53.0' },
        problems: ['sudo is not installed on prod.example.'],
      }),
      'deploySecurity.redeemEnrollmentCode': async () => {
        joined = true;
        return { state: 'signed-in' };
      },
    });

    await user.click(await screen.findByRole('button', { name: /Join with a code/ }));
    await user.type(await screen.findByLabelText('Enrollment code'), 'K7Q2M-X9PLR');
    await user.type(screen.getByLabelText('User name'), 'sam');
    await user.type(screen.getByLabelText('Password'), 'another long passphrase');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByText('Online')).toBeTruthy();
    expect(bridge.$fn('deploySecurity.redeemEnrollmentCode')).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-1', userName: 'sam' }),
    );
  });

  it('offers no code path when this computer is already on the core', async () => {
    renderPage({
      'deploy.listServers': async () => [server({ enrolled: true })],
      'deploy.preflight': async () => ({ ...PREFLIGHT, installed: { version: '1.52.0' } }),
    });

    expect(await screen.findByRole('button', { name: /Update to core 1.53.0/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Join with a code/ })).toBeNull();
  });
});

describe('DeployPage containers', () => {
  it('opens the Containers section from the section bar and from a link', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
      'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
    });
    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    await user.click(within(sections).getByRole('button', { name: /Containers/ }));
    expect(await screen.findByText(/to see and manage its containers/)).toBeTruthy();
    expect(
      within(sections)
        .getByRole('button', { name: /Containers/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('DeployPage files', () => {
  it('opens the Files section from the section bar, on the server disk', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
      'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
      // No saved server of that id, so the file manager settles without a session.
      'ssh.listServers': [],
    });
    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    await user.click(within(sections).getByRole('button', { name: /Files/ }));
    expect(await screen.findByRole('combobox', { name: 'Source' })).toHaveTextContent(
      'Server disk',
    );
    expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-1&view=files');
    expect(
      within(sections).getByRole('button', { name: /Files/ }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens a container from a link, and asks to sign in first', async () => {
    renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
        'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
      },
      '/deploy?server=srv-1&view=files&source=container&target=shop-api-1',
    );
    expect(
      await screen.findByText(
        'Sign in to Production to browse the files in its containers and volumes.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Source' })).toHaveTextContent('Container');
  });
});

describe('DeployPage logs', () => {
  it('opens the Logs section on its problems feed', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE, enrolled: true })],
      'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
    });
    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    await user.click(within(sections).getByRole('button', { name: /Logs/ }));
    expect(await screen.findByRole('tab', { name: 'Problems' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Log viewer' })).toBeTruthy();
    expect(
      within(sections).getByRole('button', { name: /Logs/ }).getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('DeployPage WordPress sites', () => {
  const SITE = {
    id: 'site-1',
    label: 'Bakery',
    siteUrl: 'https://bakery.example',
    siteName: 'The Bakery',
    scope: 'write' as const,
    transport: 'https' as const,
    allowPlainHttp: false,
    hasHttpAuth: false,
    pluginVersion: '1.0.0',
    protocol: 1,
    connectedAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now() - 60_000,
  };

  it('offers a WordPress site, Remote and Cloudflare when there is nothing yet', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => [],
    });

    expect(await screen.findByText('No servers yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open Remote/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Manage Cloudflare/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download the plugin/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Connect a WordPress site/ }));
    expect(await screen.findByLabelText('Connection key')).toBeTruthy();
  });

  it('opens Remote and the Cloudflare page from the empty state', async () => {
    const { user, unmount } = renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => [],
    });
    await user.click(await screen.findByRole('button', { name: /Open Remote/ }));
    expect(screen.getByTestId('path').textContent).toBe('/remote');
    unmount();

    const again = renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => [],
      'cloudflare.status': async () => NO_CLOUDFLARE,
    });
    await again.user.click(await screen.findByRole('button', { name: /Manage Cloudflare/ }));
    expect(await screen.findByRole('heading', { name: 'Cloudflare' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?cloudflare=1');
    // With nothing else to show, the rail is still there to leave the page by.
    expect(screen.getByRole('navigation', { name: 'Servers' })).toBeTruthy();
  });

  it('opens the Cloudflare page from a server, and leaves it for another', async () => {
    const { user } = renderPage(
      {
        'deploy.listServers': async () => [server(), server({ id: 'srv-2', nickname: 'Staging' })],
        'cloudflare.status': async () => NO_CLOUDFLARE,
      },
      '/deploy?server=srv-2',
    );
    expect(await screen.findByRole('heading', { name: 'Staging' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Cloudflare: domains and DNS/ }));
    expect(await screen.findByRole('heading', { name: 'Cloudflare' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Staging' })).toBeNull();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?cloudflare=1');

    await user.click(screen.getByRole('button', { name: /Staging/ }));
    expect(await screen.findByRole('heading', { name: 'Staging' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Cloudflare' })).toBeNull();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-2');
  });

  it('says why the sites did not load when there are no servers, and tries again', async () => {
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => {
        throw new Error('disk is gone');
      },
      'deployWordPress.siteInfo': () => new Promise(() => undefined),
    });

    expect(await screen.findByText('disk is gone')).toBeTruthy();
    expect(screen.queryByText('No servers yet')).toBeNull();
    bridge.$set('deployWordPress.listSites', async () => [SITE]);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('heading', { name: 'Bakery' })).toBeTruthy();
  });

  it('shows the first site, with no empty state and no Deploy AI, when there are only sites', async () => {
    renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => [SITE],
      'deployWordPress.siteInfo': () => new Promise(() => undefined),
    });

    expect(await screen.findByRole('heading', { name: 'Bakery' })).toBeTruthy();
    expect(screen.queryByText('No servers yet')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Site sections' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Deploy AI/ })).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'Servers' });
    expect(within(rail).getByText('No servers shown.')).toBeTruthy();
  });

  it('keeps the first server selected when there are servers and sites', async () => {
    renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deployWordPress.listSites': async () => [SITE],
    });

    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    const sites = await screen.findByRole('list', { name: 'WordPress sites' });
    expect(within(sites).getByText('Bakery')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deploy AI/ })).toBeTruthy();
  });

  it('opens a site and its section from the address', async () => {
    renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE })],
        'deployWordPress.listSites': async () => [SITE],
        'deployWordPress.audit': async () => [],
      },
      '/deploy?site=site-1&view=access',
    );

    expect(await screen.findByRole('heading', { name: 'Bakery' })).toBeTruthy();
    const sections = screen.getByRole('navigation', { name: 'Site sections' });
    expect(
      within(sections)
        .getByRole('button', { name: /Access/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByText('Read and write key')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Production' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Deploy AI/ })).toBeNull();
  });

  it('switches between a server and a site from the rail', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deployWordPress.listSites': async () => [SITE],
      'deployWordPress.history': async () => [],
    });

    const sites = await screen.findByRole('list', { name: 'WordPress sites' });
    await user.click(within(sites).getByRole('button', { name: /Bakery/ }));
    expect(await screen.findByRole('heading', { name: 'Bakery' })).toBeTruthy();
    const sections = screen.getByRole('navigation', { name: 'Site sections' });
    await user.click(within(sections).getByRole('button', { name: /Deploys/ }));
    expect(await screen.findByText(/Nothing has been deployed to this site yet/)).toBeTruthy();

    const rail = screen.getByRole('navigation', { name: 'Servers' });
    await user.click(within(rail).getByRole('button', { name: /Production/ }));
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
  });

  it('shimmers instead of flashing a server while a linked site loads', () => {
    const { container } = renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE })],
        'deployWordPress.listSites': () => new Promise(() => undefined),
      },
      '/deploy?site=site-1',
    );

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Production' })).toBeNull();
  });

  it('asks to unlock the vault for a site too', async () => {
    renderPage(
      {
        'deploy.listServers': async () => [],
        'deployWordPress.listSites': async () => [SITE],
        'deployWordPress.siteInfo': async () => {
          throw new Error('[wp:vaultLocked] locked');
        },
        'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: false }),
      },
      '/deploy?site=site-1',
    );

    expect(await screen.findByText(/WordPress sites are locked with a passkey/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(await screen.findByText(/this site's key with them/)).toBeTruthy();
  });

  it('says why the sites did not load in the rail, and keeps the servers', async () => {
    renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deployWordPress.listSites': async () => {
        throw new Error('[wp:vaultLocked] locked');
      },
    });

    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    expect(await screen.findByText(/The WordPress sites did not load/)).toBeTruthy();
  });
});

describe('DeployPage FTP and SFTP sites', () => {
  const FILES = {
    'deployFiles.subscribe': snapshot(),
    'deployFiles.changes': snapshot(),
  };

  it('offers an FTP or SFTP site from the empty state and opens the new site once saved', async () => {
    siteForm.saved = fileSite({ id: 'fs-new', label: 'New static site' });
    const { user, bridge } = renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => [],
      'deployFiles.list': async () => [],
      ...FILES,
    });

    expect(await screen.findByText('No servers yet')).toBeTruthy();
    expect(screen.getByText(/any host that offers FTP or SFTP/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Add an FTP or SFTP site/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an FTP or SFTP site' });
    bridge.$set('deployFiles.list', async () => [siteForm.saved]);
    await user.click(within(dialog).getByRole('button', { name: 'Save the site' }));

    expect(await screen.findByRole('heading', { name: 'New static site' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-new');
  });

  it('shows the first FTP or SFTP site when there is nothing else', async () => {
    renderPage({
      'deploy.listServers': async () => [],
      'deployFiles.list': async () => [fileSite()],
      ...FILES,
    });

    expect(await screen.findByRole('heading', { name: 'Bakery static' })).toBeTruthy();
    expect(screen.queryByText('No servers yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /Deploy AI/ })).toBeNull();
    const list = screen.getByRole('list', { name: 'FTP and SFTP sites' });
    expect(within(list).getByRole('button').getAttribute('aria-current')).toBe('true');
  });

  it('opens a site and its section from the address, and keeps the section in it', async () => {
    const { user } = renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE })],
        'deployFiles.list': async () => [fileSite()],
        'deployFiles.history': async () => [],
        ...FILES,
      },
      '/deploy?files=fs-1&view=history',
    );

    expect(await screen.findByRole('heading', { name: 'Bakery static' })).toBeTruthy();
    expect(await screen.findByText('No deploys yet')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Production' })).toBeNull();
    const sections = screen.getByRole('navigation', { name: 'Site sections' });
    await user.click(within(sections).getByRole('button', { name: /Settings/ }));
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-1&view=settings');
    await user.click(within(sections).getByRole('button', { name: /Changes/ }));
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-1');
  });

  it('switches between a server and an FTP or SFTP site from the rail', async () => {
    const { user } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deployFiles.list': async () => [fileSite()],
      ...FILES,
    });

    const list = await screen.findByRole('list', { name: 'FTP and SFTP sites' });
    await user.click(within(list).getByRole('button', { name: /Bakery static/ }));
    expect(await screen.findByRole('heading', { name: 'Bakery static' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-1');

    const rail = screen.getByRole('navigation', { name: 'Servers' });
    await user.click(within(rail).getByRole('button', { name: /Production/ }));
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
  });

  it('shimmers instead of flashing a server while a linked FTP or SFTP site loads', () => {
    const { container } = renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE })],
        'deployFiles.list': () => new Promise(() => undefined),
      },
      '/deploy?files=fs-1',
    );
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Production' })).toBeNull();
  });

  it('adds a site from the rail with servers around, and edits one from its Settings', async () => {
    const second = fileSite({ id: 'fs-2', label: 'Second site' });
    siteForm.saved = second;
    const { user, bridge } = renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE })],
        'deployFiles.list': async () => [fileSite()],
        ...FILES,
      },
      '/deploy?files=fs-1&view=settings',
    );

    await user.click(await screen.findByRole('button', { name: /Add an FTP or SFTP site/ }));
    const add = await screen.findByRole('dialog', { name: 'Add an FTP or SFTP site' });
    expect(siteForm.last?.site).toBeNull();
    bridge.$set('deployFiles.list', async () => [fileSite(), second]);
    await user.click(within(add).getByRole('button', { name: 'Save the site' }));
    expect(await screen.findByRole('heading', { name: 'Second site' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-2'));

    const sections = screen.getByRole('navigation', { name: 'Site sections' });
    await user.click(within(sections).getByRole('button', { name: /Settings/ }));
    const connection = await screen.findByRole('region', { name: 'Connection' });
    await user.click(within(connection).getByRole('button', { name: /Edit/ }));
    const edit = await screen.findByRole('dialog', { name: 'Edit Second site' });
    expect((siteForm.last?.site as { id: string } | undefined)?.id).toBe('fs-2');
    const renamed = { ...second, label: 'Renamed' };
    siteForm.saved = renamed;
    bridge.$set('deployFiles.list', async () => [fileSite(), renamed]);
    await user.click(within(edit).getByRole('button', { name: 'Save the site' }));
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-2&view=settings');
  });

  it('leaves the site once it is removed', async () => {
    const { user, bridge } = renderPage(
      {
        'deploy.listServers': async () => [server({ core: CORE })],
        'deployFiles.list': async () => [fileSite()],
        ...FILES,
      },
      '/deploy?files=fs-1&view=settings',
    );
    await user.click(await screen.findByRole('button', { name: 'Remove site' }));
    bridge.$set('deployFiles.list', async () => []);
    const dialog = await screen.findByRole('dialog', { name: 'Remove Bakery static?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove site' }));
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/deploy'));
  });

  it('asks to unlock the vault for an FTP or SFTP site too', async () => {
    renderPage(
      {
        'deploy.listServers': async () => [],
        'deployFiles.list': async () => [fileSite()],
        'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: false }),
        ...FILES,
      },
      '/deploy?files=fs-1',
    );
    expect(await screen.findByText(/site logins are locked with a passkey/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
  });

  it('says why the FTP and SFTP sites did not load, in the rail or on their own', async () => {
    const failing = async () => {
      throw new Error('[files:vaultLocked] locked');
    };
    const { unmount } = renderPage({
      'deploy.listServers': async () => [server({ core: CORE })],
      'deployFiles.list': failing,
    });
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    expect(await screen.findByText(/The FTP and SFTP sites did not load/)).toBeTruthy();
    unmount();

    const again = renderPage({
      'deploy.listServers': async () => [],
      'deployWordPress.listSites': async () => [],
      'deployFiles.list': failing,
    });
    expect(
      await screen.findByText(/locked with a passkey, and this site's login with them/),
    ).toBeTruthy();
    again.bridge.$set('deployFiles.list', async () => [fileSite()]);
    again.bridge.$set('deployFiles.subscribe', snapshot());
    await again.user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('heading', { name: 'Bakery static' })).toBeTruthy();
  });

  it('takes a run that finishes while the page is open', async () => {
    const { bridge } = renderPage({
      'deploy.listServers': async () => [],
      'deployFiles.list': async () => [fileSite()],
      ...FILES,
    });
    await screen.findByRole('heading', { name: 'Bakery static' });
    bridge.$emit('deployFiles.onRunFinished', {
      runId: 'r1',
      siteId: 'fs-1',
      trigger: 'deployOnSave',
      state: 'done',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      uploaded: 1,
      deleted: 0,
      adopted: 0,
      skipped: 0,
      bytes: 10,
      failed: [],
      atomic: true,
      error: null,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Deployed Bakery static: 1 uploaded.'),
    );
    expect(await screen.findByRole('region', { name: 'Last deploy' })).toBeTruthy();
  });
});

describe('DeployPage chosen servers', () => {
  const SAVED = [
    server({ id: 'srv-1', nickname: 'Production' }),
    server({ id: 'srv-2', nickname: 'Staging' }),
    server({ id: 'srv-3', nickname: 'Backups' }),
  ];

  /** The page with three saved servers and `chosen` picked for Deploy. */
  function renderChosen(chosen: string[], bridge: Record<string, unknown> = {}, route = '/deploy') {
    return renderPage(
      { 'deploy.listServers': async () => SAVED, ...chosenSettings(chosen), ...bridge },
      route,
    );
  }

  beforeEach(() => mockStackedRows(40));
  afterEach(() => {
    vi.restoreAllMocks();
    settleDragClick();
  });

  it('lists only the servers that were chosen, in the order they were arranged', async () => {
    const { container } = renderChosen(['srv-3', 'srv-1']);

    const rail = await screen.findByRole('navigation', { name: 'Servers' });
    expect(reorderIds(container)).toEqual(['srv-3', 'srv-1']);
    expect(within(rail).queryByText('Staging')).toBeNull();
  });

  it('opens the first server that is shown, not the first one saved', async () => {
    renderChosen(['srv-3', 'srv-1']);

    expect(await screen.findByRole('heading', { name: 'Backups' })).toBeTruthy();
  });

  it('opens the first shown server when the address names one that is not shown', async () => {
    renderChosen(['srv-1'], {}, '/deploy?server=srv-2');

    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Staging' })).toBeNull();
  });

  it('leaves out a chosen server that is no longer saved', async () => {
    const { container } = renderChosen(['gone', 'srv-2']);

    await screen.findByRole('heading', { name: 'Staging' });
    expect(reorderIds(container)).toEqual(['srv-2']);
  });

  it('shimmers until the choice has loaded, even with the servers in', async () => {
    const choice = deferred<unknown>();
    const { container, bridge } = renderChosen(['srv-1'], { 'settings.get': () => choice.promise });

    await waitFor(() => expect(bridge.$fn('deploy.listServers')).toHaveBeenCalled());
    // Long enough for the servers to have come back.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Production' })).toBeNull();

    choice.resolve({ deployServerIds: ['srv-1'] });
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
  });

  it('says why the choice did not load and offers to try again', async () => {
    const { user, bridge } = renderChosen(['srv-1'], {
      'settings.get': async () => {
        throw new Error("Error invoking remote method 'settings:get': Error: disk is gone");
      },
    });

    expect(await screen.findByText('disk is gone')).toBeTruthy();
    bridge.$set('settings.get', async () => ({ deployServerIds: ['srv-1'] }));
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
  });

  describe('when none is chosen', () => {
    it('asks to choose servers, and says how many are saved', async () => {
      renderChosen([]);

      expect(await screen.findByText('No servers chosen yet')).toBeTruthy();
      expect(screen.getByText(/3 saved servers/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Choose servers to show/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Open Remote/ })).toBeNull();
      expect(screen.queryByRole('navigation', { name: 'Servers' })).toBeNull();
    });

    it('still points to Remote when no server is saved at all', async () => {
      renderChosen([], { 'deploy.listServers': async () => [] });

      expect(await screen.findByText('No servers yet')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Open Remote/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Choose servers to show/ })).toBeNull();
    });

    it('chooses servers from there and shows them at once', async () => {
      const { user, bridge, container } = renderChosen([]);

      await user.click(await screen.findByRole('button', { name: /Choose servers to show/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Choose servers to show' });
      await user.click(within(dialog).getByRole('checkbox', { name: /Staging/ }));
      await user.click(within(dialog).getByRole('checkbox', { name: /Backups/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
          deployServerIds: ['srv-2', 'srv-3'],
        }),
      );
      expect(await screen.findByRole('heading', { name: 'Staging' })).toBeTruthy();
      expect(reorderIds(container)).toEqual(['srv-2', 'srv-3']);
    });

    it('keeps the rail and its way to choose when a site is all there is to show', async () => {
      const { user } = renderChosen([], { 'deployWordPress.listSites': async () => [wpSite()] });

      expect(await screen.findByRole('heading', { name: 'Bakery' })).toBeTruthy();
      const rail = screen.getByRole('navigation', { name: 'Servers' });
      expect(within(rail).getByText('No servers shown.')).toBeTruthy();
      await user.click(within(rail).getByRole('button', { name: /Choose servers to show/ }));
      expect(await screen.findByRole('dialog', { name: 'Choose servers to show' })).toBeTruthy();
    });
  });

  describe('choosing from the rail', () => {
    it('adds a server after the ones shown and keeps the one being looked at', async () => {
      const { user, bridge, container } = renderChosen(['srv-2', 'srv-1']);

      await screen.findByRole('heading', { name: 'Staging' });
      const rail = screen.getByRole('navigation', { name: 'Servers' });
      await user.click(within(rail).getByRole('button', { name: /Choose servers to show/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Choose servers to show' });
      await user.click(within(dialog).getByRole('checkbox', { name: /Backups/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
          deployServerIds: ['srv-2', 'srv-1', 'srv-3'],
        }),
      );
      await waitFor(() => expect(reorderIds(container)).toEqual(['srv-2', 'srv-1', 'srv-3']));
      expect(screen.getByRole('heading', { name: 'Staging' })).toBeTruthy();
    });

    it('takes a server off the rail', async () => {
      const { user, bridge, container } = renderChosen(['srv-1', 'srv-2', 'srv-3']);

      await screen.findByRole('heading', { name: 'Production' });
      const rail = screen.getByRole('navigation', { name: 'Servers' });
      await user.click(within(rail).getByRole('button', { name: /Choose servers to show/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Choose servers to show' });
      await user.click(within(dialog).getByRole('checkbox', { name: /Staging/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
          deployServerIds: ['srv-1', 'srv-3'],
        }),
      );
      await waitFor(() => expect(reorderIds(container)).toEqual(['srv-1', 'srv-3']));
    });

    it('moves to the first shown server when the one open is taken off', async () => {
      const { user } = renderChosen(['srv-1', 'srv-2'], {}, '/deploy?server=srv-2');

      await screen.findByRole('heading', { name: 'Staging' });
      const rail = screen.getByRole('navigation', { name: 'Servers' });
      await user.click(within(rail).getByRole('button', { name: /Choose servers to show/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Choose servers to show' });
      await user.click(within(dialog).getByRole('checkbox', { name: /Staging/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    });
  });

  describe('ordering', () => {
    it('saves the new order when a server is dragged, and shows it at once', async () => {
      const { bridge, container } = renderChosen(['srv-1', 'srv-2', 'srv-3']);
      await screen.findByRole('heading', { name: 'Production' });

      dragItemDown(container, 'srv-1', 45);

      expect(reorderIds(container)).toEqual(['srv-2', 'srv-1', 'srv-3']);
      await waitFor(() =>
        expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
          deployServerIds: ['srv-2', 'srv-1', 'srv-3'],
        }),
      );
      expect(bridge.$fn('settings.update')).toHaveBeenCalledTimes(1);
    });

    it('keeps the server being looked at when the order changes', async () => {
      const { container } = renderChosen(['srv-1', 'srv-2', 'srv-3']);
      await screen.findByRole('heading', { name: 'Production' });

      dragItemDown(container, 'srv-1', 85);

      await waitFor(() => expect(reorderIds(container)).toEqual(['srv-2', 'srv-3', 'srv-1']));
      expect(screen.getByRole('heading', { name: 'Production' })).toBeTruthy();
      // With no server in the address, the page held on to the one it was showing.
      expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-1');
    });

    it('leaves the address alone when it already names the server', async () => {
      const { container } = renderChosen(['srv-1', 'srv-2', 'srv-3'], {}, '/deploy?server=srv-2');
      await screen.findByRole('heading', { name: 'Staging' });

      dragItemDown(container, 'srv-1', 45);

      await waitFor(() => expect(reorderIds(container)).toEqual(['srv-2', 'srv-1', 'srv-3']));
      expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-2');
      expect(screen.getByRole('heading', { name: 'Staging' })).toBeTruthy();
    });

    it('saves a move made with the keyboard', async () => {
      const { user, bridge } = renderChosen(['srv-1', 'srv-2', 'srv-3']);
      await screen.findByRole('heading', { name: 'Production' });
      const rail = screen.getByRole('navigation', { name: 'Servers' });

      within(rail)
        .getByRole('button', { name: /Backups/ })
        .focus();
      await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

      await waitFor(() =>
        expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
          deployServerIds: ['srv-1', 'srv-3', 'srv-2'],
        }),
      );
    });

    it('says so, and brings the saved order back, when saving the order fails', async () => {
      const { container } = renderChosen(['srv-1', 'srv-2', 'srv-3'], {
        'settings.update': async () => {
          throw new Error("Error invoking remote method 'settings:update': Error: disk is gone");
        },
      });
      await screen.findByRole('heading', { name: 'Production' });

      dragItemDown(container, 'srv-1', 45);

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('disk is gone')),
      );
      await waitFor(() => expect(reorderIds(container)).toEqual(['srv-1', 'srv-2', 'srv-3']));
    });
  });
});

describe('DeployPage coming back', () => {
  const SERVERS = [
    server({ id: 'srv-1', nickname: 'Production', core: CORE, enrolled: true }),
    server({ id: 'srv-2', nickname: 'Staging', core: CORE, enrolled: true }),
  ];
  const SIGNED_OUT = {
    'deploy.listServers': async () => SERVERS,
    'deploy.access': async (): Promise<DeployAccess> => ({ state: 'needs-sign-in' }),
  };

  /** Opens the page at `route`, then leaves it, the way going to another page does. */
  async function visit(route: string, heading: string, bridge: Record<string, unknown> = {}) {
    const { unmount } = renderPage({ ...SIGNED_OUT, ...bridge }, route);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    unmount();
  }

  it('opens the server and the section that were open when the page was left', async () => {
    await visit('/deploy?server=srv-2&view=logs', 'Staging');

    renderPage(SIGNED_OUT);
    expect(await screen.findByRole('heading', { name: 'Staging' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-2&view=logs'),
    );
    const sections = screen.getByRole('navigation', { name: 'Server sections' });
    expect(
      within(sections).getByRole('button', { name: /Logs/ }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByRole('heading', { name: 'Production' })).toBeNull();
  });

  it('remembers a section picked on the page, not only one from a link', async () => {
    const { user, unmount } = renderPage(SIGNED_OUT, '/deploy?server=srv-2');
    const sections = await screen.findByRole('navigation', { name: 'Server sections' });
    await user.click(within(sections).getByRole('button', { name: /Logs/ }));
    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-2&view=logs'),
    );
    unmount();

    renderPage(SIGNED_OUT);
    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-2&view=logs'),
    );
  });

  it('opens the tab that was open in the section', async () => {
    await visit('/deploy?server=srv-2&view=logs&tab=logs', 'Staging');

    renderPage(SIGNED_OUT);
    const viewer = await screen.findByRole('tab', { name: 'Log viewer' });
    expect(viewer.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the memory on this computer, for the next start', async () => {
    await visit('/deploy?server=srv-2&view=logs', 'Staging');

    expect(localStorage.getItem('runova-deploy-selection')).toContain('server=srv-2&view=logs');
  });

  it('opens the FTP or SFTP site that was open', async () => {
    await visit('/deploy?files=fs-1&view=settings', 'Bakery static', {
      'deployFiles.list': async () => [fileSite()],
      'deployFiles.subscribe': snapshot(),
      'deployFiles.changes': snapshot(),
    });

    renderPage({
      ...SIGNED_OUT,
      'deployFiles.list': async () => [fileSite()],
      'deployFiles.subscribe': snapshot(),
      'deployFiles.changes': snapshot(),
    });
    expect(await screen.findByRole('heading', { name: 'Bakery static' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-1&view=settings');
  });

  it('follows an address that names a server, not the memory', async () => {
    await visit('/deploy?server=srv-2&view=logs', 'Staging');

    renderPage(SIGNED_OUT, '/deploy?server=srv-1');
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy?server=srv-1');
  });

  it('opens the Cloudflare page that was open', async () => {
    await visit('/deploy?cloudflare=1', 'Cloudflare', {
      'cloudflare.status': async () => NO_CLOUDFLARE,
    });

    renderPage({ ...SIGNED_OUT, 'cloudflare.status': async () => NO_CLOUDFLARE });
    expect(await screen.findByRole('heading', { name: 'Cloudflare' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/deploy?cloudflare=1'),
    );
  });

  it('opens the Cloudflare page from an older dialog link, not what was open', async () => {
    await visit('/deploy?server=srv-2', 'Staging');

    renderPage(
      { ...SIGNED_OUT, 'cloudflare.status': async () => NO_CLOUDFLARE },
      '/deploy?dialog=cloudflare',
    );
    expect(await screen.findByRole('heading', { name: 'Cloudflare' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Staging' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not bring back a site that was removed', async () => {
    const { user, bridge, unmount } = renderPage(
      {
        ...SIGNED_OUT,
        'deployFiles.list': async () => [fileSite()],
        'deployFiles.subscribe': snapshot(),
        'deployFiles.changes': snapshot(),
      },
      '/deploy?files=fs-1&view=settings',
    );
    await user.click(await screen.findByRole('button', { name: 'Remove site' }));
    bridge.$set('deployFiles.list', async () => []);
    const dialog = await screen.findByRole('dialog', { name: 'Remove Bakery static?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove site' }));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/deploy'));
    unmount();

    renderPage({ ...SIGNED_OUT, 'deployFiles.list': async () => [] });
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/deploy');
  });

  it('falls back to the first server when the one remembered is gone', async () => {
    await visit('/deploy?server=srv-2&view=logs', 'Staging');

    renderPage({ ...SIGNED_OUT, 'deploy.listServers': async () => [SERVERS[0]] });
    expect(await screen.findByRole('heading', { name: 'Production' })).toBeTruthy();
  });
});
