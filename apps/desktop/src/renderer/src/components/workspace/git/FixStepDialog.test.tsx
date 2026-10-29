import type { Project } from '@runova/core';
import type { GithubStepLog } from '@shared/apiTypes';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const launchPromptTab = vi.fn((..._args: unknown[]) => 'tab-1');

vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: (...args: unknown[]) => launchPromptTab(...args),
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const { FixStepDialog, buildFixStepPrompt } = await import('./FixStepDialog');

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;
const target = {
  repo: 'acme/app',
  jobId: 11,
  jobName: 'Tests / E2E (linux, 1/3)',
  stepNumber: 15,
  stepName: 'Playwright (Linux)',
  workflowName: 'CI',
  displayTitle: 'Add login',
  runNumber: 251,
  headBranch: 'master',
};

const FAILED_LOG: GithubStepLog = {
  number: 15,
  errors: 1,
  warnings: 0,
  lines: [
    { text: 'Run pnpm test:e2e', kind: 'group' },
    { text: 'login.e2e.ts:12 expected 200, got 500', kind: 'error' },
  ],
};

const WARNING_LOG: GithubStepLog = {
  number: 15,
  errors: 0,
  warnings: 1,
  lines: [{ text: 'Node.js 16 actions are deprecated', kind: 'warning' }],
};

beforeEach(() => {
  launchPromptTab.mockClear();
});

describe('buildFixStepPrompt', () => {
  it('names the workflow, job, step and branch, and asks for the root cause of a failure', () => {
    const prompt = buildFixStepPrompt(target, 'the excerpt', 'failure');
    expect(prompt).toContain(
      'The step "Playwright (Linux)" of the job "Tests / E2E (linux, 1/3)" failed in the GitHub Actions workflow "CI" on master (run #251).',
    );
    expect(prompt).toContain('It ran for the commit "Add login".');
    expect(prompt).toContain('Find the root cause and fix it');
    expect(prompt).toContain('Output from the step:\n```\nthe excerpt\n```');
  });

  it('asks to clear the warnings, without changing behavior, when the step only warned', () => {
    const prompt = buildFixStepPrompt(target, 'the excerpt', 'warnings');
    expect(prompt).toContain('printed warnings');
    expect(prompt).toContain('without changing what the code does');
    expect(prompt).not.toContain('failed');
  });

  it('leaves out what it was not told', () => {
    const prompt = buildFixStepPrompt(
      { repo: 'acme/app', jobId: 1, jobName: 'build', stepNumber: 2, stepName: 'Lint' },
      'x',
      'failure',
    );
    expect(prompt.split('\n')[0]).toBe(
      'The step "Lint" of the job "build" failed in the GitHub Actions workflow "CI".',
    );
    expect(prompt).not.toContain('commit');
  });
});

describe('FixStepDialog', () => {
  function renderDialog(log: GithubStepLog, failed: boolean, onOpenChange = vi.fn()) {
    renderWithProviders(
      <FixStepDialog
        project={project}
        target={target}
        log={log}
        failed={failed}
        open
        onOpenChange={onOpenChange}
      />,
    );
    return onOpenChange;
  }

  it('starts from a prompt about the failed step with its error in it', () => {
    renderDialog(FAILED_LOG, true);
    expect(screen.getByText('Fix Playwright (Linux) with AI')).toBeInTheDocument();
    const prompt = screen.getByLabelText('Fix prompt') as HTMLTextAreaElement;
    expect(prompt.value).toContain('failed in the GitHub Actions workflow');
    expect(prompt.value).toContain('[error] login.e2e.ts:12 expected 200, got 500');
  });

  it('asks about the warnings for a step that passed with warnings', () => {
    renderDialog(WARNING_LOG, false);
    expect(screen.getByText('Fix the warnings in Playwright (Linux) with AI')).toBeInTheDocument();
    const prompt = screen.getByLabelText('Fix prompt') as HTMLTextAreaElement;
    expect(prompt.value).toContain('printed warnings');
    expect(prompt.value).toContain('[warning] Node.js 16 actions are deprecated');
  });

  it('opens the project agent with the prompt and closes', () => {
    const onOpenChange = renderDialog(FAILED_LOG, true);
    fireEvent.click(screen.getByRole('button', { name: /Open in Claude Code/ }));
    expect(launchPromptTab).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        cliId: 'claude-code',
        prompt: expect.stringContaining('expected 200, got 500'),
      }),
      undefined,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
