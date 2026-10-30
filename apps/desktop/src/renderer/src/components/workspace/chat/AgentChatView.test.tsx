import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChatStore } from '@/stores/agentChatStore';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import type { WorkspaceTerminalTab } from '@/stores/workspaceStore';
import { installFakeMicrophone } from '../../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AgentChatView } from './AgentChatView';

const runtime = vi.hoisted(() => ({ insertText: vi.fn((_id: string, _text: string) => true) }));
vi.mock('@/lib/terminal/terminalRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminal/terminalRuntime')>();
  return { ...actual, terminalRuntime: { ...actual.terminalRuntime, ...runtime } };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const tab: WorkspaceTerminalTab = {
  kind: 'terminal',
  id: 'tab-1',
  title: 'Claude Code',
  cliId: 'claude-code',
  cwd: 'E:\\proj',
  createdAt: 1_000,
};

const line = (value: unknown) => JSON.stringify(value);
const transcript = [
  line({ type: 'user', uuid: 'u1', message: { content: 'fix the header' } }),
  line({
    type: 'assistant',
    uuid: 'a1',
    message: { content: [{ type: 'thinking', thinking: 'Check the CSS first.' }] },
  }),
  line({
    type: 'assistant',
    uuid: 'a2',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }],
    },
  }),
  line({
    type: 'user',
    uuid: 'u2',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '12 passed' }] },
  }),
  line({
    type: 'assistant',
    uuid: 'a3',
    message: { content: [{ type: 'text', text: 'Fixed it in **header.css**.' }] },
  }),
];

function renderChat(
  bridge: Record<string, unknown> = {},
  props: Partial<Parameters<typeof AgentChatView>[0]> = {},
) {
  const onShowCli = vi.fn();
  const view = renderWithProviders(
    <AgentChatView projectId="p1" tab={tab} focused onShowCli={onShowCli} {...props} />,
    {
      bridge: {
        'agentChat.subscribe': { status: 'ready', lines: transcript },
        'settings.get': { speechLanguage: 'fa', speechModel: 'large-v3-turbo' },
        ...bridge,
      },
    },
  );
  const field = () => screen.getByRole('textbox', { name: 'Message to Claude Code' });
  return { ...view, onShowCli, field };
}

beforeEach(() => {
  installFakeMicrophone();
  runtime.insertText.mockReset().mockReturnValue(true);
});

