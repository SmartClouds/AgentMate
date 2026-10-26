import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { detail, project, target } from './testing/fixtures';

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

const { HealthSetupDialog } = await import('./HealthSetupDialog');

const setup = {
  prompt: 'Add a secured health endpoint to this app.',
  spec: '# Runova Health Protocol',
};

function renderDialog(overrides: Record<string, unknown> = {}) {
  return renderWithProviders(
    <HealthSetupDialog open onOpenChange={vi.fn()} target={target()} project={project()} />,
    { bridge: { 'health.setupPrompt': async () => setup, ...overrides } },
  );
}

describe('HealthSetupDialog', () => {
  it('shows the prompt and the protocol, each with its own copy button', async () => {
    const { user, bridge } = renderDialog();
    expect(
      await screen.findByRole('dialog', { name: 'Build the endpoint with AI' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(setup.prompt)).toBeInTheDocument();
    expect(bridge.$fn('health.setupPrompt')).toHaveBeenCalledWith('t1');
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(await navigator.clipboard.readText()).toBe(setup.prompt);

    await user.click(screen.getByRole('tab', { name: 'Protocol' }));
    expect(await screen.findByText(setup.spec)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy protocol' }));
    expect(await navigator.clipboard.readText()).toBe(setup.spec);
  });

  it("sends the prompt to the project's agent by name and opens the workspace", async () => {
    const { user } = renderDialog();
    await screen.findByText(setup.prompt);
    await user.click(screen.getByRole('button', { name: 'Send to Claude Code' }));
    expect(launchPromptTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), {
      cliId: 'claude-code',
      prompt: setup.prompt,
    });
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
  });

  it('tests the connection and says what it found', async () => {
    const { user, bridge } = renderDialog({
      'health.checkNow': async () =>
        detail({ target: target({ state: 'unauthorized' }), report: null }),
    });
    await screen.findByText(setup.prompt);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(bridge.$fn('health.checkNow')).toHaveBeenCalledWith('t1');
    const result = await screen.findByRole('status', { name: 'Connection test' });
    await waitFor(() => expect(result).toHaveTextContent('Key rejected'));
    expect(result).toHaveTextContent(/hash on the server/);
  });
});
