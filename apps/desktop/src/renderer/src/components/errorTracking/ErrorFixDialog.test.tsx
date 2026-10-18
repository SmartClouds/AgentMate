import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { issue, project } from './testing/fixtures';

const launch = vi.hoisted(() => ({ launchPromptTab: vi.fn(() => 'tab-1') }));
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: launch.launchPromptTab,
  projectCliId: () => 'claude-code',
}));
vi.mock('@/components/promptBuilder/RunRecommendation', () => ({
  useRunRecommendation: () => ({
    status: 'idle',
    recommendation: null,
    choice: null,
    analyze: vi.fn(),
  }),
  RunRecommendationPanel: () => <div>sizing panel</div>,
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { ErrorFixDialog } = await import('./ErrorFixDialog');

function renderDialog(bridge: Record<string, unknown>) {
  return renderWithProviders(
    <ErrorFixDialog project={project()} issue={issue()} open onOpenChange={vi.fn()} />,
    { bridge },
  );
}

describe('ErrorFixDialog', () => {
  it('fills the prompt from the main process and names the issue', async () => {
    const { bridge } = renderDialog({
      'errorTracking.fixPrompt': async () => ({ prompt: 'Fix WEB-3F.', copy: 'WEB-3F' }),
    });
    expect(await screen.findByRole('dialog', { name: 'Fix WEB-3F with AI' })).toBeInTheDocument();
    const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
    expect(prompt.value).toBe('Fix WEB-3F.');
    expect(bridge.$fn('errorTracking.fixPrompt')).toHaveBeenCalledWith({
      connectionId: 'c1',
      issueId: '4501',
    });
  });

  it('starts the agent with the prompt', async () => {
    const { user } = renderDialog({
      'errorTracking.fixPrompt': async () => ({ prompt: 'Fix WEB-3F.', copy: 'WEB-3F' }),
    });
    await screen.findByDisplayValue('Fix WEB-3F.');
    await user.click(screen.getByRole('button', { name: /Open in/ }));
    expect(launch.launchPromptTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ prompt: 'Fix WEB-3F.' }),
      undefined,
    );
  });

  it('says so when the prompt cannot be built', async () => {
    renderDialog({
      'errorTracking.fixPrompt': async () => {
        throw new Error('Token rejected');
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not build the fix prompt'),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Token rejected');
  });
});
