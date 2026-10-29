import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { nginxStatus, site } from '../sites/testing/fixtures';
import type { AppsAccess } from './hooks';
import {
  appsBridge,
  JOB_ID,
  SERVER,
  STACK_ID,
  sampleDetails,
  sampleJob,
  sampleRevision,
  sampleStack,
} from './testing/fixtures';

/** One app's page: what runs, its revisions and rollback, its files, and what each role may do. */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { AppDetail } = await import('./AppDetail');

function access(roles: string[]): AppsAccess {
  const operator = roles.some((role) => ['owner', 'admin', 'operator'].includes(role));
  const admin = roles.some((role) => ['owner', 'admin'].includes(role));
  return { pending: false, signedIn: true, roles, canOperate: operator, canAdmin: admin };
}

function renderDetail(bridge: Record<string, unknown> = {}, roles = ['owner']) {
  const onBack = vi.fn();
  const onDeployAgain = vi.fn();
  const onDeleted = vi.fn();
  const onOpenWebsites = vi.fn();
  const view = renderWithProviders(
    <>
      <AppDetail
        serverId={SERVER.id}
        stackId={STACK_ID}
        access={access(roles)}
        onBack={onBack}
        onDeployAgain={onDeployAgain}
        onDeleted={onDeleted}
        onOpenWebsites={onOpenWebsites}
      />
      <ConfirmDialogHost />
    </>,
    { bridge: { ...appsBridge(roles), ...bridge } },
  );
  return { ...view, onBack, onDeployAgain, onDeleted, onOpenWebsites };
}

function finishJob(
  bridge: ReturnType<typeof renderDetail>['bridge'],
  state: 'succeeded' | 'failed',
  title: string,
  id = JOB_ID,
) {
  act(() =>
    bridge.$emit('deployJobs.onLog', {
      subscriptionId: 'log-1',
      serverId: SERVER.id,
      jobId: id,
      lines: [],
      job: sampleJob({
        id,
        title,
        state,
        error: state === 'failed' ? 'compose down failed' : undefined,
      }),
      ended: {},
    }),
  );
}

