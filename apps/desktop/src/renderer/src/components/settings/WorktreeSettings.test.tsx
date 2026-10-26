// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectWorktreeSetupForm, WorktreeSettingsForm } from './WorktreeSettings';

const settings = {
  worktrees: { baseDir: null, copyGlobs: ['.env', '.env.*'], deleteBranchOnRemove: false },
};

describe('WorktreeSettingsForm', () => {
  it('shows where worktrees go and what they copy', async () => {
    renderWithProviders(<WorktreeSettingsForm />, { bridge: { 'settings.get': settings } });
    expect(await screen.findByRole('radio', { name: /Next to the repository/ })).toBeChecked();
    expect(screen.getByLabelText('Files to copy')).toHaveValue('.env\n.env.*');
    expect(screen.getByRole('switch', { name: /Delete the branch/ })).not.toBeChecked();
  });

  it('keeps worktrees in one folder once one is picked', async () => {
    const { user, bridge } = renderWithProviders(<WorktreeSettingsForm />, {
      bridge: {
        'settings.get': settings,
        'worktrees.pickLocation': () => Promise.resolve('D:\\trees'),
        'settings.update': {},
      },
    });
    await user.click(await screen.findByRole('radio', { name: /In one folder/ }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        worktrees: { ...settings.worktrees, baseDir: 'D:\\trees' },
      }),
    );
  });

  it('saves the copy patterns once typing stops, one per line', async () => {
    const { user, bridge } = renderWithProviders(<WorktreeSettingsForm />, {
      bridge: { 'settings.get': settings, 'settings.update': {} },
    });
    const box = await screen.findByLabelText('Files to copy');
    await user.clear(box);
    await user.type(box, '.env{Enter}config/*.local');
    await waitFor(
      () =>
        expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({
          worktrees: { ...settings.worktrees, copyGlobs: ['.env', 'config/*.local'] },
        }),
      { timeout: 2000 },
    );
  });

  it('turns deleting merged branches on', async () => {
    const { user, bridge } = renderWithProviders(<WorktreeSettingsForm />, {
      bridge: { 'settings.get': settings, 'settings.update': {} },
    });
    await user.click(await screen.findByRole('switch', { name: /Delete the branch/ }));
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
      worktrees: { ...settings.worktrees, deleteBranchOnRemove: true },
    });
  });
});

describe('ProjectWorktreeSetupForm', () => {
  const project = {
    id: 'p1',
    name: 'App',
    worktreeSetup: { command: '', copyGlobs: null },
  } as unknown as Project;

  it('saves the setup command for the project', async () => {
    const { user, bridge } = renderWithProviders(<ProjectWorktreeSetupForm project={project} />, {
      bridge: { 'projects.update': project, 'settings.get': settings },
    });
    await user.type(screen.getByLabelText('Setup command'), 'pnpm install');
    await waitFor(
      () =>
        expect(bridge.$fn('projects.update')).toHaveBeenLastCalledWith('p1', {
          worktreeSetup: { command: 'pnpm install', copyGlobs: null },
        }),
      { timeout: 2000 },
    );
  });

  it('can use its own copy patterns instead of the app-wide ones', async () => {
    const { user, bridge } = renderWithProviders(<ProjectWorktreeSetupForm project={project} />, {
      bridge: { 'projects.update': project, 'settings.get': settings },
    });
    expect(
      await screen.findByText(/Uses the app-wide patterns: .env, .env.\*/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /Its own files to copy/ }));
    expect(bridge.$fn('projects.update')).toHaveBeenCalledWith('p1', {
      worktreeSetup: { command: '', copyGlobs: ['.env', '.env.*'] },
    });
  });
});
