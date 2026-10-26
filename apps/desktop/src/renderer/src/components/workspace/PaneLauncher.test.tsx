// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { asWorkspaceProject } from '@/lib/workspace/scope';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { PaneLauncher } from './PaneLauncher';

const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app', cliId: null } as Project;
const worktree = {
  id: 'wt-1',
  projectId: 'p1',
  path: 'C:\\code\\app.worktrees\\feat-auth',
  branch: 'feat/auth',
  baseBranch: 'main',
  createdAt: '2026-09-25T00:00:00.000Z',
  createdByApp: true,
  missing: false,
  locked: false,
  status: null,
} satisfies WorktreeInfo;

describe('PaneLauncher in a worktree', () => {
  it('says which worktree an agent started here would work in', () => {
    renderWithProviders(
      <PaneLauncher
        project={asWorkspaceProject(project, worktree)}
        groupId="g1"
        hero
        focused={false}
      />,
      { bridge: { 'cli.detectAll': [], platform: 'win32' } },
    );
    expect(screen.getByText('Worktree')).toBeInTheDocument();
    expect(screen.getByText('feat/auth')).toBeInTheDocument();
    expect(screen.getByText(worktree.path)).toBeInTheDocument();
  });

  it('shows no branch for the main checkout', () => {
    renderWithProviders(<PaneLauncher project={project} groupId="g1" hero focused={false} />, {
      bridge: { 'cli.detectAll': [], platform: 'win32' },
    });
    expect(screen.queryByText('Worktree')).toBeNull();
  });
});

describe('PaneLauncher browser', () => {
  it('opens a browser tab in its pane', async () => {
    useWorkspaceStore.getState().openProject('p1');
    const groupId = useWorkspaceStore.getState().workspaces.p1?.focusedGroupId ?? '';
    const { user } = renderWithProviders(
      <PaneLauncher project={project} groupId={groupId} hero focused={false} />,
      { bridge: { 'cli.detectAll': [], platform: 'win32' } },
    );
    await user.click(screen.getByRole('button', { name: /Browser/ }));
    const tabs = Object.values(useWorkspaceStore.getState().workspaces.p1?.tabs ?? {});
    expect(tabs).toEqual([expect.objectContaining({ kind: 'browser', url: '' })]);
  });
});

describe('PaneLauncher agent cards', () => {
  const claude = {
    id: 'claude-code',
    installed: true,
    version: '1.0.0',
    executablePath: '/usr/local/bin/claude',
    lastCheckedAt: '2026-01-01T10:00:00.000Z',
  };
  const codex = { ...claude, id: 'codex-cli', executablePath: '/usr/local/bin/codex' };
  const withAgent = { ...project, cliId: 'claude-code' } as Project;

  it('marks only the project default with a Default chip', async () => {
    renderWithProviders(<PaneLauncher project={withAgent} groupId="g1" hero focused />, {
      bridge: { 'cli.detectAll': [claude, codex], platform: 'win32' },
    });
    const claudeCard = await screen.findByRole('button', { name: /Claude Code CLI/ });
    const codexCard = screen.getByRole('button', { name: /Codex CLI/ });
    expect(within(claudeCard).getByText('Default')).toBeInTheDocument();
    expect(within(codexCard).queryByText('Default')).toBeNull();
    // The digit is a key hint, not part of the card's name.
    expect(claudeCard).toHaveAttribute('aria-keyshortcuts', '1');
    expect(codexCard).toHaveAttribute('aria-keyshortcuts', '2');
  });

  it('links each missing agent to the CLI manager and says it is not installed', async () => {
    const { user } = renderWithProviders(
      <PaneLauncher project={withAgent} groupId="g1" hero focused={false} />,
      { bridge: { 'cli.detectAll': [claude], platform: 'win32' } },
    );
    const gemini = await screen.findByRole('link', { name: 'Install Gemini CLI' });
    expect(gemini).toHaveAttribute('href', '/cli-manager');
    // Fifteen are missing: eight show as icons and the rest fold into one link.
    expect(screen.getAllByRole('link', { name: /^Install / })).toHaveLength(8);
    expect(screen.getByRole('link', { name: '7 more agents to install' })).toHaveAttribute(
      'href',
      '/cli-manager',
    );
    await user.hover(gemini);
    expect(
      (
        await screen.findAllByText(
          "Gemini CLI isn't installed. Install it from the AI CLI Manager.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('leaves the not-installed row out of a split pane', async () => {
    renderWithProviders(
      <PaneLauncher project={withAgent} groupId="g1" hero={false} focused={false} />,
      { bridge: { 'cli.detectAll': [claude], platform: 'win32' } },
    );
    await screen.findByRole('button', { name: /Claude Code CLI/ });
    expect(screen.queryByRole('link', { name: /^Install / })).toBeNull();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });
});
