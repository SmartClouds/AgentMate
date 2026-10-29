import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { rememberedEnvFiles, useDeployAppEnvFilesStore } from '@/stores/deployAppEnvFilesStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { AppsAccess } from './hooks';
import {
  appsBridge,
  JOB_ID,
  SERVER,
  STACK_ID,
  sampleDetails,
  sampleJob,
  samplePreview,
  sampleRevision,
  sampleStack,
  uploadResult,
} from './testing/fixtures';

/** The New App wizard step by step, and every way its deploy can go. */

const { NewAppWizard } = await import('./NewAppWizard');

const OWNER: AppsAccess = {
  pending: false,
  signedIn: true,
  roles: ['owner'],
  canOperate: true,
  canAdmin: true,
};

function renderWizard(
  bridge: Record<string, unknown> = {},
  options: { existing?: ReturnType<typeof sampleDetails>; access?: AppsAccess } = {},
) {
  const onCancel = vi.fn();
  const onOpenApp = vi.fn();
  const view = renderWithProviders(
    <NewAppWizard
      serverId={SERVER.id}
      access={options.access ?? OWNER}
      existing={options.existing}
      onCancel={onCancel}
      onOpenApp={onOpenApp}
    />,
    { bridge: { ...appsBridge(), 'deployStacks.list': [], ...bridge } },
  );
  return { ...view, onCancel, onOpenApp };
}

async function pickProject(user: ReturnType<typeof renderWizard>['user']) {
  await user.click(await screen.findByRole('combobox', { name: 'Project' }));
  await user.click(await screen.findByRole('option', { name: 'Shop' }));
}

async function pickSource(user: ReturnType<typeof renderWizard>['user']) {
  await pickProject(user);
  await user.click(await screen.findByRole('radio', { name: /compose\.yaml/ }));
  const environment = screen.getByRole('combobox', { name: 'Environment' });
  await waitFor(() => expect(environment).toBeEnabled());
  await user.click(environment);
  await user.click(await screen.findByRole('option', { name: 'Production' }));
}

async function toReview(user: ReturnType<typeof renderWizard>['user']) {
  await pickSource(user);
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByRole('list', { name: 'Services to deploy' });
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByRole('list', { name: 'Exposure' });
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByRole('list', { name: 'Findings to accept' });
}

