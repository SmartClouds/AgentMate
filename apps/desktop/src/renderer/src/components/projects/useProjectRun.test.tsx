import type { Project, ProjectRunCommand } from '@runova/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  renderHookWithProviders,
  renderWithProviders,
} from '../../../../test/renderer/renderWithProviders';
import { useProjectRun } from './useProjectRun';

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const dev: ProjectRunCommand = { id: 'dev', label: 'Dev', command: 'pnpm dev' };
const prod: ProjectRunCommand = { id: 'prod', label: 'Prod', command: 'pnpm start' };

function project(runCommands: ProjectRunCommand[]): Project {
  return {
    id: 'p1',
    name: 'Apollo',
    folderPath: '/work/apollo',
    runCommands,
  } as unknown as Project;
}

function sessions() {
  return useTerminalStore.getState().sessions;
}

describe('useProjectRun', () => {
  it('runCommand runs the chosen command in a new terminal in the project folder', () => {
    const { result } = renderHookWithProviders(() => useProjectRun());

    act(() => result.current.runCommand(project([dev, prod]), prod));

    expect(sessions()).toHaveLength(1);
    expect(sessions()[0]).toMatchObject({
      title: 'Apollo',
      cwd: '/work/apollo',
      projectId: 'p1',
      // Enter included: the status bar follows a run, so it starts without another key press.
      initialInput: 'pnpm start\r',
    });
    expect(toast.info).toHaveBeenCalledWith('Running "Prod".');
  });

  it('marks the terminal as a run, so the status bar can list it', () => {
    const { result } = renderHookWithProviders(() => useProjectRun());

    act(() => result.current.runCommand(project([dev]), dev));

    expect(sessions()[0].run).toEqual({
      commandId: 'dev',
      label: 'Dev',
      command: 'pnpm dev',
      kind: 'web',
      startedAt: expect.any(Number),
    });
  });

  it('tells a mobile run apart from a web one', () => {
    const flutter: ProjectRunCommand = { id: 'app', label: '', command: 'flutter run' };
    const { result } = renderHookWithProviders(() => useProjectRun());

    act(() => result.current.runCommand(project([flutter]), flutter));

    // An unnamed command is listed by the command itself.
    expect(sessions()[0].run).toMatchObject({ kind: 'mobile', label: 'flutter run' });
  });

  it('requestRun runs the only command straight away', () => {
    const { result } = renderHookWithProviders(() => useProjectRun());

    act(() => result.current.requestRun(project([dev])));

    expect(sessions().map((s) => s.initialInput)).toEqual(['pnpm dev\r']);
  });

  it('requestRun calls onEmpty and opens nothing when there is no command', () => {
    const onEmpty = vi.fn();
    const { result } = renderHookWithProviders(() => useProjectRun());

    act(() => result.current.requestRun(project([]), { onEmpty }));

    expect(onEmpty).toHaveBeenCalledOnce();
    expect(sessions()).toHaveLength(0);
  });

  it('requestRun waits for a pick when there are several commands', () => {
    const { result } = renderHookWithProviders(() => useProjectRun());

    act(() => result.current.requestRun(project([dev, prod])));

    expect(sessions()).toHaveLength(0);
  });
});

/**
 * Mounts the hook the way the pages do: a Run button, with the picker rendered beside it.
 * `direct` runs one command the way the workspace menu does, skipping the list.
 */
function RunHost({
  target,
  direct,
}: {
  target: Project;
  direct?: ProjectRunCommand;
}): React.JSX.Element {
  const { requestRun, runCommand, runPicker } = useProjectRun();
  return (
    <>
      <button
        type="button"
        onClick={() => (direct ? runCommand(target, direct) : requestRun(target))}
      >
        Run
      </button>
      {runPicker}
    </>
  );
}

