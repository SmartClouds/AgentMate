import type { PrCheck, Project, PullRequestInfo } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { PrChecks } from './PrChecks';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));

// Only which run the dialog is opened for matters here.
vi.mock('../FixRunDialog', () => ({
  FixRunDialog: ({ run }: { run: { runId: number; workflowName: string; headBranch: string } }) => (
    <div role="dialog" aria-label="fix">
      {`${run.workflowName}:${run.runId}:${run.headBranch}`}
    </div>
  ),
}));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

function check(
  name: string,
  status: string,
  conclusion: string | null,
  runId: number | null,
): PrCheck {
  return {
    name,
    workflow: runId ? 'CI' : null,
    status,
    conclusion,
    detailsUrl: `https://x/${name}`,
    runId,
  };
}

const PR = {
  number: 7,
  title: 'Add it',
  head: 'feature',
  base: 'master',
  checks: [
    check('build', 'completed', 'success', 11),
    check('lint', 'in_progress', null, 11),
    check('test', 'completed', 'failure', 11),
    check('ci/circleci', 'completed', 'failure', null),
  ],
} as PullRequestInfo;

function renderChecks(pr: PullRequestInfo = PR) {
  return renderWithProviders(<PrChecks project={project} pr={pr} repo="acme/app" />);
}

describe('PrChecks', () => {
  it('sums up the checks and lists failures first', () => {
    renderChecks();
    expect(screen.getByText('2 failed · 1 running · 1 passed')).toBeInTheDocument();
    const names = screen.getAllByTestId('pr-check-name').map((el) => el.textContent);
    expect(names).toEqual(['test', 'ci/circleci', 'lint', 'build']);
  });

  it('fixes a failed Actions check with AI, for the run behind it', async () => {
    const { user } = renderChecks();
    const fixes = screen.getAllByRole('button', { name: 'Fix with AI' });
    // The external CI check has no Actions run to read, so only one row offers a fix.
    expect(fixes).toHaveLength(1);
    await user.click(fixes[0]!);
    expect(screen.getByRole('dialog')).toHaveTextContent('CI:11:feature');
  });

  it('opens a check on GitHub', async () => {
    const { user, bridge } = renderChecks();
    await user.click(screen.getByRole('button', { name: /^build/ }));
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('https://x/build');
  });

  it('says when the PR has no checks', () => {
    renderChecks({ ...PR, checks: [] });
    expect(screen.getByText('No checks on this pull request.')).toBeInTheDocument();
  });
});
