import type { Project } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CreateRunWithAiDialog } from './CreateRunWithAiDialog';

const launch = vi.hoisted(() => ({ launchPromptTab: vi.fn(() => 'tab-1') }));
vi.mock('@/lib/workspace/launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace/launch')>()),
  launchPromptTab: launch.launchPromptTab,
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = {
  id: 'p1',
  name: 'BitIron',
  folderPath: 'E:\\BitIron\\BitIronPlatform',
  runCommands: [],
} as unknown as Project;

const SESSION = {
  ok: true,
  mcpConfigPath: 'C:\\data\\run-suggestions\\p1\\mcp.json',
  allowedTools: ['mcp__runova__list_run_commands', 'mcp__runova__propose_run_command'],
};

function renderDialog(
  options: {
    session?: unknown;
    installed?: boolean;
    project?: Project;
    onOpenChange?: (open: boolean) => void;
    onWriteMyself?: () => void;
  } = {},
) {
  const onOpenChange = options.onOpenChange ?? vi.fn();
  const view = renderWithProviders(
    <CreateRunWithAiDialog
      open
      onOpenChange={onOpenChange}
      project={options.project ?? project}
      onWriteMyself={options.onWriteMyself}
    />,
    {
      bridge: {
        platform: 'win32',
        'cli.detectAll': [{ id: 'claude-code', installed: options.installed ?? true }],
        'runProposals.startGuided': options.session ?? SESSION,
      },
    },
  );
  return { ...view, onOpenChange };
}

describe('CreateRunWithAiDialog', () => {
  it('explains what will happen, in three steps, before anything is typed', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Create a run command with AI' });

    expect(within(dialog).getByText('The agent looks at your project')).toBeTruthy();
    expect(within(dialog).getByText('It suggests a command')).toBeTruthy();
    expect(within(dialog).getByText('You review and add it')).toBeTruthy();
    expect(
      within(dialog).getByText(
        /Nothing is saved until you approve it, and nothing runs until you press Run/,
      ),
    ).toBeTruthy();
  });

  it('starts with a request already in the box, selected so typing replaces it', async () => {
    renderDialog();
    const box = (await screen.findByRole('textbox', {
      name: 'What should it run?',
    })) as HTMLTextAreaElement;

    expect(box.value).toBe('Work out how to run this project and create a run command for it.');
    await waitFor(() => expect(box).toHaveFocus());
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]);
  });

  it('offers example requests, and choosing one puts it in the box', async () => {
    const { user } = renderDialog();
    const dialog = await screen.findByRole('dialog');

    await user.click(
      within(dialog).getByRole('button', { name: 'Run the mobile app on the Android emulator' }),
    );

    expect(
      (within(dialog).getByRole('textbox', { name: 'What should it run?' }) as HTMLTextAreaElement)
        .value,
    ).toBe('Run the mobile app on the Android emulator');
    expect(within(dialog).getByRole('button', { name: /Create a \.bat file/ })).toBeTruthy();
  });

  it('starts Claude Code in a workspace tab with the request, the MCP config and the tools allowed', async () => {
    const { user, onOpenChange, bridge } = renderDialog();
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox', { name: 'What should it run?' });
    await user.clear(box);
    await user.type(box, 'Run the mobile app on the emulator');

    await user.click(within(dialog).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(launch.launchPromptTab).toHaveBeenCalledOnce());
    expect(bridge.$fn('runProposals.startGuided')).toHaveBeenCalledWith('p1');
    const [launchedProject, launched] = launch.launchPromptTab.mock.calls[0] as unknown as [
      Project,
      { cliId: string; prompt: string; runArgs: string[]; runLabel: string },
    ];
    expect(launchedProject).toBe(project);
    expect(launched.cliId).toBe('claude-code');
    expect(launched.prompt).toContain('Run the mobile app on the emulator');
    expect(launched.prompt).toContain('propose_run_command');
    expect(launched.prompt).toContain('PowerShell');
    expect(launched.runArgs).toEqual([
      '--mcp-config',
      'C:\\data\\run-suggestions\\p1\\mcp.json',
      '--allowedTools',
      'mcp__runova__list_run_commands',
      'mcp__runova__propose_run_command',
    ]);
    expect(launched.runLabel).toBe('Run command setup');
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith(
      'Starting Claude Code',
      expect.objectContaining({ description: expect.stringContaining('Press Enter') }),
    );
  });

  it('saves the command to the main project when it starts from a worktree workspace', async () => {
    launch.launchPromptTab.mockClear();
    const worktree = {
      ...project,
      id: 'p1::feature',
      parentId: 'p1',
      folderPath: 'E:\\BitIron\\worktrees\\feature',
    } as unknown as Project;
    const { user, bridge } = renderDialog({ project: worktree });
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(launch.launchPromptTab).toHaveBeenCalledOnce());
    // The suggestion belongs to the real project, while the agent works in the worktree folder.
    expect(bridge.$fn('runProposals.startGuided')).toHaveBeenCalledWith('p1');
    const [launchedProject, launched] = launch.launchPromptTab.mock.calls[0] as unknown as [
      Project,
      { prompt: string },
    ];
    expect(launchedProject).toBe(worktree);
    expect(launched.prompt).toContain('E:\\BitIron\\worktrees\\feature');
    expect(navigate).toHaveBeenCalledWith('/workspace/p1::feature');
  });

  it('starts with Ctrl+Enter from the box', async () => {
    const { user } = renderDialog();
    launch.launchPromptTab.mockClear();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('textbox', { name: 'What should it run?' }));

    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(launch.launchPromptTab).toHaveBeenCalledOnce());
  });

  it('says so, and cannot start, when Claude Code is not installed', async () => {
    renderDialog({ installed: false });
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/Claude Code is not installed/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('tells the person when the setup could not be prepared, and opens no tab', async () => {
    launch.launchPromptTab.mockClear();
    const { user, onOpenChange } = renderDialog({
      session: { ok: false, error: 'Could not prepare the run setup.' },
    });
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not prepare the run setup.'),
    );
    expect(launch.launchPromptTab).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('lets the person write the command themselves instead', async () => {
    const onWriteMyself = vi.fn();
    const { user, onOpenChange } = renderDialog({ onWriteMyself });
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: "I'll write it myself" }));

    expect(onWriteMyself).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows no write-it-myself button when there is nowhere to send the person', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('button', { name: "I'll write it myself" })).toBeNull();
  });
});
