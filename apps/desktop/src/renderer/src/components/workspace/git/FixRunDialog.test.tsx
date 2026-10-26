// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * The failed-pipeline "Fix with AI" dialog. Written against the dialog before its body moved into
 * the shared FixWithAiDialog, so the move could not change what it does.
 */

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

const { FixRunDialog } = await import('./FixRunDialog');

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;
const run = {
  repo: 'acme/app',
  runId: 42,
  workflowName: 'CI',
  displayTitle: 'Add login',
  runNumber: 7,
  headBranch: 'main',
};

const runError = vi.fn();
const writeText = vi.fn((_text: string) => Promise.resolve());

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <FixRunDialog project={project} run={run} open onOpenChange={onOpenChange} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  launchPromptTab.mockClear();
  analyze.mockClear();
  runError.mockReset();
  writeText.mockClear();
  Object.assign(window, { runova: { pipelines: { runError } } });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => cleanup());

describe('FixRunDialog', () => {
  it('shows a shimmer while the failure loads, then a prompt built from it', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    runError.mockReturnValue(new Promise((done) => (resolve = done)));
    renderDialog();
    expect(screen.getByText('Reading the failure from GitHub…')).toBeTruthy();
    resolve({ ok: true, text: 'npm test exited with 1' });
    const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
    expect(prompt.value).toContain('The GitHub Actions workflow "CI" failed on main (run #7).');
    expect(prompt.value).toContain('npm test exited with 1');
    await waitFor(() => expect(analyze).toHaveBeenCalledWith({ prompt: prompt.value }));
  });

  it('offers to try again when the failure cannot be read', async () => {
    runError.mockResolvedValueOnce({ ok: false, error: 'gh is not signed in' });
    runError.mockResolvedValueOnce({ ok: true, text: 'second try' });
    renderDialog();
    expect(
      await screen.findByText(/Could not read this run's failure: gh is not signed in/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(((await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement).value).toContain(
      'second try',
    );
  });

  it('copies the prompt as edited', async () => {
    runError.mockResolvedValue({ ok: true, text: 'boom' });
    renderDialog();
    const prompt = await screen.findByLabelText('Fix prompt');
    fireEvent.change(prompt, { target: { value: 'my own words' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy prompt/ }));
    expect(writeText).toHaveBeenCalledWith('my own words');
  });

  it('opens the project agent with the prompt and closes', async () => {
    runError.mockResolvedValue({ ok: true, text: 'boom' });
    const onOpenChange = renderDialog();
    await screen.findByLabelText('Fix prompt');
    fireEvent.click(screen.getByRole('button', { name: /Open in Claude Code/ }));
    expect(launchPromptTab).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ cliId: 'claude-code', prompt: expect.stringContaining('boom') }),
      undefined,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
