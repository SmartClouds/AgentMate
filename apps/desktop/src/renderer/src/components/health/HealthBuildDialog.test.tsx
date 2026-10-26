import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { environment, project } from './testing/fixtures';

const launchPromptTab = vi.fn((..._args: unknown[]) => 'tab-1');
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: (...args: unknown[]) => launchPromptTab(...args),
  projectCliId: () => 'claude-code',
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { HealthBuildDialog } = await import('./HealthBuildDialog');

const projects = [project(), project({ id: 'p2', name: 'Admin' })];
const onAddTarget = vi.fn();

function renderDialog(props: { defaultProjectId?: string; lockProject?: boolean } = {}) {
  return renderWithProviders(
    <HealthBuildDialog
      open
      onOpenChange={vi.fn()}
      projects={projects}
      defaultProjectId={props.defaultProjectId ?? 'p1'}
      lockProject={props.lockProject}
      onAddTarget={onAddTarget}
    />,
    {
      bridge: {
        'environments.list': async (projectId: string) =>
          projectId === 'p1'
            ? [environment(), environment({ id: 'env-staging', name: 'Staging', order: 1 })]
            : [],
      },
    },
  );
}

function prompt(): string {
  return screen.getByRole('region', { name: 'Prompt for your agent' }).textContent ?? '';
}

describe('HealthBuildDialog', () => {
  it('builds the prompt from the project, environment, server, sign-in and path', async () => {
    const { user } = renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    expect(prompt()).toContain('Add a healthcheck endpoint to Storefront');
    expect(prompt()).toContain('RUNOVA_HEALTH_TOKEN_SHA256');
    expect(prompt()).toContain('`/_runova/health`');

    await user.click(within(dialog).getByRole('combobox', { name: 'Environment' }));
    await user.click(await screen.findByRole('option', { name: 'Staging' }));
    await user.type(within(dialog).getByLabelText('Server'), 'web-2');
    expect(prompt()).toContain('on the Staging environment, server web-2');

    await user.click(within(dialog).getByRole('button', { name: 'HTTP Basic' }));
    expect(prompt()).toContain('RUNOVA_HEALTH_PASSWORD_SHA256');
    expect(prompt()).toContain('RUNOVA_HEALTH_USER');

    await user.clear(within(dialog).getByLabelText('Path'));
    await user.type(within(dialog).getByLabelText('Path'), '/status/runova');
    expect(prompt()).toContain('`/status/runova`');

    // The prompt names variables only. A key is made when a target is added, never here.
    expect(prompt()).not.toMatch(/rnh_[A-Za-z0-9_-]{10,}/);
  });

  it('sends the prompt to the project agent by name and opens the workspace', async () => {
    const { user } = renderDialog();
    await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    await user.click(screen.getByRole('button', { name: 'Send to Claude Code' }));
    expect(launchPromptTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({
        cliId: 'claude-code',
        prompt: expect.stringContaining('Runova Health Protocol'),
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
  });

  it('copies the prompt, and the protocol on its own', async () => {
    const { user } = renderDialog();
    await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(await navigator.clipboard.readText()).toContain('Add a healthcheck endpoint');

    await user.click(screen.getByRole('tab', { name: 'Protocol' }));
    await user.click(screen.getByRole('button', { name: 'Copy protocol' }));
    const spec = await navigator.clipboard.readText();
    expect(spec).toContain('Runova Health Protocol');
    expect(spec).not.toContain('Add a healthcheck endpoint');
  });

  it('switches projects, and goes on to add a target for the chosen one', async () => {
    const { user } = renderDialog();
    await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    expect(prompt()).toContain('Add a healthcheck endpoint to Admin');

    await user.click(screen.getByRole('button', { name: 'Add target' }));
    expect(onAddTarget).toHaveBeenCalledWith('p2');
  });

  it('keeps the project fixed on a project tab', async () => {
    renderDialog({ lockProject: true });
    await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeDisabled();
  });

  it('asks for a project before it can build a prompt, and sends to the one picked', async () => {
    const { user } = renderDialog({ defaultProjectId: '' });
    const dialog = await screen.findByRole('dialog', { name: 'Build the endpoint with AI' });
    expect(within(dialog).getByText('Pick a project first')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Send to/ })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Copy prompt' })).toBeNull();

    const choices = within(dialog).getByRole('list', {
      name: 'Which project is the endpoint for?',
    });
    expect(within(choices).getByRole('button', { name: /Storefront/ })).toHaveTextContent(
      'C:\\work\\storefront',
    );
    await user.click(within(choices).getByRole('button', { name: /Admin/ }));
    expect(prompt()).toContain('Add a healthcheck endpoint to Admin');
    expect(within(dialog).getByText(/Opens in/)).toHaveTextContent('Opens in Admin');

    await user.click(within(dialog).getByRole('button', { name: 'Send to Claude Code' }));
    expect(launchPromptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'p2' }),
      expect.anything(),
    );
    expect(navigate).toHaveBeenLastCalledWith('/workspace/p2');
  });
});