describe('AgentChatView', () => {
  it('shows the conversation as messages, thinking and tool cards', async () => {
    renderChat();
    const region = await screen.findByRole('region', { name: 'Claude Code chat' });
    expect(await within(region).findByText('fix the header')).toBeInTheDocument();
    expect(within(region).getByText('header.css').tagName).toBe('STRONG');
    expect(within(region).getByRole('button', { name: /Thinking/ })).toBeInTheDocument();
    const tool = within(region).getByRole('button', { name: /pnpm test/ });
    expect(tool).toHaveAttribute('data-status', 'ok');
  });

  it('opens a tool card to show what the tool returned', async () => {
    const { user } = renderChat();
    const tool = await screen.findByRole('button', { name: /pnpm test/ });
    expect(screen.queryByText('12 passed')).not.toBeInTheDocument();
    await user.click(tool);
    expect(screen.getByText('12 passed')).toBeInTheDocument();
  });

  it('says when the CLI has not started the conversation yet', async () => {
    renderChat({ 'agentChat.subscribe': { status: 'waiting' } });
    expect(await screen.findByText(/Waiting for Claude Code/)).toBeInTheDocument();
  });

  it('keeps reading while the chat is open and stops when it closes', async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const { bridge, unmount } = renderChat({ 'agentChat.unsubscribe': unsubscribe });
    await screen.findByText('fix the header');
    act(() =>
      bridge.$emit('agentChat.onAppend', {
        sessionId: 'tab-1',
        lines: [line({ type: 'user', uuid: 'u9', message: { content: 'and the footer' } })],
        reset: false,
      }),
    );
    expect(screen.getByText('and the footer')).toBeInTheDocument();
    unmount();
    expect(unsubscribe).toHaveBeenCalledWith('tab-1');
  });

  it('sends a message to the CLI on Enter, then submits it', async () => {
    const { user, field, bridge } = renderChat();
    await user.type(field(), 'add a test{Enter}');
    expect(runtime.insertText).toHaveBeenCalledWith('tab-1', 'add a test');
    await vi.waitFor(() =>
      expect(bridge.$fn('terminal.write')).toHaveBeenCalledWith('tab-1', '\r'),
    );
    expect(field()).toHaveValue('');
  });

  it('starts a new line on Shift+Enter instead of sending', async () => {
    const { user, field } = renderChat();
    await user.type(field(), 'one{Shift>}{Enter}{/Shift}two');
    expect(runtime.insertText).not.toHaveBeenCalled();
    expect(field()).toHaveValue('one\ntwo');
  });

  it('keeps the message when the CLI is not ready for it', async () => {
    runtime.insertText.mockReturnValue(false);
    const { user, field } = renderChat();
    await user.type(field(), 'hello{Enter}');
    expect(await screen.findByText(/isn't ready for a message yet/)).toBeInTheDocument();
    expect(field()).toHaveValue('hello');
  });

  it('keeps an unsent message for the tab when the view closes', async () => {
    const { user, field, unmount } = renderChat();
    await user.type(field(), 'half written');
    unmount();
    expect(useAgentChatStore.getState().drafts['tab-1']).toBe('half written');
  });

  it('has the dictation, translation and rewrite tools of the prompt box', async () => {
    const { user, field } = renderChat();
    expect(await screen.findByRole('button', { name: /Dictate/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write it for me' })).toBeInTheDocument();
    await user.type(field(), 'سلام');
    expect(screen.getByRole('button', { name: 'Translate to English' })).toBeInTheDocument();
  });

  it('stops the agent while it works', async () => {
    useAgentStatusStore.setState({ statuses: { 'tab-1': 'working' } });
    const { user, bridge } = renderChat();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(bridge.$fn('terminal.write')).toHaveBeenCalledWith('tab-1', '\x1b');
  });

  it('answers a question the CLI is asking, or shows the CLI for it', async () => {
    useAgentStatusStore.setState({ statuses: { 'tab-1': 'needs-input' } });
    const { user, bridge, onShowCli } = renderChat();
    const card = await screen.findByRole('alert');
    expect(card).toHaveTextContent('Claude Code is asking you something');

    await user.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(bridge.$fn('terminal.write')).toHaveBeenLastCalledWith('tab-1', '\r');
    await user.click(within(card).getByRole('button', { name: 'Deny' }));
    expect(bridge.$fn('terminal.write')).toHaveBeenLastCalledWith('tab-1', '\x1b');
    await user.click(within(card).getByRole('button', { name: 'Show in CLI' }));
    expect(onShowCli).toHaveBeenCalled();
  });

  it('copies a message', async () => {
    const { user } = renderChat();
    await screen.findByText('fix the header');
    const [prompt, reply] = screen.getAllByRole('button', { name: 'Copy message' });
    await user.click(reply);
    expect(await navigator.clipboard.readText()).toBe('Fixed it in **header.css**.');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await user.click(prompt);
    expect(await navigator.clipboard.readText()).toBe('fix the header');
  });

  it('shows a message sent while the agent works as queued until the CLI takes it', async () => {
    useAgentStatusStore.setState({ statuses: { 'tab-1': 'working' } });
    const { user, field, bridge } = renderChat();
    await screen.findByText('fix the header');
    await user.type(field(), 'and the footer{Enter}');
    expect(runtime.insertText).toHaveBeenCalledWith('tab-1', 'and the footer');
    const queued = screen.getByText('and the footer').closest('[data-pending]');
    expect(queued).toHaveTextContent('Queued');

    act(() =>
      bridge.$emit('agentChat.onAppend', {
        sessionId: 'tab-1',
        lines: [
          line({
            type: 'attachment',
            uuid: 'q1',
            attachment: {
              type: 'queued_command',
              prompt: 'and the footer',
              origin: { kind: 'human' },
            },
          }),
        ],
        reset: false,
      }),
    );
    expect(screen.getAllByText('and the footer')).toHaveLength(1);
    expect(document.querySelector('[data-pending]')).toBeNull();
  });

  it('attaches a pasted image and sends its path with the message', async () => {
    const saveImage = vi.fn(async () => 'C:\\pasted\\shot.png');
    const { user, field } = renderChat({
      'shell.pathForFile': () => '',
      'terminalClipboard.saveImage': saveImage,
      'terminalClipboard.previewImage': async () => 'data:image/png;base64,x',
    });
    const image = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    fireEvent.paste(field(), {
      clipboardData: { files: [image], getData: () => '', types: ['Files'] },
    });
    const chip = await screen.findByRole('img', { name: 'shot.png' });
    expect(chip).toHaveAttribute('src', 'data:image/png;base64,x');
    expect(saveImage).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/png');

    await user.type(field(), 'what is wrong here?{Enter}');
    const sent = runtime.insertText.mock.calls[0]?.[1] ?? '';
    expect(sent).toContain('C:\\pasted\\shot.png');
    expect(sent.endsWith(' what is wrong here?')).toBe(true);
    expect(screen.queryByRole('img', { name: 'shot.png' })).not.toBeInTheDocument();
  });

  it('reads a screenshot the paste event cannot carry from the clipboard', async () => {
    const { field } = renderChat({
      'terminalClipboard.read': { kind: 'files', paths: ['C:\\pasted\\screen.png'] },
      'terminalClipboard.previewImage': async () => 'data:image/png;base64,y',
    });
    fireEvent.paste(field(), { clipboardData: { files: [], getData: () => '', types: [] } });
    expect(await screen.findByRole('img', { name: 'screen.png' })).toBeInTheDocument();
  });

  it('lets an attached image be removed before sending', async () => {
    const { user, field } = renderChat({
      'terminalClipboard.read': { kind: 'files', paths: ['C:\\pasted\\screen.png'] },
      'terminalClipboard.previewImage': async () => 'data:image/png;base64,y',
    });
    fireEvent.paste(field(), { clipboardData: { files: [], getData: () => '', types: [] } });
    await user.click(await screen.findByRole('button', { name: 'Remove screen.png' }));
    expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument();
  });

  it('marks a prompt that was sent with images', async () => {
    renderChat({
      'agentChat.subscribe': {
        status: 'ready',
        lines: [
          line({
            type: 'user',
            uuid: 'u1',
            message: {
              content: [
                { type: 'image', source: { type: 'base64', data: 'x' } },
                { type: 'text', text: 'like this' },
              ],
            },
          }),
        ],
      },
    });
    expect(await screen.findByText('like this')).toBeInTheDocument();
    expect(screen.getByText('1 image')).toBeInTheDocument();
  });

  it('offers a way back to the newest message once scrolled up', async () => {
    const { bridge, user } = renderChat();
    const log = await screen.findByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 });
    const scrollTo = vi.fn();
    log.scrollTo = scrollTo;
    log.scrollTop = 100;
    act(() => log.dispatchEvent(new Event('scroll')));
    act(() =>
      bridge.$emit('agentChat.onAppend', {
        sessionId: 'tab-1',
        lines: [line({ type: 'user', uuid: 'u9', message: { content: 'more' } })],
        reset: false,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2000 }));
  });
});