describe('NewAppWizard source', () => {
  it('lists the projects, their compose files and environments, and suggests a name', async () => {
    const { user } = renderWizard();
    const steps = screen.getByRole('list', { name: 'New app steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(5);
    expect(within(steps).getByRole('listitem', { current: 'step' })).toHaveTextContent('Source');
    const next = screen.getByRole('button', { name: /Next/ });
    expect(next).toBeDisabled();
    await pickSource(user);
    expect(screen.getByLabelText('App name')).toHaveValue('shop');
    expect(screen.getByRole('radio', { name: /docker-compose\.broken\.yml/ })).toBeDisabled();
    expect(screen.getByText('The compose file is not valid YAML.')).toBeInTheDocument();
    expect(next).toBeEnabled();
  });

  it('refuses a name the server would not take, or one already in use', async () => {
    const { user } = renderWizard({ 'deployStacks.list': [sampleStack()] });
    await pickSource(user);
    const name = screen.getByLabelText('App name');
    await user.clear(name);
    await user.type(name, 'Shop');
    expect(screen.getByText(/Use lowercase letters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'shop');
    expect(
      await screen.findByText(/An app called shop is already on this server/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('says when a project has no compose file, or its files could not be listed', async () => {
    const { user } = renderWizard({
      'deployStacks.discover': {
        projectId: 'proj-1',
        projectName: 'Shop',
        files: [],
        truncated: false,
      },
    });
    await pickProject(user);
    expect(await screen.findByText(/This project has no compose.yaml/)).toBeInTheDocument();
  });

  it('offers to try listing the compose files again', async () => {
    let calls = 0;
    const { user } = renderWizard({
      'deployStacks.discover': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The folder is gone.');
        return {
          projectId: 'proj-1',
          projectName: 'Shop',
          files: [{ path: 'compose.yaml', services: 1 }],
          truncated: true,
        };
      },
    });
    await pickProject(user);
    expect(await screen.findByText(/could not be listed: The folder is gone/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 service')).toBeInTheDocument();
    expect(screen.getByText(/The project is large/)).toBeInTheDocument();
  });
});

describe('NewAppWizard env files', () => {
  async function pickEnvironment(user: ReturnType<typeof renderWizard>['user'], name: string) {
    const environment = screen.getByRole('combobox', { name: 'Environment' });
    await waitFor(() => expect(environment).toBeEnabled());
    await user.click(environment);
    await user.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }));
  }

  async function pickStaging(user: ReturnType<typeof renderWizard>['user']) {
    await pickProject(user);
    await user.click(await screen.findByRole('radio', { name: /compose\.yaml/ }));
    await pickEnvironment(user, 'Staging');
  }

  const files = () => screen.getByRole('list', { name: 'Env files' });
  const box = (name: string) => within(files()).getByRole('checkbox', { name });
  const lastPreview = (bridge: ReturnType<typeof renderWizard>['bridge']) =>
    bridge.$fn('deployStacks.preview').mock.calls.at(-1)?.[0];

  it('lists every file of the environment, all ticked, with their key counts', async () => {
    const { user } = renderWizard();
    await pickStaging(user);
    for (const name of ['.env', '.env.staging', '.env.local']) {
      expect(box(name)).toBeChecked();
    }
    expect(within(files()).getByText('5 keys')).toBeInTheDocument();
    expect(within(files()).getByText('1 key')).toBeInTheDocument();
    expect(screen.getByText('3 of 3 files')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use all' })).not.toBeInTheDocument();
    expect(screen.getByText(/A later file wins when a key repeats/)).toBeInTheDocument();
  });

  it('previews with the ticked files in the environment order, and all again from Use all', async () => {
    const { user, bridge } = renderWizard();
    await pickStaging(user);
    await user.click(box('.env'));
    expect(box('.env')).not.toBeChecked();
    expect(screen.getByText('2 of 3 files')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    expect(bridge.$fn('deployStacks.preview')).toHaveBeenCalledWith({
      projectId: 'proj-1',
      composePath: 'compose.yaml',
      environmentId: 'env-2',
      envFileIds: ['s2', 's3'],
    });

    await user.click(screen.getByRole('button', { name: /Back/ }));
    await user.click(box('.env.local'));
    await user.click(box('.env'));
    expect(screen.getByText('2 of 3 files')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use all' }));
    expect(screen.getByText('3 of 3 files')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    expect(lastPreview(bridge)).toEqual({
      projectId: 'proj-1',
      composePath: 'compose.yaml',
      environmentId: 'env-2',
      proxiedServices: ['web'],
    });
  });

  it('says the single ticked file applies alone, without the order note', async () => {
    const { user } = renderWizard();
    await pickStaging(user);
    await user.click(box('.env'));
    await user.click(box('.env.local'));
    expect(screen.getByText('1 of 3 files')).toBeInTheDocument();
    expect(screen.queryByText(/A later file wins/)).not.toBeInTheDocument();
  });

  it('will not go on with no file ticked', async () => {
    const { user } = renderWizard();
    await pickStaging(user);
    for (const name of ['.env', '.env.staging', '.env.local']) await user.click(box(name));
    expect(screen.getByText('Tick at least one file, or pick No environment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    await pickEnvironment(user, 'No environment');
    expect(screen.queryByRole('list', { name: 'Env files' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
  });

  it('says when the environment has no files yet', async () => {
    const { user } = renderWizard();
    await pickProject(user);
    await user.click(await screen.findByRole('radio', { name: /compose\.yaml/ }));
    await pickEnvironment(user, 'Preview');
    expect(screen.getByText(/This environment has no files yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Env files' })).not.toBeInTheDocument();
  });

  it('starts from every file again when another environment or project is picked', async () => {
    const { user } = renderWizard();
    await pickStaging(user);
    await user.click(box('.env'));
    await pickEnvironment(user, 'Production');
    expect(box('.env.production')).toBeChecked();
    await pickEnvironment(user, 'Staging');
    expect(box('.env')).toBeChecked();
    expect(screen.getByText('3 of 3 files')).toBeInTheDocument();

    await user.click(box('.env'));
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Blog' }));
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Shop' }));
    await user.click(await screen.findByRole('radio', { name: /compose\.yaml/ }));
    await pickEnvironment(user, 'Staging');
    expect(screen.getByText('3 of 3 files')).toBeInTheDocument();
  });

  it('deploys with the ticked files and remembers them for the app', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.create': uploadResult(),
      'deployStacks.deploy': sampleJob(),
    });
    await pickStaging(user);
    await user.click(box('.env.local'));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Exposure' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(
      await screen.findByRole('checkbox', { name: 'I accept: db runs privileged.' }),
    );
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'env-2', envFileIds: ['s1', 's2'] }),
      ),
    );
    expect(rememberedEnvFiles(SERVER.id, STACK_ID, 'env-2')).toEqual(['s1', 's2']);
  });

  it('deploys an app again from the files it was last deployed from here', async () => {
    useDeployAppEnvFilesStore.getState().remember(SERVER.id, STACK_ID, 'env-2', ['s2']);
    const existing = sampleDetails({
      stack: sampleStack({
        source: {
          projectId: 'proj-1',
          projectName: 'Shop',
          composePath: 'compose.yaml',
          environmentId: 'env-2',
          environmentName: 'Staging',
        },
      }),
    });
    const { user, bridge } = renderWizard({}, { existing });
    await waitFor(() => expect(box('.env.staging')).toBeChecked());
    expect(box('.env')).not.toBeChecked();
    expect(screen.getByText('1 of 3 files')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    expect(lastPreview(bridge)).toMatchObject({ environmentId: 'env-2', envFileIds: ['s2'] });
  });

  it('uses every file when the remembered pick was for another environment or is gone', async () => {
    useDeployAppEnvFilesStore.getState().remember(SERVER.id, STACK_ID, 'env-2', ['gone']);
    const existing = sampleDetails({
      stack: sampleStack({
        source: {
          projectId: 'proj-1',
          projectName: 'Shop',
          composePath: 'compose.yaml',
          environmentId: 'env-2',
          environmentName: 'Staging',
        },
      }),
    });
    const { user, bridge } = renderWizard({}, { existing });
    await waitFor(() => expect(screen.getByText('3 of 3 files')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    expect(lastPreview(bridge)).not.toHaveProperty('envFileIds');
  });

  it('ignores a pick remembered for another environment of the app', async () => {
    useDeployAppEnvFilesStore.getState().remember(SERVER.id, STACK_ID, 'env-2', ['s2']);
    // The sample app deploys with Production (env-1).
    renderWizard({}, { existing: sampleDetails() });
    expect(await screen.findByText('1 of 1 file')).toBeInTheDocument();
    expect(box('.env.production')).toBeChecked();
  });
});

describe('NewAppWizard configure and expose', () => {
  it('shows the services and env keys, never values, and warns about missing variables', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.preview': samplePreview({
        missingVariables: ['SMTP_HOST'],
        buildContext: 'web builds from the project.',
        composeName: 'Shop Front',
      }),
    });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    const services = await screen.findByRole('list', { name: 'Services to deploy' });
    expect(within(services).getByText('nginx:1.29')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Env keys' })).toHaveTextContent('DATABASE_URL');
    expect(screen.getByText(/From \.env\.production/)).toBeInTheDocument();
    expect(screen.getByText('SMTP_HOST')).toBeInTheDocument();
    expect(screen.getByText(/web builds from the project\./)).toBeInTheDocument();
    expect(bridge.$fn('deployStacks.preview')).toHaveBeenCalledWith({
      projectId: 'proj-1',
      composePath: 'compose.yaml',
      environmentId: 'env-1',
    });
    // The compose file's own name wins over the folder's, until one is typed.
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByLabelText('App name')).toHaveValue('shop-front');
  });

  it('stops at a compose file that cannot be deployed', async () => {
    const { user } = renderWizard({
      'deployStacks.preview': samplePreview({ blocking: 'The key 1BAD cannot be used.' }),
    });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText(/The key 1BAD cannot be used/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('says when the compose file could not be read', async () => {
    const { user } = renderWizard({
      'deployStacks.preview': () => Promise.reject(new Error('ENOENT compose.yaml')),
    });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(
      await screen.findByText(/The compose file could not be read: ENOENT/),
    ).toBeInTheDocument();
  });

  it('keeps services private by default and asks again when one goes public', async () => {
    const { user, bridge } = renderWizard();
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    const web = await screen.findByRole('listitem', { name: 'web' });
    const toggle = within(web).getByRole('switch', { name: 'Keep web private' });
    expect(toggle).toBeChecked();
    const ports = within(web).getByRole('table', { name: 'Ports of web' });
    expect(ports).toHaveTextContent('*:8080');
    expect(ports).toHaveTextContent('127.0.0.1:8080');
    expect(ports).toHaveTextContent('this server only');
    expect(screen.getByText(/public access\s+comes through Websites/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'The override file the server writes' }));
    expect(screen.getByLabelText('Override file')).toHaveTextContent('!override');

    await user.click(toggle);
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.preview')).toHaveBeenLastCalledWith(
        expect.objectContaining({ proxiedServices: [] }),
      ),
    );
  });

  it('cannot keep a host-network service private', async () => {
    const preview = samplePreview();
    preview.services[0] = { ...preview.services[0], hostNetwork: true };
    const { user } = renderWizard({ 'deployStacks.preview': preview });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByRole('switch', { name: 'Keep web private' })).toBeDisabled();
  });

  it('says so when no service publishes a port', async () => {
    const preview = samplePreview();
    preview.services = preview.services.map((service) => ({
      ...service,
      publishes: false,
      ports: [],
    }));
    const { user } = renderWizard({ 'deployStacks.preview': { ...preview, overrideText: '' } });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText(/No service publishes a port/)).toBeInTheDocument();
  });
});

describe('NewAppWizard review and deploy', () => {
  it('needs every finding accepted, lists low ones as advice, then deploys', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.create': uploadResult(),
      'deployStacks.deploy': sampleJob(),
      'deployStacks.get': sampleDetails({
        stack: sampleStack({ status: 'busy' }),
        revisions: [
          sampleRevision({
            number: 1,
            state: 'deploying',
            steps: [
              { kind: 'validate', state: 'running', startedAtUnixMs: Date.now(), firstLogSeq: 2 },
            ],
          }),
        ],
      }),
    });
    await toReview(user);
    const deploy = screen.getByRole('button', { name: 'Deploy shop' });
    expect(deploy).toBeDisabled();
    expect(screen.getByText('1 finding still needs accepting.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Advice' })).toHaveTextContent(
      'web has no healthcheck.',
    );
    await user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    expect(deploy).toBeEnabled();
    await user.click(deploy);

    expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      name: 'shop',
      projectId: 'proj-1',
      composePath: 'compose.yaml',
      environmentId: 'env-1',
      proxiedServices: ['web'],
      acknowledgedRisks: ['privileged:db'],
    });
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.deploy')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        revision: 1,
      }),
    );
    expect(await screen.findByRole('list', { name: 'Deploy steps' })).toBeInTheDocument();
    act(() =>
      bridge.$emit('deployJobs.onLog', {
        subscriptionId: 'log-1',
        serverId: SERVER.id,
        jobId: JOB_ID,
        lines: [{ seq: 2, atUnixMs: Date.now(), source: 'out', text: 'name: shop' }],
      }),
    );
    expect(await screen.findByRole('log', { name: 'Validate log' })).toHaveTextContent(
      'name: shop',
    );
    await user.click(screen.getByRole('button', { name: /Open the app/ }));
  });

  it('shows how the upload is going', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.preview': samplePreview({ risks: [], requiresAcknowledgment: [] }),
      'deployStacks.create': () => new Promise(() => undefined),
    });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Exposure' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText(/Nothing risky found/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    expect(await screen.findByText(/Getting the files ready/)).toBeInTheDocument();
    act(() =>
      bridge.$emit('deployStacks.onUploadProgress', {
        serverId: SERVER.id,
        phase: 'uploading-context',
        sentBytes: 512 * 1024,
        totalBytes: 2 * 1024 * 1024,
      }),
    );
    expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.getByText('512 KB of 2.0 MB')).toBeInTheDocument();
    act(() => bridge.$emit('deployStacks.onUploadProgress', { serverId: 'other', phase: 'done' }));
    expect(screen.getByText(/Sending the project folder/)).toBeInTheDocument();
  });

  it('shows why the server turned the files down', async () => {
    const { user } = renderWizard({
      'deployStacks.create': uploadResult({
        state: 'invalid',
        error: 'service "web" refers to undefined volume data',
      }),
    });
    await toReview(user);
    await user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    expect(await screen.findByText(/undefined volume data/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Back to the review/ }));
    expect(await screen.findByRole('list', { name: 'Findings to accept' })).toBeInTheDocument();
  });

  it('asks for what the server found on top, then accepts it and deploys', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.create': uploadResult({
        findings: [
          {
            id: 'public-port:web:*:8443:443/tcp',
            rule: 'public-port',
            severity: 'medium',
            message: 'web publishes 443/tcp on every interface.',
            service: 'web',
          },
        ],
        unacknowledgedRisks: ['public-port:web:*:8443:443/tcp'],
      }),
      'deployStacks.acknowledge': sampleRevision({ number: 1, state: 'ready' }),
      'deployStacks.deploy': sampleJob(),
    });
    await toReview(user);
    await user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    const accept = await screen.findByRole('button', { name: 'Accept and deploy' });
    expect(accept).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: 'I accept: web publishes 443/tcp on every interface.' }),
    );
    await user.click(accept);
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.acknowledge')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        revision: 1,
        riskIds: ['public-port:web:*:8443:443/tcp'],
      }),
    );
    await waitFor(() => expect(bridge.$fn('deployStacks.deploy')).toHaveBeenCalled());
  });

  it('says why the deploy could not start, and tries the deploy again without a new upload', async () => {
    let calls = 0;
    const { user, bridge } = renderWizard({
      'deployStacks.create': uploadResult(),
      'deployStacks.deploy': async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            "Error invoking remote method 'deployStacks:deploy': Error: [core:forbidden] Your role on this server (viewer) cannot do that.",
          );
        }
        return sampleJob();
      },
    });
    await toReview(user);
    await user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    expect(
      await screen.findByText('Your role on this server (viewer) cannot do that.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.$fn('deployStacks.deploy')).toHaveBeenCalledTimes(2));
    expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledTimes(1);
  });

  it('says why the upload failed and can start it over', async () => {
    let calls = 0;
    const { user, bridge } = renderWizard({
      'deployStacks.create': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The build context is larger than 256 MB.');
        return uploadResult();
      },
      'deployStacks.deploy': sampleJob(),
    });
    await toReview(user);
    await user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    expect(await screen.findByText(/larger than 256 MB/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledTimes(2));
  });

  it('deploys an existing app again as a new revision from where it came from', async () => {
    const { user, bridge } = renderWizard(
      {
        'deployStacks.upload': uploadResult({ number: 3 }),
        'deployStacks.deploy': sampleJob(),
      },
      { existing: sampleDetails() },
    );
    expect(screen.getByRole('heading', { name: 'Deploy shop again' })).toBeInTheDocument();
    expect(screen.getByLabelText('App name')).toHaveAttribute('readonly');
    await user.click(await screen.findByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Exposure' });
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(
      await screen.findByRole('checkbox', { name: 'I accept: db runs privileged.' }),
    );
    await user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.upload')).toHaveBeenCalledWith(
        expect.objectContaining({
          stackId: STACK_ID,
          projectId: 'proj-1',
          environmentId: 'env-1',
          proxiedServices: ['web'],
        }),
      ),
    );
    // Never a second app: create was not even reached.
    expect(() => bridge.$fn('deployStacks.create')).toThrow(/has not been touched/);
  });

  it('cannot deploy for a Viewer', async () => {
    const { user } = renderWizard(
      {},
      {
        access: { ...OWNER, roles: ['viewer'], canOperate: false, canAdmin: false },
      },
    );
    await toReview(user);
    await user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    expect(screen.getByRole('button', { name: 'Deploy shop' })).toBeDisabled();
  });
});

