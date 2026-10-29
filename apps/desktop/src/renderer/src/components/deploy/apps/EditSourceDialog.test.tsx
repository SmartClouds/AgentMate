import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDeployAppEnvFilesStore } from '@/stores/deployAppEnvFilesStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import {
  appsBridge,
  DISCOVERY,
  SERVER,
  STACK_ID,
  sampleDetails,
  sampleStack,
} from './testing/fixtures';

/**
 * Changing an app's compose file, environment or env files from its page: the project stays, and
 * nothing is sent until the Deploy again wizard ships it.
 */

const { EditSourceDialog } = await import('./EditSourceDialog');

const STAGING = sampleDetails({
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

function renderDialog(
  bridge: Record<string, unknown> = {},
  details: ReturnType<typeof sampleDetails> = STAGING,
) {
  const onClose = vi.fn();
  const onContinue = vi.fn();
  const view = renderWithProviders(
    <EditSourceDialog
      serverId={SERVER.id}
      details={details}
      onClose={onClose}
      onContinue={onContinue}
    />,
    {
      bridge: {
        ...appsBridge(),
        'deployStacks.discover': {
          ...DISCOVERY,
          files: [
            { path: 'compose.yaml', services: 2 },
            { path: 'deploy/docker-compose.prod.yml', services: 3 },
            ...DISCOVERY.files.filter((file) => file.error),
          ],
        },
        ...bridge,
      },
    },
  );
  return { ...view, onClose, onContinue };
}

const dialog = () => screen.getByRole('dialog');
const continueButton = () => within(dialog()).getByRole('button', { name: /Continue/ });
const box = (name: string) =>
  within(screen.getByRole('list', { name: 'Env files' })).getByRole('checkbox', { name });

async function opened() {
  await screen.findByRole('dialog');
  await waitFor(() => expect(box('.env')).toBeInTheDocument());
}

describe('EditSourceDialog', () => {
  it('starts from what the app deploys now, and says nothing changed yet', async () => {
    renderDialog();
    await opened();
    expect(screen.getByRole('heading', { name: 'Change what shop deploys' })).toBeInTheDocument();
    expect(within(dialog()).getByText(/From Shop\./)).toBeInTheDocument();
    expect(within(dialog()).queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^compose\.yaml/ })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('Staging');
    expect(screen.getByText('3 of 3 files')).toBeInTheDocument();
    expect(screen.getByText('Pick another file to continue.')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it('starts from the env files the app was last deployed from here', async () => {
    useDeployAppEnvFilesStore.getState().remember(SERVER.id, STACK_ID, 'env-2', ['s1', 's2']);
    renderDialog();
    await opened();
    expect(box('.env.local')).not.toBeChecked();
    expect(screen.getByText('2 of 3 files')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it('hands over another compose file with the rest kept', async () => {
    const { user, onContinue, bridge } = renderDialog();
    await opened();
    await user.click(screen.getByRole('radio', { name: /docker-compose\.prod\.yml/ }));
    expect(screen.queryByText('Pick another file to continue.')).not.toBeInTheDocument();
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith({
      projectId: 'proj-1',
      projectName: 'Shop',
      projectFolder: '',
      composePath: 'deploy/docker-compose.prod.yml',
      environmentId: 'env-2',
      environmentName: 'Staging',
      envFileIds: null,
      name: 'shop',
    });
    // Nothing goes to the server from here.
    expect(() => bridge.$fn('deployStacks.upload')).toThrow(/has not been touched/);
  });

  it('hands over fewer env files', async () => {
    const { user, onContinue } = renderDialog();
    await opened();
    await user.click(box('.env.staging'));
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ composePath: 'compose.yaml', envFileIds: ['s1', 's3'] }),
    );
  });

  it('hands over another environment, with all of its files', async () => {
    const { user, onContinue } = renderDialog();
    await opened();
    await user.click(screen.getByRole('combobox', { name: 'Environment' }));
    await user.click(await screen.findByRole('option', { name: 'Production' }));
    expect(box('.env.production')).toBeChecked();
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-1',
        environmentName: 'Production',
        envFileIds: null,
      }),
    );
  });

  it('hands over no environment at all', async () => {
    const { user, onContinue } = renderDialog();
    await opened();
    await user.click(screen.getByRole('combobox', { name: 'Environment' }));
    await user.click(await screen.findByRole('option', { name: 'No environment' }));
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: null, envFileIds: null }),
    );
  });

  it('will not continue with no env file ticked', async () => {
    const { user } = renderDialog();
    await opened();
    for (const name of ['.env', '.env.staging', '.env.local']) await user.click(box(name));
    expect(screen.getByText('Tick at least one file, or pick No environment.')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it('will not continue while the compose file is not in the project any more', async () => {
    const { user } = renderDialog({
      'deployStacks.discover': {
        ...DISCOVERY,
        files: [{ path: 'deploy/docker-compose.prod.yml', services: 3 }],
      },
    });
    await opened();
    await user.click(box('.env'));
    expect(continueButton()).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /docker-compose\.prod\.yml/ }));
    expect(continueButton()).toBeEnabled();
  });

  it('offers to list the compose files again when that failed', async () => {
    let calls = 0;
    const { user } = renderDialog({
      'deployStacks.discover': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The folder is gone.');
        return { ...DISCOVERY, files: [{ path: 'compose.yaml', services: 2 }] };
      },
    });
    expect(await screen.findByText(/could not be listed: The folder is gone/)).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /compose\.yaml/ })).toBeChecked();
  });

  it('closes from Cancel without handing anything over', async () => {
    const { user, onClose, onContinue } = renderDialog();
    await opened();
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
