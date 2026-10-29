import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, STEP_UP_REFUSAL } from '../overview/testing/fixtures';
import { signedIn } from '../security/testing/fixtures';
import { AssistantLauncher } from './AssistantLauncher';

/**
 * The Deploy AI drawer: opened from the corner button or a problem, it shows the core's mode,
 * starts a run with the context it was given, lets the user approve or skip what the AI
 * proposes, shows each step's output as text, and stops a run.
 */

const KEY = `deploy:${SERVER.id}`;

function bridge(extra: Record<string, unknown> = {}) {
  return {
    'deploy.access': signedIn(['admin']),
    'deployAssistant.getMode': { mode: 'approveEveryCommand', allowlist: ['docker ps'] },
    'deployAssistant.state': { running: false, progress: null, context: null, history: [] },
    'cli.detectAll': [],
    ...extra,
  };
}

function progress(phase: string, extra: Record<string, unknown> = {}) {
  act(() => {
    useDeployAssistantStore.getState().progress({
      serverId: SERVER.id,
      progress: { sessionId: KEY, phase: phase as never, step: 1, ...extra },
    });
  });
}

beforeEach(() => {
  useDeployAssistantStore.setState({ openServerId: null, draft: null, runs: {} });
});

describe('AssistantDrawer', () => {
  it('opens from the corner button and starts a run with the problem as context', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() =>
      useDeployAssistantStore.getState().open(SERVER.id, {
        prompt: 'Find out why it restarts.',
        context: { title: 'Crash loop: sender', containerId: 'sender-1' },
      }),
    );
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    expect(within(drawer).getByLabelText('Context')).toHaveTextContent('Crash loop: sender');
    expect(
      await within(drawer).findByRole('radio', { name: /Approve every command/ }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(within(drawer).getByLabelText('What should the AI look into?')).toHaveValue(
      'Find out why it restarts.',
    );
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      prompt: 'Find out why it restarts.',
      cliId: null,
      context: { title: 'Crash loop: sender', containerId: 'sender-1' },
    });

    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deploy AI' }));
    expect(await screen.findByRole('complementary', { name: 'Deploy AI' })).toBeInTheDocument();
  });

  it('asks to approve a proposed command, shows its output and the end', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    await screen.findByRole('complementary', { name: 'Deploy AI' });

    progress('thinking');
    expect(screen.getByRole('status')).toHaveTextContent('Working out the next step');
    progress('proposed', { command: 'systemctl restart nginx' });
    const approval = screen.getByRole('group', { name: 'Approve the command' });
    expect(approval).toHaveTextContent('systemctl restart nginx');
    await user.click(within(approval).getByRole('button', { name: 'Run it' }));
    expect(fake.$fn('deployAssistant.approve')).toHaveBeenCalledWith(SERVER.id);

    progress('running', { command: 'systemctl restart nginx' });
    act(() =>
      useDeployAssistantStore.getState().output({
        serverId: SERVER.id,
        command: 'systemctl restart nginx',
        lines: [{ stream: 'out', text: '<b>not html</b>' }],
      }),
    );
    const step = screen.getByRole('listitem', { name: 'Step 1: systemctl restart nginx' });
    expect(within(step).getByLabelText('Status')).toHaveTextContent('Running');
    expect(within(step).getByLabelText('Output of step 1')).toHaveTextContent('<b>not html</b>');
    expect(step.querySelector('b')).toBeNull();

    progress('finished', { message: 'nginx is back.' });
    expect(within(step).getByLabelText('Status')).toHaveTextContent('Done');
    expect(screen.getByRole('status')).toHaveTextContent('Finished: nginx is back.');
    expect(screen.getByLabelText('Ask a follow-up')).toBeInTheDocument();
  });

  it('skips, answers, continues and stops', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    await screen.findByRole('complementary', { name: 'Deploy AI' });

    progress('proposed', {
      command: 'rm -rf /',
      message: 'The server core runs only read-only checks without asking.',
    });
    expect(screen.getByRole('group', { name: 'Approve the command' })).toHaveTextContent(
      'read-only checks',
    );
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(fake.$fn('deployAssistant.skip')).toHaveBeenCalledWith(SERVER.id);
    progress('thinking');
    expect(screen.getByRole('listitem', { name: 'Step 1: rm -rf /' })).toHaveTextContent('Skipped');

    progress('needs-input', { message: 'Which site?' });
    await user.type(screen.getByLabelText('Your answer'), 'blog');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(fake.$fn('deployAssistant.answer')).toHaveBeenCalledWith(SERVER.id, 'blog');

    progress('error', { message: 'Paused: network down', canContinue: true });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(fake.$fn('deployAssistant.resume')).toHaveBeenCalledWith(SERVER.id);
    await user.click(screen.getAllByRole('button', { name: 'Stop' })[0] as HTMLElement);
    expect(fake.$fn('deployAssistant.stop')).toHaveBeenCalledWith(SERVER.id);
  });

  it('follows new steps and output to the end unless the user scrolled up', async () => {
    renderWithProviders(<AssistantLauncher server={SERVER} />, { bridge: bridge() });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    await screen.findByRole('complementary', { name: 'Deploy AI' });
    const body = screen.getByLabelText('Run');
    Object.defineProperty(body, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 400, configurable: true });

    progress('running', { command: 'docker ps' });
    expect(body.scrollTop).toBe(2000);

    const output = (text: string) =>
      act(() =>
        useDeployAssistantStore.getState().output({
          serverId: SERVER.id,
          command: 'docker ps',
          lines: [{ stream: 'out', text }],
        }),
      );
    output('first');
    const pre = screen.getByLabelText('Output of step 1');
    Object.defineProperty(pre, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(pre, 'clientHeight', { value: 190, configurable: true });
    output('second');
    expect(pre.scrollTop).toBe(900);

    // Scrolled up to read: new content leaves the view where it is.
    body.scrollTop = 300;
    fireEvent.scroll(body);
    pre.scrollTop = 100;
    fireEvent.scroll(pre);
    output('third');
    progress('thinking');
    expect(body.scrollTop).toBe(300);
    expect(pre.scrollTop).toBe(100);

    // Back at the end, it follows again.
    body.scrollTop = 1600;
    fireEvent.scroll(body);
    progress('proposed', { command: 'docker logs api' });
    expect(body.scrollTop).toBe(2000);
  });

  it('maximizes to fill the window and restores', async () => {
    const { user } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    expect(drawer).toHaveClass('w-[min(28rem,calc(100vw-1rem))]');

    await user.click(within(drawer).getByRole('button', { name: 'Maximize' }));
    expect(drawer).toHaveClass('w-[calc(100vw-1rem)]');
    const restore = within(drawer).getByRole('button', { name: 'Restore size' });
    expect(restore).toHaveAttribute('aria-pressed', 'true');

    await user.click(restore);
    expect(drawer).toHaveClass('w-[min(28rem,calc(100vw-1rem))]');
    expect(within(drawer).getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
  });

  it('asks for a step-up before auto-running diagnostics', async () => {
    let calls = 0;
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge({
        'deployAssistant.setMode': async () => {
          calls += 1;
          if (calls === 1) throw STEP_UP_REFUSAL;
          return { mode: 'autoRunDiagnostics', allowlist: [] };
        },
      }),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    await user.click(await screen.findByRole('radio', { name: /Auto-run diagnostics/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Password/), 'pw');
    await user.click(within(dialog).getByRole('button', { name: /Confirm|Continue/ }));
    expect(fake.$fn('deployAssistant.setMode')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      mode: 'autoRunDiagnostics',
      password: 'pw',
    });
    expect(await screen.findByRole('radio', { name: /Auto-run diagnostics/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('explains the role when the core refuses the AI', async () => {
    renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge({
        'deployAssistant.getMode': async () => {
          throw new Error('[core:forbidden] Your role on this server (viewer) cannot do that.');
        },
      }),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    expect(await screen.findByRole('alert')).toHaveTextContent('only an Admin');
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });
});

describe('AssistantComposer', () => {
  it('offers installed CLIs, starts with one on Ctrl+Enter and clears the draft', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge({
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
      }),
    });
    act(() =>
      useDeployAssistantStore.getState().open(SERVER.id, {
        prompt: 'Look.',
        context: { title: 'Disk' },
      }),
    );
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await user.click(within(drawer).getByLabelText('Which AI'));
    const option = await screen.findByRole('option', { name: /Claude/ });
    await user.click(option);
    await user.type(
      within(drawer).getByLabelText('What should the AI look into?'),
      '{Control>}{Enter}{/Control}',
    );
    expect(fake.$fn('deployAssistant.start')).toHaveBeenCalledWith(
      expect.objectContaining({ cliId: 'claude-code', prompt: 'Look.' }),
    );
    await user.click(within(drawer).getByRole('button', { name: 'Clear' }));
    expect(within(drawer).queryByLabelText('Context')).not.toBeInTheDocument();
  });

  it('keeps the task when the start is refused and picks up a run already going', async () => {
    renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge({
        'deployAssistant.start': async () => {
          throw new Error('[core:forbidden] Your role cannot do that.');
        },
        'deployAssistant.state': {
          running: true,
          progress: { sessionId: KEY, phase: 'needs-input', step: 2, message: 'Which unit?' },
          context: null,
          history: [],
        },
      }),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    expect(await screen.findByText('Which unit?')).toBeInTheDocument();
    act(() => useDeployAssistantStore.getState().close());
    expect(screen.getByRole('button', { name: 'Deploy AI, waiting for you' })).toHaveTextContent(
      'Waiting for you',
    );
  });
});
