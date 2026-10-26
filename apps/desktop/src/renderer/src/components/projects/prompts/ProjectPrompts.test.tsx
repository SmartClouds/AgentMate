import type { Project, ProjectDraft, ScheduledTask } from '@runova/core';
import type { PromptHistoryEntry } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * History, drafts and scheduled prompts share one section. What matters: each view shows the
 * right slice, a draft can be finished and moved onto the schedule, and Run now starts the CLI
 * in the project folder and records the run.
 */

vi.mock('@/stores/confirmStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/confirmStore')>();
  return { ...actual, confirmDialog: vi.fn(async () => true) };
});

// The view menu's springs call `jump` on their motion value, which the suite's Framer Motion stub
// has no answer for. Same shape as SkillsPage.test.
vi.mock('framer-motion', async (importOriginal) => {
  const stub = (await importOriginal()) as Record<string, unknown>;
  const motionValue = (initial: number) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: number) => {
        current = next;
      },
      jump: (next: number) => {
        current = next;
      },
      on: () => () => undefined,
    };
  };
  return {
    ...stub,
    useMotionValue: motionValue,
    useSpring: motionValue,
    useTransform: () => motionValue(0),
    useMotionValueEvent: () => undefined,
  };
});

const { ProjectPrompts } = await import('./ProjectPrompts');

const project = {
  id: 'p1',
  name: 'Apollo',
  folderPath: 'C:\\code\\apollo',
  agentType: 'claude-code',
  cliId: null,
} as unknown as Project;

const historyEntry: PromptHistoryEntry = {
  id: 'h1',
  rawInput: '',
  promptType: 'Feature',
  targetAI: 'Claude Code',
  content: 'Generated: build the signup page',
  source: 'generate',
  tags: [],
  projectId: 'p1',
  createdAt: '2026-09-21T10:00:00.000Z',
};

const draft: ProjectDraft = {
  id: 'd1',
  projectId: 'p1',
  rawInput: 'half-written idea about caching',
  promptType: '',
  targetAI: 'Claude Code',
  content: '',
  status: 'draft',
  createdAt: '2026-09-22T10:00:00.000Z',
  implementedAt: null,
};

const missedTask: ScheduledTask = {
  id: 't1',
  projectId: 'p1',
  rawInput: 'nightly dependency bump',
  promptType: '',
  targetAI: 'Claude Code',
  content: 'nightly dependency bump',
  runAt: '2026-09-22T02:00:00.000Z',
  status: 'missed',
  createdAt: '2026-09-20T10:00:00.000Z',
  runMode: 'auto',
  cliId: 'claude-code',
  model: 'opus',
  effort: 'high',
};

function renderSection(route = '/projects/p1?tab=prompts', bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<ProjectPrompts project={project} />, {
    route,
    bridge: {
      'promptHistory.list': [historyEntry],
      'projectDrafts.listByProject': [draft],
      'scheduledTasks.listByProject': [missedTask],
      'projects.list': [project],
      'cli.detectAll': [{ id: 'claude-code', installed: true }],
      'fs.writeScratchFile': async () => 'C:\\tmp\\scheduled-task-t1.md',
      ...bridge,
    },
  });
}

beforeEach(() => {
  useCliStore.setState({ cliArgs: {}, cliLaunchDefaults: {}, defaultCliId: null });
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

describe('ProjectPrompts', () => {
  it('shows history, drafts and scheduled prompts together under History', async () => {
    renderSection();

    expect(await screen.findByText('Generated: build the signup page')).toBeTruthy();
    expect(screen.getByText('half-written idea about caching')).toBeTruthy();
    expect(screen.getByText('nightly dependency bump')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^History/, current: true })).toBeTruthy();
  });

  it('narrows each view to its own kind and filters by search', async () => {
    const { user } = renderSection();
    await screen.findByText('Generated: build the signup page');

    await user.click(screen.getByRole('button', { name: /^Drafts/ }));
    expect(await screen.findByText('half-written idea about caching')).toBeTruthy();
    expect(screen.queryByText('Generated: build the signup page')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Scheduled/ }));
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('nightly dependency bump')).toBeTruthy();

    await user.type(screen.getByPlaceholderText('Search prompts…'), 'nothing like this');
    expect(await screen.findByText(/No prompts match/)).toBeTruthy();
  });

  it('opens the view named in the URL', async () => {
    renderSection('/projects/p1?tab=prompts&view=drafts');

    expect(await screen.findByRole('button', { name: /^Drafts/, current: true })).toBeTruthy();
    expect(await screen.findByText('In progress')).toBeTruthy();
  });

  it('runs a missed prompt in the project folder and records the run', async () => {
    const { user, bridge } = renderSection('/projects/p1?tab=prompts&view=scheduled');

    await user.click(await screen.findByRole('button', { name: /Run now/ }));

    await waitFor(() => expect(bridge.$fn('scheduledTasks.markRan')).toHaveBeenCalledWith('t1'));
    const [session] = useTerminalStore.getState().sessions;
    expect(session).toMatchObject({ cwd: 'C:\\code\\apollo', projectId: 'p1' });
    expect(session.initialInput).toContain('--model opus');
    expect(session.initialInput?.endsWith('\r')).toBe(true);
  });

  it('edits a draft in place', async () => {
    const { user, bridge } = renderSection('/projects/p1?tab=prompts&view=drafts');

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const area = screen.getByDisplayValue('half-written idea about caching');
    await user.type(area, ' with redis');
    await user.tab();

    await waitFor(() =>
      expect(bridge.$fn('projectDrafts.update')).toHaveBeenCalledWith('d1', {
        rawInput: 'half-written idea about caching with redis',
      }),
    );
  });

  it('moves a finished draft onto the schedule with its run settings', async () => {
    const { user, bridge } = renderSection('/projects/p1?tab=prompts&view=drafts');

    await user.click(await screen.findByRole('button', { name: 'Schedule it' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Schedule this draft')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: /Automatically/ }));
    await user.click(within(dialog).getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(bridge.$fn('projectDrafts.promoteToScheduled')).toHaveBeenCalledWith(
        'd1',
        expect.objectContaining({
          content: 'half-written idea about caching',
          runMode: 'auto',
          targetAI: 'Claude Code',
        }),
      ),
    );
  });

  it('writes a new draft from the section', async () => {
    const { user, bridge } = renderSection();

    await user.click(await screen.findByRole('button', { name: /New prompt/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Prompt'), 'try a new onboarding flow');
    await user.click(within(dialog).getByRole('button', { name: /Save draft/ }));

    await waitFor(() =>
      expect(bridge.$fn('projectDrafts.create')).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', rawInput: 'try a new onboarding flow' }),
      ),
    );
  });

  it('cancels and deletes scheduled prompts', async () => {
    const pending: ScheduledTask = {
      ...missedTask,
      id: 't2',
      status: 'pending',
      runMode: 'manual',
    };
    const { user, bridge } = renderSection('/projects/p1?tab=prompts&view=scheduled', {
      'scheduledTasks.listByProject': [pending],
    });

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(bridge.$fn('scheduledTasks.updateStatus')).toHaveBeenCalledWith('t2', 'cancelled'),
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(bridge.$fn('scheduledTasks.remove')).toHaveBeenCalledWith('t2'));
  });
});
