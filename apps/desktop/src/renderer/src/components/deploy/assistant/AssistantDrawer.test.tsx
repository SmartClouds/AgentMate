import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_AI, useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, STEP_UP_REFUSAL } from '../overview/testing/fixtures';
import { signedIn } from '../security/testing/fixtures';
import { CONTINUE_PROMPT } from './AssistantComposer';
import { AssistantLauncher, AssistantTopBarButton } from './AssistantLauncher';

/**
 * The Deploy AI drawer: opened from the corner button or a problem, it shows the core's mode,
 * starts a run with the context it was given, lets the user approve or skip what the AI
 * proposes, shows each step's output as text, and stops a run.
 */

const KEY = `deploy:${SERVER.id}`;

/** A Deploy server page with the top bar's button, as the app shell puts them together. */
function Page() {
  return (
    <>
      <AssistantTopBarButton />
      <AssistantLauncher server={SERVER} />
    </>
  );
}

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
  useDeployAssistantStore.setState({
    openServerId: null,
    pageServerId: null,
    draft: null,
    runs: {},
    ai: SETTINGS_AI,
    projects: {},
  });
});

describe('AssistantDrawer', () => {
  it('opens from the corner button and starts a run with the problem as context', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
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

  it('puts its button in the top bar only while a server page is open, as a toggle', async () => {
    const { user, unmount } = renderWithProviders(<Page />, { bridge: bridge() });
    const button = await screen.findByRole('button', { name: 'Deploy AI' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(useDeployAssistantStore.getState().pageServerId).toBe(SERVER.id);

    await user.click(button);
    expect(await screen.findByRole('complementary', { name: 'Deploy AI' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    // The button stays where it is while the drawer is open, and closes it again.
    await user.click(button);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();

    unmount();
    expect(useDeployAssistantStore.getState().pageServerId).toBeNull();
    renderWithProviders(<AssistantTopBarButton />, { bridge: bridge() });
    expect(screen.queryByRole('button', { name: /Deploy AI/ })).not.toBeInTheDocument();
  });

  it('opens inside the page area, under the top bar, when the app shell is there', async () => {
    const island = document.createElement('div');
    island.setAttribute('data-page-island', '');
    document.body.append(island);
    try {
      renderWithProviders(<Page />, { bridge: bridge() });
      act(() => useDeployAssistantStore.getState().open(SERVER.id));
      const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
      expect(island).toContainElement(drawer);
      expect(drawer).toHaveClass('absolute');
      expect(drawer).not.toHaveClass('fixed');
    } finally {
      island.remove();
    }
  });

  it('asks to approve a proposed command, shows its output and the end', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
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
    const { user, bridge: fake } = renderWithProviders(<Page />, {
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
    renderWithProviders(<Page />, { bridge: bridge() });
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

  it('carries a stopped run on with Continue, keeping what came before', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    await user.type(
      within(drawer).getByLabelText('What should the AI look into?'),
      'Why does the sender restart?',
    );
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(within(drawer).getByLabelText('You asked')).toHaveTextContent(
      'Why does the sender restart?',
    );
    expect(within(drawer).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();

    progress('running', { command: 'docker ps' });
    expect(within(drawer).getByRole('button', { name: 'New chat' })).toBeDisabled();
    await user.click(within(drawer).getByRole('button', { name: 'Stop' }));
    expect(fake.$fn('deployAssistant.stop')).toHaveBeenCalledWith(SERVER.id);
    progress('stopped', { message: 'Stopped by user.' });

    await user.click(within(drawer).getByRole('button', { name: 'Continue' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      prompt: CONTINUE_PROMPT,
      cliId: null,
      continuePrevious: true,
    });
    const earlier = within(drawer).getByRole('region', { name: 'Earlier run' });
    expect(within(earlier).getByLabelText('You asked')).toHaveTextContent('sender restart');
    expect(
      within(earlier).getByRole('listitem', { name: 'Step 1: docker ps' }),
    ).toBeInTheDocument();
    expect(earlier).toHaveTextContent('Stopped: Stopped by user.');
    expect(within(drawer).getAllByLabelText('You asked').at(-1)).toHaveTextContent(CONTINUE_PROMPT);

    progress('finished', { message: 'It runs out of memory.' });
    expect(within(drawer).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    await user.type(within(drawer).getByLabelText('Ask a follow-up'), 'How much does it use?');
    await user.click(within(drawer).getByRole('button', { name: 'Ask' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: 'How much does it use?', continuePrevious: true }),
    );
    expect(within(drawer).getAllByRole('region', { name: 'Earlier run' })).toHaveLength(2);
  });

  it('starts a new chat that leaves the last one behind', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge(),
    });
    act(() =>
      useDeployAssistantStore.getState().open(SERVER.id, {
        prompt: 'Look at the sender.',
        context: { title: 'Crash loop: sender' },
      }),
    );
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    expect(within(drawer).queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    progress('running', { command: 'docker ps' });
    progress('finished', { message: 'Done.' });

    await user.click(within(drawer).getByRole('button', { name: 'New chat' }));
    expect(within(drawer).queryByLabelText('You asked')).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(drawer).queryByLabelText('Context')).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();

    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'Disk?');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      prompt: 'Disk?',
      cliId: null,
    });
  });

  it('puts the chat back when a follow-up is refused', async () => {
    const { user } = renderWithProviders(<Page />, {
      bridge: bridge({
        'deployAssistant.start': async () => {
          throw new Error('[core:forbidden] Your role cannot do that.');
        },
      }),
    });
    act(() => {
      useDeployAssistantStore.getState().open(SERVER.id);
      useDeployAssistantStore.getState().reset(SERVER.id, 'First');
    });
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    progress('stopped', { message: 'Stopped by user.' });
    await user.click(within(drawer).getByRole('button', { name: 'Continue' }));
    expect(within(drawer).queryByRole('region', { name: 'Earlier run' })).not.toBeInTheDocument();
    expect(within(drawer).getByLabelText('You asked')).toHaveTextContent('First');
    expect(within(drawer).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('takes a message mid-run and shows it between the steps until the AI reads it', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge({ 'deployAssistant.message': async () => true }),
    });
    act(() => {
      useDeployAssistantStore.getState().open(SERVER.id);
      useDeployAssistantStore.getState().reset(SERVER.id, 'Free some disk');
    });
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    progress('running', { command: 'df -h' });

    const box = within(drawer).getByLabelText('Message the AI');
    expect(box).toBeEnabled();
    expect(within(drawer).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.type(box, 'Leave the database alone');
    await user.click(within(drawer).getByRole('button', { name: 'Send message' }));
    expect(fake.$fn('deployAssistant.message')).toHaveBeenCalledWith(
      SERVER.id,
      'Leave the database alone',
    );
    expect(box).toHaveValue('');

    progress('running', { command: 'df -h', queuedMessages: 1 });
    const said = within(drawer).getByRole('listitem', { name: 'You said' });
    expect(said).toHaveTextContent('Leave the database alone');
    expect(said).toHaveTextContent('Not read yet');
    // It sits after the step that was going when it was sent.
    const items = within(within(drawer).getByRole('list', { name: 'Steps' })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Step 1: df -h',
      'You said',
    ]);

    // Read: the note goes. Ctrl+Enter sends too.
    progress('thinking', { step: 2 });
    expect(said).not.toHaveTextContent('Not read yet');
    await user.type(box, 'And the logs{Control>}{Enter}{/Control}');
    expect(fake.$fn('deployAssistant.message')).toHaveBeenLastCalledWith(SERVER.id, 'And the logs');
  });

  it('says what a message does while a command or a question waits', async () => {
    const { user } = renderWithProviders(<Page />, {
      bridge: bridge({ 'deployAssistant.message': async () => false }),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });

    progress('proposed', { command: 'rm -rf /tmp/cache' });
    expect(drawer).toHaveTextContent('Sending skips the command waiting for you');
    // The run ended in between: the text stays and nothing shows as sent.
    await user.type(within(drawer).getByLabelText('Message the AI'), 'Not that one');
    await user.click(within(drawer).getByRole('button', { name: 'Send message' }));
    expect(within(drawer).getByLabelText('Message the AI')).toHaveValue('Not that one');
    expect(within(drawer).queryByRole('listitem', { name: 'You said' })).not.toBeInTheDocument();

    progress('needs-input', { message: 'Which unit?' });
    expect(within(drawer).getByLabelText('Message the AI')).toBeDisabled();
    expect(drawer).toHaveTextContent('Answer the question above to carry on');
  });

  it('maximizes to fill the window and restores', async () => {
    const { user } = renderWithProviders(<Page />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    expect(drawer).toHaveClass('w-[min(28rem,calc(100%-1rem))]');

    await user.click(within(drawer).getByRole('button', { name: 'Maximize' }));
    expect(drawer).toHaveClass('w-[calc(100%-1rem)]');
    const restore = within(drawer).getByRole('button', { name: 'Restore size' });
    expect(restore).toHaveAttribute('aria-pressed', 'true');

    await user.click(restore);
    expect(drawer).toHaveClass('w-[min(28rem,calc(100%-1rem))]');
    expect(within(drawer).getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
  });

  it('asks for a step-up before auto-running diagnostics', async () => {
    let calls = 0;
    const { user, bridge: fake } = renderWithProviders(<Page />, {
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
    renderWithProviders(<Page />, {
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
    const { user, bridge: fake } = renderWithProviders(<Page />, {
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
    renderWithProviders(<Page />, {
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
    expect(screen.getByRole('button', { name: 'Deploy AI, waiting for you' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('offers the model once a CLI is picked and the effort once a model is', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge({ 'cli.detectAll': [{ id: 'claude-code', installed: true }] }),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    const settings = within(drawer).getByRole('group', { name: 'AI to use' });

    // The Settings provider has no model or effort to pick.
    expect(within(settings).getByLabelText('Which AI')).toHaveTextContent('AI provider (Settings)');
    expect(within(settings).queryByLabelText('Model')).not.toBeInTheDocument();
    expect(within(settings).queryByLabelText('Effort')).not.toBeInTheDocument();

    await user.click(within(settings).getByLabelText('Which AI'));
    await user.click(await screen.findByRole('option', { name: /Claude/ }));
    expect(within(settings).getByLabelText('Model')).toHaveTextContent('CLI default');
    // Effort only goes with a model the flags can name.
    expect(within(settings).queryByLabelText('Effort')).not.toBeInTheDocument();

    await user.click(within(settings).getByLabelText('Model'));
    await user.click(await screen.findByRole('option', { name: /Sonnet/ }));
    expect(within(settings).getByLabelText('Model')).toHaveTextContent('Sonnet');
    expect(within(settings).getByLabelText('Effort')).toHaveTextContent('Medium');
    await user.click(within(settings).getByLabelText('Effort'));
    await user.click(await screen.findByRole('option', { name: 'Extra high' }));

    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'Disk?');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      prompt: 'Disk?',
      cliId: 'claude-code',
      modelId: 'sonnet',
      effort: 'xhigh',
    });

    // Back to the default model, the effort goes with it.
    progress('finished', { message: 'Fine.' });
    await user.click(within(settings).getByLabelText('Model'));
    await user.click(await screen.findByRole('option', { name: 'CLI default' }));
    expect(within(settings).queryByLabelText('Effort')).not.toBeInTheDocument();
    await user.click(within(settings).getByLabelText('Which AI'));
    await user.click(await screen.findByRole('option', { name: 'AI provider (Settings)' }));
    expect(within(settings).queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('keeps the AI picked for the next time the drawer opens', async () => {
    const { user } = renderWithProviders(<Page />, {
      bridge: bridge({ 'cli.detectAll': [{ id: 'claude-code', installed: true }] }),
    });
    act(() => {
      useDeployAssistantStore
        .getState()
        .setAi({ cliId: 'claude-code', modelId: 'opus', effort: 'high' });
      useDeployAssistantStore.getState().open(SERVER.id);
    });
    let drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    expect(await within(drawer).findByLabelText('Model')).toHaveTextContent('Opus');
    expect(within(drawer).getByLabelText('Effort')).toHaveTextContent('High');

    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Deploy AI' }));
    drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    expect(within(drawer).getByLabelText('Which AI')).toHaveTextContent('Claude');
    expect(within(drawer).getByLabelText('Model')).toHaveTextContent('Opus');
  });

  it('falls back to the Settings provider when the CLI picked last is gone', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge({ 'cli.detectAll': [{ id: 'claude-code', installed: false }] }),
    });
    act(() => {
      useDeployAssistantStore
        .getState()
        .setAi({ cliId: 'claude-code', modelId: 'opus', effort: 'high' });
      useDeployAssistantStore
        .getState()
        .open(SERVER.id, { prompt: 'Look.', context: { title: 'x' } });
    });
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    expect(within(drawer).getByLabelText('Which AI')).toHaveTextContent('AI provider (Settings)');
    expect(within(drawer).queryByLabelText('Model')).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ modelId: expect.anything() }),
    );
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith(
      expect.objectContaining({ cliId: null }),
    );
  });

  it('lets a CLI work in a project, read only unless the user allows edits', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge({
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
        'projects.list': [{ id: 'shop', name: 'Shop', folderPath: 'C:/code/shop' }],
      }),
    });
    act(() => useDeployAssistantStore.getState().open(SERVER.id));
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });

    // The Settings provider cannot open files, so there is no project to pick.
    expect(within(drawer).queryByLabelText('Project for the code')).not.toBeInTheDocument();
    await user.click(within(drawer).getByLabelText('Which AI'));
    await user.click(await screen.findByRole('option', { name: /Claude/ }));

    const picker = within(drawer).getByLabelText('Project for the code');
    expect(picker).toHaveTextContent('None');
    expect(within(drawer).queryByRole('radiogroup', { name: /may do with the code/ })).toBeNull();
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Shop' }));

    const access = within(drawer).getByRole('radiogroup', {
      name: 'What the AI may do with the code',
    });
    expect(within(access).getByRole('radio', { name: 'Read only' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(drawer).toHaveTextContent('The AI can read C:/code/shop but not change it.');
    await user.click(within(access).getByRole('radio', { name: 'Read and edit' }));
    expect(drawer).toHaveTextContent('Edits go straight into C:/code/shop. Commit first');

    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'Fix mail');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      prompt: 'Fix mail',
      cliId: 'claude-code',
      project: { projectId: 'shop', allowEdits: true },
    });

    // Locked while the run goes.
    progress('running', { command: 'docker ps' });
    expect(within(drawer).getByLabelText('Project for the code')).toBeDisabled();
    expect(within(access).getByRole('radio', { name: 'Read only' })).toBeDisabled();

    // Back on the Settings provider, the project stays chosen but is not sent.
    progress('finished', { message: 'Done.' });
    await user.click(within(drawer).getByLabelText('Which AI'));
    await user.click(await screen.findByRole('option', { name: 'AI provider (Settings)' }));
    expect(within(drawer).queryByLabelText('Project for the code')).not.toBeInTheDocument();
    await user.type(within(drawer).getByLabelText('Ask a follow-up'), 'And now?');
    await user.click(within(drawer).getByRole('button', { name: 'Ask' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ project: expect.anything() }),
    );
    expect(useDeployAssistantStore.getState().projects[SERVER.id]).toEqual({
      projectId: 'shop',
      allowEdits: true,
    });
  });

  it('keeps the project per server and drops one Runova no longer has', async () => {
    const { user, bridge: fake } = renderWithProviders(<Page />, {
      bridge: bridge({
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
        'projects.list': [{ id: 'shop', name: 'Shop', folderPath: 'C:/code/shop' }],
      }),
    });
    act(() => {
      const store = useDeployAssistantStore.getState();
      store.setAi({ cliId: 'claude-code', modelId: null, effort: null });
      store.setProject('other-server', { projectId: 'shop', allowEdits: true });
      store.setProject(SERVER.id, { projectId: 'deleted', allowEdits: true });
      store.open(SERVER.id, { prompt: 'Look.', context: { title: 'x' } });
    });
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    await within(drawer).findByRole('radio', { name: /Approve every command/ });
    expect(await within(drawer).findByLabelText('Project for the code')).toHaveTextContent('None');
    expect(drawer).not.toHaveTextContent('Edits go straight into');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ project: expect.anything() }),
    );
  });
});
