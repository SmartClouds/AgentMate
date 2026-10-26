import type { Project } from '@runova/core';
import type { WorkspaceGitState } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { StashMenu } from './StashesSection';
import type { GitActions } from './useWorkspaceGit';

/**
 * The stash menu in the Changes header. Keep Staged needs something staged, and Pop can't start
 * while another pop is running: the first pop drops its stash, so a second one sent with the same
 * ref would restore the next stash down.
 */

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app', cliId: 'claude' } as Project;

function gitState(overrides: Record<string, unknown> = {}): WorkspaceGitState {
  return {
    isRepo: true,
    branch: 'main',
    detached: false,
    head: 'abc1234',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    operation: null,
    conflicts: [],
    staged: [],
    unstaged: [{ path: 'src/app.ts', status: 'M' }],
    untracked: [],
    untrackedTruncated: false,
    projectPrefix: '',
    ...overrides,
  } as WorkspaceGitState;
}

function gitActions(): GitActions {
  return {
    stage: vi.fn(async () => undefined),
    unstage: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    applyLines: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    resolveWithAi: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    commit: vi.fn(async () => true),
    stash: vi.fn(async () => undefined),
    stashRestore: vi.fn(async () => undefined),
    stashDrop: vi.fn(async () => undefined),
  };
}

const STASH_MESSAGE = 'WIP on main: abc1234 Fix the parser';

function renderStashMenu(state: WorkspaceGitState, actions: GitActions) {
  return renderWithProviders(<StashMenu project={project} state={state} actions={actions} />, {
    bridge: {
      'git.stashList': async () => [{ ref: 'stash@{0}', index: 0, message: STASH_MESSAGE }],
    },
  });
}

async function openMenu(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: /Stash changes/ }));
  await screen.findByRole('menu');
}

describe('StashMenu', () => {
  it('holds Keep Staged back while nothing is staged, and Stash All stays open', async () => {
    const { user } = renderStashMenu(gitState(), gitActions());
    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: /Keep Staged/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByRole('menuitem', { name: /Stash All \(--include-untracked\)/ }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('does not start a second pop while one is still running', async () => {
    // A pop that never settles, so the menu stays busy for the rest of the test.
    const actions = {
      ...gitActions(),
      stashRestore: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const { user } = renderStashMenu(gitState(), actions);
    await openMenu(user);
    await screen.findByText(STASH_MESSAGE);

    await user.click(screen.getByRole('menuitem', { name: /Pop Latest Stash/ }));
    await waitFor(() => expect(actions.stashRestore).toHaveBeenCalledWith('pop', 'stash@{0}'));

    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: /Pop Latest Stash/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
