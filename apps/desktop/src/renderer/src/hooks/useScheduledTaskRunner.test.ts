import type { ScheduledTask } from '@runova/core';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useScheduledTaskRunner } from './useScheduledTaskRunner';

/**
 * Main decides when an automatic prompt is due; the renderer only opens it. The tab has to start
 * in the task's project folder, and the lists refresh so the card moves to Done.
 */

const toasts = vi.hoisted(() => ({ success: [] as unknown[], error: [] as unknown[] }));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn((message: unknown) => toasts.success.push(message)),
    error: vi.fn((message: unknown) => toasts.error.push(message)),
  },
}));

const task: ScheduledTask = {
  id: 't1',
  projectId: 'p1',
  rawInput: 'bump deps',
  promptType: '',
  targetAI: 'Claude Code',
  content: 'bump deps',
  runAt: '2026-09-23T02:00:00.000Z',
  status: 'completed',
  createdAt: '2026-09-20T10:00:00.000Z',
  runMode: 'auto',
  cliId: 'claude-code',
};

beforeEach(() => {
  toasts.success = [];
  toasts.error = [];
  useCliStore.setState({ cliArgs: {}, cliLaunchDefaults: {}, defaultCliId: null });
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

function renderRunner() {
  return renderHookWithProviders(() => useScheduledTaskRunner(), {
    bridge: {
      'projects.list': [{ id: 'p1', name: 'Apollo', folderPath: 'C:\\code\\apollo' }],
      'fs.writeScratchFile': async () => 'C:\\tmp\\scheduled-task-t1.md',
    },
  });
}

describe('useScheduledTaskRunner', () => {
  it('opens a due task in its project folder', async () => {
    const { bridge, queryClient } = renderRunner();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    bridge.$emit('scheduledTasks.onDue', task);

    await waitFor(() => expect(useTerminalStore.getState().sessions).toHaveLength(1));
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      cwd: 'C:\\code\\apollo',
      projectId: 'p1',
    });
    expect(toasts.success).toEqual(['Scheduled prompt started in Claude Code CLI']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['scheduled-tasks'] });
  });

  it('refreshes the lists when main changes tasks on its own', () => {
    const { bridge, queryClient } = renderRunner();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    bridge.$emit('scheduledTasks.onChanged');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['scheduled-tasks'] });
  });

  it('stops listening when unmounted', () => {
    const { bridge, unmount } = renderRunner();
    expect(bridge.$listenerCount('scheduledTasks.onDue')).toBe(1);

    unmount();

    expect(bridge.$listenerCount('scheduledTasks.onDue')).toBe(0);
    expect(bridge.$listenerCount('scheduledTasks.onChanged')).toBe(0);
  });
});