describe('run command picker', () => {
  it('lists each command by its environment, with the command under it', async () => {
    const { user } = renderWithProviders(<RunHost target={project([dev, prod])} />);

    await user.click(screen.getByRole('button', { name: 'Run' }));

    const dialog = await screen.findByRole('dialog', { name: 'Run command' });
    const devRow = within(dialog).getByRole('button', { name: /Dev/ });
    const prodRow = within(dialog).getByRole('button', { name: /Prod/ });
    expect(within(devRow).getByText('pnpm dev')).toBeTruthy();
    expect(within(prodRow).getByText('pnpm start')).toBeTruthy();
  });

  it('picking one runs it in a new terminal and closes the list', async () => {
    const { user } = renderWithProviders(<RunHost target={project([dev, prod])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await user.click(await screen.findByRole('button', { name: /Prod/ }));

    expect(sessions().map((s) => s.initialInput)).toEqual(['pnpm start\r']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape closes the list and runs nothing', async () => {
    const { user } = renderWithProviders(<RunHost target={project([dev, prod])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sessions()).toHaveLength(0);
  });

  it('returns focus to the Run button when the list is dismissed', async () => {
    const { user } = renderWithProviders(<RunHost target={project([dev, prod])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus());
  });
});

const ask: ProjectRunCommand = {
  id: 'serve',
  label: 'serve',
  command: 'pnpm dev -- --port {{port=3000}}',
};

describe('run commands with placeholders', () => {
  it('opens the form straight away for a single command, and starts no terminal yet', async () => {
    const { user } = renderWithProviders(<RunHost target={project([ask])} />);

    await user.click(screen.getByRole('button', { name: 'Run' }));

    const form = await screen.findByRole('dialog', { name: 'Run serve' });
    expect(within(form).getByRole('textbox', { name: 'Port' })).toHaveValue('3000');
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(form).queryByRole('button', { name: 'Back' })).toBeNull();
    expect(sessions()).toHaveLength(0);
  });

  it('runs the filled command, and names the run after its environment', async () => {
    const { user } = renderWithProviders(<RunHost target={project([ask])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('dialog', { name: 'Run serve' });
    const port = within(form).getByRole('textbox', { name: 'Port' });

    await user.clear(port);
    await user.type(port, '4000{Enter}');

    expect(sessions()).toHaveLength(1);
    expect(sessions()[0]).toMatchObject({
      initialInput: 'pnpm dev -- --port 4000\r',
      run: { commandId: 'serve', label: 'serve', command: 'pnpm dev -- --port 4000', kind: 'web' },
    });
    expect(toast.info).toHaveBeenCalledWith('Running "serve".');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names an unnamed run after the command it resolved to', async () => {
    const unnamed: ProjectRunCommand = {
      id: 'x',
      label: '',
      command: 'pnpm dev -- --port {{port=3000}}',
    };
    const { user } = renderWithProviders(<RunHost target={project([unnamed])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('dialog');

    await user.click(within(form).getByRole('button', { name: 'Run' }));

    expect(sessions()[0]?.run?.label).toBe('pnpm dev -- --port 3000');
    expect(toast.info).toHaveBeenCalledWith('Running "pnpm dev -- --port 3000".');
  });

  it('opens the form from a list pick, and Back returns to the list with that entry focused', async () => {
    const { user } = renderWithProviders(<RunHost target={project([dev, ask])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(await screen.findByRole('button', { name: /serve/ }));

    const form = await screen.findByRole('dialog', { name: 'Run serve' });
    await user.click(within(form).getByRole('button', { name: 'Back' }));

    const list = await screen.findByRole('dialog', { name: 'Run command' });
    expect(within(list).getByRole('button', { name: /serve/ })).toHaveFocus();
    expect(sessions()).toHaveLength(0);
  });

  it('Cancel closes the form without running, and returns focus to the Run button', async () => {
    const { user } = renderWithProviders(<RunHost target={project([ask])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sessions()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus();
  });

  it('Escape closes the form without running, and returns focus to the Run button', async () => {
    const { user } = renderWithProviders(<RunHost target={project([ask])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('dialog', { name: 'Run serve' });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sessions()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus();
  });

  it('a command run directly, as the workspace menu does, opens the form without Back', async () => {
    const { user } = renderWithProviders(<RunHost target={project([ask])} direct={ask} />);

    await user.click(screen.getByRole('button', { name: 'Run' }));

    const form = await screen.findByRole('dialog', { name: 'Run serve' });
    expect(within(form).queryByRole('button', { name: 'Back' })).toBeNull();
    expect(sessions()).toHaveLength(0);
  });

  it('lists a templated command with its placeholders named, and a cue that it asks for input', async () => {
    const { user } = renderWithProviders(<RunHost target={project([dev, ask])} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));

    const list = await screen.findByRole('dialog', { name: 'Run command' });
    const serve = within(list).getByRole('button', { name: /serve/ });
    expect(within(serve).getByText('pnpm dev -- --port <port>')).toBeTruthy();
    expect(within(serve).getByText('Asks for input')).toBeTruthy();
    expect(
      within(within(list).getByRole('button', { name: /Dev/ })).queryByText('Asks for input'),
    ).toBeNull();
  });
});
