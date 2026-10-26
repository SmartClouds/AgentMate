// @vitest-environment jsdom
import type { Project } from '@runova/core';
import type { WorkspaceGitState } from '@shared/apiTypes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

/** "Fix with AI" for conflicts: one prompt covering every conflicted file, opened in the agent. */

const launchPromptTab = vi.fn((..._args: unknown[]) => 'tab-1');
const analyze = vi.fn();

vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: (...args: unknown[]) => launchPromptTab(...args),
  projectCliId: () => 'claude-code',
}));
vi.mock('@/components/promptBuilder/RunRecommendation', () => ({
  useRunRecommendation: () => ({
    status: 'idle',
    recommendation: null,
    choice: null,
    analyze,
  }),
  RunRecommendationPanel: () => <div>sizing panel</div>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const { FixConflictsButton } = await import('./FixConflictsDialog');

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;

const conflicted = {
  operation: 'merge',
  branch: 'main',
  projectPrefix: '',
  conflicts: [
    { path: 'src/app.ts', status: 'U', conflict: 'UU' },
    { path: 'src/other.ts', status: 'U', conflict: 'AA' },
  ],
} as Pick<WorkspaceGitState, 'operation' | 'branch' | 'conflicts' | 'projectPrefix'>;

function renderButton(state = conflicted) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <FixConflictsButton project={project} state={state} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  launchPromptTab.mockClear();
  analyze.mockClear();
});

afterEach(() => cleanup());

describe('FixConflictsButton', () => {
  it('renders nothing when there is nothing to resolve', () => {
    const { container } = renderButton({ ...conflicted, conflicts: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a dialog with a prompt covering every conflicted file', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));

    expect(await screen.findByText('Fix conflicts with AI')).toBeInTheDocument();
    expect(screen.getByText('Merge on main · 2 conflicted files')).toBeInTheDocument();
    const prompt = screen.getByLabelText('Fix prompt') as HTMLTextAreaElement;
    expect(prompt.value).toContain('- src/app.ts (both modified)');
    expect(prompt.value).toContain('- src/other.ts (both added)');
    expect(prompt.value).toContain('A merge is in progress');
    await waitFor(() => expect(analyze).toHaveBeenCalledWith({ prompt: prompt.value }));
  });

  it('describes conflicts with no operation pending by count alone', async () => {
    renderButton({ ...conflicted, operation: null, branch: null });
    fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    expect(await screen.findByText('2 conflicted files')).toBeInTheDocument();
  });

  it('opens the project agent with the prompt as edited and closes', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    const prompt = await screen.findByLabelText('Fix prompt');
    fireEvent.change(prompt, { target: { value: 'resolve src/app.ts only' } });
    fireEvent.click(screen.getByRole('button', { name: /Open in Claude Code/ }));

    expect(launchPromptTab).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ cliId: 'claude-code', prompt: 'resolve src/app.ts only' }),
      undefined,
    );
    await waitFor(() => expect(screen.queryByLabelText('Fix prompt')).not.toBeInTheDocument());
  });
});
