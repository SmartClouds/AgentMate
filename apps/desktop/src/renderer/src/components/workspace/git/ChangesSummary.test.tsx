// @vitest-environment jsdom
import type { GitChangeEntry } from '@runova/core';
import type { WorkspaceGitState } from '@shared/apiTypes';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { ChangesSummary } from './ChangesSummary';

/**
 * The totals strip above the changed files: how a pull request sums itself up, but for the
 * working tree. What matters is that the numbers match the files under them.
 */

function entry(path: string, additions: number, deletions: number): GitChangeEntry {
  return { path, status: 'M', additions, deletions };
}

function state(partial: Partial<WorkspaceGitState>): WorkspaceGitState {
  return {
    isRepo: true,
    branch: 'main',
    detached: false,
    head: 'abc1234',
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    operation: null,
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    untrackedTruncated: false,
    projectPrefix: '',
    ...partial,
  };
}

function renderSummary(gitState: WorkspaceGitState) {
  return render(
    <TooltipProvider>
      <ChangesSummary state={gitState} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useWorkspaceStore.getState().setGitPanel({ lineStatsExpanded: false });
});

afterEach(cleanup);

describe('ChangesSummary', () => {
  it('adds every group up into one total', () => {
    renderSummary(
      state({
        staged: [entry('a.ts', 180, 40), entry('b.ts', 210, 180)],
        unstaged: [entry('c.ts', 45, 40)],
        untracked: [entry('d.ts', 137, 0)],
      }),
    );
    expect(screen.getByRole('button', { name: /4 files changed/ })).toHaveAccessibleName(
      /572 lines added, 260 lines removed/,
    );
  });

  it('says nothing at all when the tree is clean', () => {
    const { container } = renderSummary(state({}));
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a per-group breakdown when clicked, and remembers it', () => {
    renderSummary(state({ staged: [entry('a.ts', 10, 2)], untracked: [entry('new.ts', 5, 0)] }));
    expect(screen.queryByText('Staged changes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /2 files changed/ }));
    expect(screen.getByText('Staged changes')).toBeInTheDocument();
    expect(screen.getByText('Untracked')).toBeInTheDocument();
    expect(useWorkspaceStore.getState().gitPanel.lineStatsExpanded).toBe(true);
  });

  it('leaves out an empty group rather than showing it at zero', () => {
    renderSummary(state({ unstaged: [entry('c.ts', 3, 1)] }));
    fireEvent.click(screen.getByRole('button', { name: /1 file changed/ }));
    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.queryByText('Staged changes')).not.toBeInTheDocument();
  });

  it('keeps files with no line counts out of the totals and says how many there were', () => {
    renderSummary(
      state({
        untracked: [
          entry('a.ts', 10, 0),
          { path: 'logo.png', status: '?', binary: true },
          { path: 'huge.bin', status: '?' },
        ],
      }),
    );
    const button = screen.getByRole('button', { name: /3 files changed/ });
    expect(button).toHaveAccessibleName(/10 lines added, 0 lines removed/);

    fireEvent.click(button);
    expect(screen.getByText(/2 files without line counts/)).toBeInTheDocument();
  });

  it('shortens counts that would not fit the panel', () => {
    renderSummary(state({ staged: [entry('a.ts', 12_345, 2_400_000)] }));
    expect(screen.getByText('+12.3k')).toBeInTheDocument();
    expect(screen.getByText('−2.4M')).toBeInTheDocument();
  });
});