describe('NewAppWizard when the page is left', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('opens again on the step it was left on, with what was picked', async () => {
    const first = renderWizard();
    await pickSource(first.user);
    await first.user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    first.unmount();

    renderWizard();
    const steps = screen.getByRole('list', { name: 'New app steps' });
    expect(within(steps).getByRole('listitem', { current: 'step' })).toHaveTextContent('Configure');
    expect(await screen.findByRole('list', { name: 'Services to deploy' })).toBeInTheDocument();
  });

  it('keeps uploading while away, and shows the deploy on return', async () => {
    const upload = deferred<unknown>();
    const first = renderWizard({
      'deployStacks.create': () => upload.promise,
      'deployStacks.deploy': sampleJob(),
    });
    await toReview(first.user);
    await first.user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    await first.user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    expect(await screen.findByText(/Getting the files ready/)).toBeInTheDocument();
    first.unmount();

    // The upload goes on in the main process while nobody looks.
    act(() =>
      first.bridge.$emit('deployStacks.onUploadProgress', {
        serverId: SERVER.id,
        phase: 'uploading-context',
        sentBytes: 1024 * 1024,
        totalBytes: 2 * 1024 * 1024,
      }),
    );

    const again = renderWizard({
      'deployStacks.create': () => upload.promise,
      'deployStacks.deploy': sampleJob(),
    });
    expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    await act(async () => upload.resolve(uploadResult()));
    // Coming back installs the app's bridge again; the deploy goes out through it, once.
    await waitFor(() => expect(again.bridge.$fn('deployStacks.deploy')).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('list', { name: 'Deploy steps' })).toBeInTheDocument();
    expect(first.bridge.$fn('deployStacks.create')).toHaveBeenCalledTimes(1);
  });

  it('still asks for the server findings after the page was left, and deploys', async () => {
    const bridge = {
      'deployStacks.create': uploadResult({
        findings: [
          {
            id: 'public-port:web:*:8443:443/tcp',
            rule: 'public-port',
            severity: 'medium',
            message: 'web publishes 443/tcp on every interface.',
            service: 'web',
          },
        ],
        unacknowledgedRisks: ['public-port:web:*:8443:443/tcp'],
      }),
      'deployStacks.acknowledge': sampleRevision({ number: 1, state: 'ready' }),
      'deployStacks.deploy': sampleJob(),
    };
    const first = renderWizard(bridge);
    await toReview(first.user);
    await first.user.click(screen.getByRole('checkbox', { name: 'I accept: db runs privileged.' }));
    await first.user.click(screen.getByRole('button', { name: 'Deploy shop' }));
    await screen.findByRole('button', { name: 'Accept and deploy' });
    first.unmount();

    const again = renderWizard(bridge);
    const accept = await screen.findByRole('button', { name: 'Accept and deploy' });
    await again.user.click(
      screen.getByRole('checkbox', { name: 'I accept: web publishes 443/tcp on every interface.' }),
    );
    await again.user.click(accept);
    await waitFor(() => expect(again.bridge.$fn('deployStacks.deploy')).toHaveBeenCalled());
  });

  it('starts over once it is cancelled', async () => {
    const first = renderWizard();
    await pickSource(first.user);
    await first.user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('list', { name: 'Services to deploy' });
    await first.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(first.onCancel).toHaveBeenCalled();
    first.unmount();

    renderWizard();
    const steps = screen.getByRole('list', { name: 'New app steps' });
    expect(within(steps).getByRole('listitem', { current: 'step' })).toHaveTextContent('Source');
  });
});