describe('AppDetail', () => {
  it('shimmers, then shows the app, its services, routes and the latest deploy', async () => {
    renderDetail();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByRole('heading', { name: 'shop' })).toBeInTheDocument();
    expect(screen.getByText(/Revision 2 live, 2 of 2 containers running/)).toBeInTheDocument();
    expect(
      screen.getByText(/From Shop, compose.yaml, with the Production environment/),
    ).toBeInTheDocument();
    const services = screen.getByRole('list', { name: 'Services' });
    expect(within(services).getByRole('listitem', { name: 'web' })).toHaveTextContent('shop-web-1');
    expect(within(services).getByRole('listitem', { name: 'web' })).toHaveTextContent(
      'Running, healthy',
    );
    expect(within(services).getByRole('listitem', { name: 'db' })).toHaveTextContent(
      'No containers.',
    );
    expect(screen.getByRole('list', { name: 'Routes' })).toHaveTextContent('127.0.0.1:8080');
    expect(screen.getByRole('region', { name: 'Deploy of revision 2' })).toBeInTheDocument();
  });

  it('says when the app did not load and tries again', async () => {
    let calls = 0;
    const { user, onBack } = renderDetail({
      'deployStacks.get': async () => {
        calls += 1;
        if (calls === 1) throw new Error('There is no such app.');
        return sampleDetails();
      },
    });
    expect(
      await screen.findByText(/The app did not load: There is no such app/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'shop' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All apps' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows an older revision and rolls back to it after a confirm', async () => {
    const { user, bridge } = renderDetail({ 'deployStacks.rollback': sampleJob({ id: 'job-r' }) });
    const revisions = await screen.findByRole('list', { name: 'Revisions' });
    expect(within(revisions).getByRole('listitem', { name: 'Revision 2' })).toHaveTextContent(
      'Live',
    );
    expect(
      within(within(revisions).getByRole('listitem', { name: 'Revision 2' })).queryByRole(
        'button',
        {
          name: /Roll back/,
        },
      ),
    ).toBeNull();
    await user.click(within(revisions).getByRole('button', { name: /#1/ }));
    expect(screen.getByRole('region', { name: 'Deploy of revision 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Roll back to this revision' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Roll shop back to revision 1?');
    await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.rollback')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        revision: 1,
      }),
    );
  });

  it('follows the revision a rollback made', async () => {
    let rolledBack = false;
    const { user } = renderDetail({
      'deployStacks.rollback': async () => {
        rolledBack = true;
        return sampleJob({ id: 'job-r' });
      },
      'deployStacks.get': async () =>
        rolledBack
          ? sampleDetails({
              stack: sampleStack({ status: 'busy', activeJobId: 'job-r' }),
              revisions: [
                sampleRevision({
                  number: 3,
                  state: 'deploying',
                  jobId: 'job-r',
                  rollbackOf: 1,
                  steps: [],
                }),
                ...sampleDetails().revisions,
              ],
            })
          : sampleDetails(),
    });
    const revisions = await screen.findByRole('list', { name: 'Revisions' });
    await user.click(within(revisions).getByRole('button', { name: 'Roll back to revision 1' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Roll back' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Deploy of revision 3' }, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/rollback of revision 1/)).toBeInTheDocument();
  });

  it('runs the lifecycle and shows the job, taking down only after a confirm', async () => {
    const { user, bridge } = renderDetail({
      'deployStacks.action': sampleJob({ kind: 'stackAction', title: 'Restart shop' }),
    });
    await screen.findByRole('heading', { name: 'shop' });
    const toolbar = screen.getByRole('toolbar', { name: 'App actions' });
    await user.click(within(toolbar).getByRole('button', { name: 'Restart' }));
    expect(bridge.$fn('deployStacks.action')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      stackId: STACK_ID,
      action: 'restart',
    });
    const dialog = await screen.findByRole('dialog', { name: 'Restart shop' });
    finishJob(bridge, 'failed', 'Restart shop');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Restart shop failed: compose down failed'),
    );
    // The dialog's corner button and its footer both close it.
    const [close] = within(dialog).getAllByRole('button', { name: 'Close' });
    await user.click(close);

    await user.click(within(toolbar).getByRole('button', { name: 'Take down' }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(bridge.$fn('deployStacks.action')).toHaveBeenCalledTimes(1);
  });

  it('says why a change was refused', async () => {
    const { user } = renderDetail({
      'deployStacks.action': () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'deployStacks:action': Error: [core:forbidden] Your role on this server (viewer) cannot do that.",
          ),
        ),
    });
    await screen.findByRole('heading', { name: 'shop' });
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Your role on this server (viewer) cannot do that.'),
    );
  });

  it('deletes after a confirm, and with its data only once the name is typed', async () => {
    const { user, bridge, onDeleted } = renderDetail({
      'deployStacks.delete': sampleJob({ kind: 'stackDelete', title: 'Delete shop' }),
    });
    await screen.findByRole('heading', { name: 'shop' });
    await user.click(screen.getByRole('button', { name: 'Delete with its data' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete shop and its data?');
    const confirm = within(dialog).getByRole('button', { name: 'Delete with its data' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'shop');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.delete')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        removeVolumes: true,
      }),
    );
    await screen.findByRole('dialog', { name: 'Delete shop' });
    finishJob(bridge, 'succeeded', 'Delete shop');
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Deleted shop.');
  });

  it('deletes without the data after a plain confirm', async () => {
    const { user, bridge } = renderDetail({
      'deployStacks.delete': sampleJob({ kind: 'stackDelete', title: 'Delete shop' }),
    });
    await screen.findByRole('heading', { name: 'shop' });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete the app' }));
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.delete')).toHaveBeenCalledWith(
        expect.objectContaining({ removeVolumes: false }),
      ),
    );
  });

  it('lets an Operator run the app but not delete its data', async () => {
    renderDetail({}, ['operator']);
    await screen.findByRole('heading', { name: 'shop' });
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete with its data' })).toBeDisabled();
  });

  it('lets a Viewer look and change nothing', async () => {
    renderDetail({}, ['viewer']);
    await screen.findByRole('heading', { name: 'shop' });
    for (const name of [
      'Deploy again',
      'Start',
      'Stop',
      'Restart',
      'Take down',
      'Delete',
      'Delete with its data',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Roll back to revision 1' })).toBeDisabled();
  });

  it('waits while a job works on the app', async () => {
    renderDetail({
      'deployStacks.get': sampleDetails({
        stack: sampleStack({ status: 'busy', activeJobId: 'job-x' }),
      }),
    });
    await screen.findByRole('heading', { name: 'shop' });
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('opens the wizard to deploy again from where the app came from', async () => {
    const { user, onDeployAgain } = renderDetail();
    await screen.findByRole('heading', { name: 'shop' });
    await user.click(screen.getByRole('button', { name: 'Deploy again' }));
    expect(onDeployAgain).toHaveBeenCalledWith(
      expect.objectContaining({ stack: expect.objectContaining({ id: STACK_ID }) }),
    );
  });

  it('cannot deploy again an app with no project on this computer', async () => {
    renderDetail({
      'deployStacks.get': sampleDetails({
        stack: sampleStack({ source: undefined }),
        services: [],
        revisions: [],
      }),
    });
    await screen.findByRole('heading', { name: 'shop' });
    expect(screen.getByRole('button', { name: 'Deploy again' })).toBeDisabled();
    expect(screen.getByText('Nothing runs yet. Deploy a revision first.')).toBeInTheDocument();
    expect(screen.getByText('No revisions yet.')).toBeInTheDocument();
    expect(screen.getByText('No service publishes a port.')).toBeInTheDocument();
  });

  it('shows the files of a revision with env keys only and the override', async () => {
    const { user, bridge } = renderDetail();
    await screen.findByRole('heading', { name: 'shop' });
    await user.click(screen.getByRole('button', { name: /Files of revision 2/ }));
    expect(await screen.findByLabelText('Compose file')).toHaveTextContent('image: nginx:1.29');
    expect(screen.getByRole('list', { name: 'Env keys' })).toHaveTextContent('DATABASE_URL');
    expect(screen.getByLabelText('Loopback override')).toHaveTextContent('!override');
    expect(bridge.$fn('deployStacks.files')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      stackId: STACK_ID,
      revision: 2,
    });
  });

  it('says when the files did not load', async () => {
    const { user } = renderDetail({
      'deployStacks.files': () => Promise.reject(new Error('gone')),
    });
    await screen.findByRole('heading', { name: 'shop' });
    await user.click(screen.getByRole('button', { name: /Files of revision 2/ }));
    expect(await screen.findByText('The files did not load: gone')).toBeInTheDocument();
  });

  describe('route map', () => {
    /** nginx managed, and one site on the web port next to one elsewhere. */
    const WEB = {
      'deploySites.status': nginxStatus(),
      'deploySites.list': [
        site(
          {},
          {
            id: 'shop',
            domains: ['shop.example.com'],
            upstream: {
              kind: 'servicePort',
              service: 'shop-web',
              port: 8080,
              verifyCertificate: true,
              sendUpstreamHost: false,
            },
          },
        ),
        site({}, { id: 'blog', domains: ['blog.example.com'] }),
      ],
    };

    function withPort(port: Record<string, unknown>) {
      const details = sampleDetails();
      return sampleDetails({
        services: details.services.map((service) =>
          service.name === 'web'
            ? { ...service, ports: [{ ...service.ports[0], ...port }] }
            : service,
        ),
      });
    }

    async function routeRow() {
      const routes = await screen.findByRole('list', { name: 'Routes' });
      return within(routes).getByRole('listitem', { name: /^web:80\// });
    }

    it('shows the domains that already forward to a port, and only those', async () => {
      renderDetail(WEB);
      const row = await routeRow();
      expect(await within(row).findByText('shop.example.com')).toBeInTheDocument();
      expect(row).not.toHaveTextContent('blog.example.com');
      expect(
        within(row).getByRole('button', { name: 'Add another domain for web:80' }),
      ).toBeEnabled();
    });

    it('matches a site that forwards to the port by its address too', async () => {
      renderDetail({
        ...WEB,
        'deploySites.list': [
          site(
            {},
            {
              id: 'api',
              domains: ['api.example.com'],
              upstream: {
                kind: 'url',
                address: 'http://127.0.0.1:8080',
                verifyCertificate: true,
                sendUpstreamHost: false,
              },
            },
          ),
        ],
      });
      const row = await routeRow();
      expect(await within(row).findByText('api.example.com')).toBeInTheDocument();
    });

    it('says when no domain leads to a port yet', async () => {
      renderDetail({ ...WEB, 'deploySites.list': [] });
      const row = await routeRow();
      expect(await within(row).findByText('No domain')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Add domain for web:80' })).toBeEnabled();
    });

    it('leaves adding a domain to Admins', async () => {
      renderDetail(WEB, ['operator']);
      const row = await routeRow();
      await within(row).findByText('shop.example.com');
      expect(within(row).getByRole('button', { name: /domain for web:80/ })).toBeDisabled();
    });

    it('cannot add a domain before nginx is managed under Websites', async () => {
      renderDetail({ ...WEB, 'deploySites.status': nginxStatus({ managed: false }) });
      const row = await routeRow();
      await within(row).findByText('shop.example.com');
      expect(within(row).getByRole('button', { name: /domain for web:80/ })).toBeDisabled();
    });

    it('cannot put a UDP port or one on another address behind a domain', async () => {
      const first = renderDetail({ ...WEB, 'deployStacks.get': withPort({ protocol: 'udp' }) });
      let row = await routeRow();
      await within(row).findByText('shop.example.com');
      expect(within(row).getByRole('button', { name: /domain for web:80/ })).toBeDisabled();
      first.unmount();

      renderDetail({ ...WEB, 'deployStacks.get': withPort({ hostIp: '10.0.0.5' }) });
      row = await routeRow();
      await within(row).findByText('shop.example.com');
      expect(within(row).getByRole('button', { name: /domain for web:80/ })).toBeDisabled();
    });

    it('puts a port on a domain: the site, nginx, the certificate, then shows the domain', async () => {
      let sites = [...WEB['deploySites.list']];
      const { user, bridge, onOpenWebsites } = renderDetail({
        ...WEB,
        'deploySites.list': async () => sites,
        'deploySites.save': async () => {
          sites = [
            ...sites,
            site(
              {},
              {
                id: 'www-example-com',
                domains: ['www.example.com'],
                upstream: {
                  kind: 'servicePort',
                  service: 'shop-web',
                  port: 8080,
                  verifyCertificate: true,
                  sendUpstreamHost: false,
                },
              },
            ),
          ];
          return { problems: [], site: sites[sites.length - 1] };
        },
        'deploySites.applyChanges': { applied: true, problems: [], warnings: [] },
        'deployCerts.issue': { id: 'job-cert' },
      });
      const row = await routeRow();
      await within(row).findByText('shop.example.com');
      await user.click(within(row).getByRole('button', { name: 'Add another domain for web:80' }));
      const dialog = await screen.findByRole('dialog', { name: 'Put web:80 on a domain' });
      await user.type(within(dialog).getByLabelText('Domain'), 'WWW.Example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Add the domain' }));

      expect(await within(dialog).findByText(/www\.example\.com is set up/)).toBeInTheDocument();
      expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith(
        SERVER.id,
        expect.objectContaining({
          id: 'www-example-com',
          domains: ['www.example.com'],
          upstream: expect.objectContaining({
            kind: 'servicePort',
            service: 'shop-web',
            port: 8080,
          }),
        }),
      );
      expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: SERVER.id, siteId: 'www-example-com' }),
      );
      expect(await within(row).findByText('www.example.com')).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Open in Websites' }));
      expect(onOpenWebsites).toHaveBeenCalled();
    });
  });
});
