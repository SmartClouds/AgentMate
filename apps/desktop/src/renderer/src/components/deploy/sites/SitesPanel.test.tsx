import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { job, nginxStatus, POSTGRES, SERVER, sitesBridge } from './testing/fixtures';

/**
 * The Websites section in the renderer: what each role sees of nginx, the sites as routes, the
 * stream proxies, installing nginx, and applying saved changes with problems sent to their field.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/editor/MonacoEditor', async () => ({
  MonacoEditor: (await import('./testing/monacoMocks')).FakeMonacoEditor,
}));
vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('./testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { SitesPanel } = await import('./SitesPanel');

function renderPanel(bridge: Record<string, unknown> = {}, roles?: string[]) {
  return renderWithProviders(
    <>
      <SitesPanel server={SERVER} />
      <ConfirmDialogHost />
    </>,
    { bridge: { ...sitesBridge(roles), ...bridge } },
  );
}

describe('SitesPanel states', () => {
  it('shimmers while it finds out who is signed in', () => {
    renderPanel({ 'deploy.access': () => new Promise(() => undefined) });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('asks for a sign-in first', async () => {
    renderPanel({ 'deploy.access': { state: 'needs-sign-in' } });
    expect(
      await screen.findByText(/Sign in to see the websites on Production/),
    ).toBeInTheDocument();
  });

  it('shimmers each card on its own while it loads', async () => {
    renderPanel({
      'deploySites.status': () => new Promise(() => undefined),
      'deploySites.list': () => new Promise(() => undefined),
      'deploySites.listStreams': () => new Promise(() => undefined),
    });
    await screen.findByText('Websites');
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(3);
  });

  it('says what went wrong for each card that could not load', async () => {
    renderPanel({
      'deploySites.status': () => Promise.reject(new Error('nginx status failed')),
      'deploySites.list': () => Promise.reject(new Error('sites failed')),
      'deploySites.listStreams': () => Promise.reject(new Error('streams failed')),
    });
    expect(await screen.findByText('nginx status failed')).toBeInTheDocument();
    expect(await screen.findByText('sites failed')).toBeInTheDocument();
    expect(await screen.findByText('streams failed')).toBeInTheDocument();
  });

  it('shows each site as a route with its lock, days left, chips and upstream', async () => {
    renderPanel();
    const sites = await screen.findByRole('list', { name: 'Sites' });
    const blog = within(sites).getByRole('listitem', { name: 'blog.example.com' });
    expect(within(blog).getByText('SSL, 60 days')).toBeInTheDocument();
    expect(within(blog).getByText('+1')).toBeInTheDocument();
    expect(within(blog).getByText('cache')).toBeInTheDocument();
    expect(within(blog).getByText('websocket')).toBeInTheDocument();
    expect(within(blog).getByText('web:3000')).toBeInTheDocument();
    expect(within(blog).getByText('Live')).toBeInTheDocument();
    const shop = within(sites).getByRole('listitem', { name: 'shop.example.com' });
    expect(within(shop).getByText('No SSL')).toBeInTheDocument();
    expect(within(shop).getByText('http://10.0.0.5:8080')).toBeInTheDocument();
    expect(within(shop).getByText('Not applied yet')).toBeInTheDocument();
    expect(screen.getByText('Managed by Runova')).toBeInTheDocument();
    expect(screen.getByText(/Last applied 1 hour ago by maria/)).toBeInTheDocument();
  });

  it('says there are no sites yet, or that nginx needs setting up first', async () => {
    renderPanel({ 'deploySites.list': [], 'deploySites.listStreams': [] });
    expect(await screen.findByText(/No sites yet/)).toBeInTheDocument();
    expect(screen.getByText('No TCP or UDP proxies.')).toBeInTheDocument();
  });
});

describe('SitesPanel nginx', () => {
  it('adopts the nginx that is there, with the job log open', async () => {
    const { bridge, user } = renderPanel({
      'deploySites.status': nginxStatus({
        managed: false,
        currentRelease: undefined,
        lastAppliedAtUnixMs: undefined,
      }),
      'deploySites.list': [],
      'deploySites.install': job('nginxInstall', 'Install nginx'),
    });
    expect(await screen.findByText(/Set up nginx above, then add a site/)).toBeInTheDocument();
    expect(screen.getByText(/backs up and turns off the stock default site/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a site/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Set up nginx for Runova' }));
    expect(bridge.$fn('deploySites.install')).toHaveBeenCalledWith(SERVER.id);
    expect(await screen.findByRole('dialog', { name: 'Install nginx' })).toBeInTheDocument();
  });

  it('opens the nginx install log again when the page comes back', async () => {
    const bridge = {
      'deploySites.status': nginxStatus({
        managed: false,
        currentRelease: undefined,
        lastAppliedAtUnixMs: undefined,
      }),
      'deploySites.list': [],
      'deploySites.install': job('nginxInstall', 'Install nginx'),
    };
    const first = renderPanel(bridge);
    await first.user.click(await screen.findByRole('button', { name: 'Set up nginx for Runova' }));
    expect(await screen.findByRole('dialog', { name: 'Install nginx' })).toBeInTheDocument();
    first.unmount();

    renderPanel(bridge);
    expect(await screen.findByRole('dialog', { name: 'Install nginx' })).toBeInTheDocument();
  });

  it('offers a fresh install when nginx is missing, and reports a refusal', async () => {
    const { user } = renderPanel({
      'deploySites.status': nginxStatus({
        installed: false,
        running: false,
        managed: false,
        streamSupported: false,
      }),
      'deploySites.install': () => Promise.reject(new Error('Another job is running.')),
    });
    expect(await screen.findByText('Not running')).toBeInTheDocument();
    expect(
      screen.getByText(/installs nginx from the official nginx.org packages/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install nginx' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Another job is running.'));
  });

  it('shows a Viewer everything and no buttons', async () => {
    renderPanel({ 'deploySites.status': nginxStatus({ managed: false, pendingChanges: true }) }, [
      'viewer',
    ]);
    expect(await screen.findByText(/An Admin can do this/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up nginx/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply changes/ })).toBeNull();
    expect(await screen.findAllByRole('button', { name: /^Edit|View/ })).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Add a proxy/ })).toBeNull();
  });

  it('says when nginx has no stream module', async () => {
    renderPanel({ 'deploySites.status': nginxStatus({ streamSupported: false }) });
    expect(await screen.findByText(/without the stream module/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a proxy/ })).toBeNull();
  });
});

describe('SitesPanel apply', () => {
  it('applies saved changes with a busy state and says when it is done', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { bridge, user } = renderPanel({
      'deploySites.status': nginxStatus({ pendingChanges: true }),
      'deploySites.applyChanges': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const bar = await screen.findByRole('region', { name: 'Apply changes' });
    expect(within(bar).getByText(/Saved changes are waiting/)).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: /Apply changes/ }));
    expect(within(bar).getByText(/This can take some 20 seconds/)).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-busy', 'true');
    bridge.$set('deploySites.status', nginxStatus({ pendingChanges: false, currentRelease: 4 }));
    await act(async () => finish({ applied: true, problems: [], warnings: [], release: 4 }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Applied. nginx runs release 4.'),
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Apply changes' })).toBeNull());
  });

  it('lists what nginx refused and opens the field each problem is about', async () => {
    const { user } = renderPanel({
      'deploySites.status': nginxStatus({ pendingChanges: true }),
      'deploySites.applyChanges': {
        applied: false,
        error: 'nginx -t failed.',
        warnings: ['a warning'],
        problems: [
          {
            field: 'sites[blog].locationSnippet',
            message: 'unknown directive "foo"',
            line: 2,
            siteId: 'blog',
          },
          { field: 'nginx', message: 'The test run timed out.' },
        ],
      },
    });
    await user.click(await screen.findByRole('button', { name: /Apply changes/ }));
    expect(
      await screen.findByText(/nginx kept running what it had. nginx -t failed./),
    ).toBeInTheDocument();
    expect(screen.getByText('The test run timed out.')).toBeInTheDocument();
    expect(screen.getByText('a warning')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /blog, line 2: unknown directive/ }));
    expect(
      await screen.findByRole('tab', { name: /Advanced/, selected: true }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Line 2: unknown directive "foo"')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Advanced, one problem/ })).toBeInTheDocument();
  });

  it('turns a failed call into the same message', async () => {
    const { user } = renderPanel({
      'deploySites.status': nginxStatus({ pendingChanges: true }),
      'deploySites.applyChanges': () => Promise.reject(new Error('The connection dropped.')),
    });
    await user.click(await screen.findByRole('button', { name: /Apply changes/ }));
    expect(
      await screen.findByText(/nginx kept running what it had. The connection dropped./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply again/ })).toBeInTheDocument();
  });
});

describe('SitesPanel editor and proxies', () => {
  it('opens a site from its route on the matching tab, and goes back', async () => {
    const { user } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /Upstream web:3000/ }));
    expect(await screen.findByRole('tab', { name: 'Proxy', selected: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /All sites/ }));
    await user.click(await screen.findByRole('button', { name: /^nginx: cache, websocket/ }));
    expect(
      await screen.findByRole('tab', { name: 'Performance', selected: true }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /All sites/ }));
    await user.click(await screen.findByRole('button', { name: /blog.example.com, SSL, 60 days/ }));
    expect(await screen.findByRole('tab', { name: 'SSL', selected: true })).toBeInTheDocument();
  });

  it('adds a site, then moves on to its SSL tab', async () => {
    const saved = { ...(sitesBridge()['deploySites.list'] as unknown[]) }[0];
    const { user, bridge } = renderPanel({
      'deploySites.save': async () => ({ problems: [], site: saved }),
    });
    await user.click(await screen.findByRole('button', { name: /Add a site/ }));
    await user.type(screen.getByRole('textbox', { name: 'Domain 1' }), 'blog.example.com');
    await user.type(screen.getByRole('tab', { name: 'Proxy' }), '{Enter}');
    await user.click(screen.getByRole('tab', { name: 'Proxy' }));
    await user.type(screen.getByLabelText('Port'), '3000');
    await user.click(screen.getByRole('button', { name: /Save the site/ }));
    expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith(
      SERVER.id,
      expect.objectContaining({ id: 'blog-example-com', domains: ['blog.example.com'] }),
    );
    expect(await screen.findByRole('tab', { name: 'SSL', selected: true })).toBeInTheDocument();
  });

  it('adds, edits and deletes a stream proxy', async () => {
    const { user, bridge } = renderPanel({
      'deploySites.saveStream': async () => ({ problems: [], proxy: POSTGRES }),
      'deploySites.removeStream': async () => undefined,
    });
    const proxies = await screen.findByRole('list', { name: 'Stream proxies' });
    const row = within(proxies).getByRole('listitem', { name: 'TCP 5432' });
    expect(within(row).getByText('1 allowed address')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Edit TCP 5432' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit postgres' });
    await user.click(within(dialog).getByRole('button', { name: /Save the proxy/ }));
    await waitFor(() => expect(bridge.$fn('deploySites.saveStream')).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Proxy saved. Apply to open the port.');

    await user.click(within(row).getByRole('button', { name: 'Delete TCP 5432' }));
    const confirm = await screen.findByRole('dialog', { name: /Delete the TCP proxy/ });
    await user.click(within(confirm).getByRole('button', { name: 'Delete the proxy' }));
    await waitFor(() =>
      expect(bridge.$fn('deploySites.removeStream')).toHaveBeenCalledWith(SERVER.id, 'postgres'),
    );
  });

  it('says so when a proxy could not be deleted', async () => {
    const { user } = renderPanel({
      'deploySites.removeStream': () => Promise.reject(new Error('Not allowed.')),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete TCP 5432' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: /Delete the TCP proxy/ })).getByRole(
        'button',
        {
          name: 'Delete the proxy',
        },
      ),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not allowed.'));
  });
});

describe('SitesPanel from Cloudflare', () => {
  it('starts a new site with the names just pointed at the server (E14)', async () => {
    renderWithProviders(<SitesPanel server={SERVER} />, {
      bridge: sitesBridge(),
      route: '/deploy?view=websites&newSite=app.example.com,www.app.example.com,bad%20name',
    });

    expect(await screen.findByDisplayValue('app.example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('www.app.example.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('bad name')).toBeNull();
    expect(screen.getByDisplayValue('app-example-com')).toBeInTheDocument();
  });
});
