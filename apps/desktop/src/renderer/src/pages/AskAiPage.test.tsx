import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AskAiMessage, useAskAiStore } from '@/stores/askAiStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The Ask AI page is a thin shell around the shared chat, so what is worth pinning down here is
 * the part the page owns (Clear history) plus the round trip a question makes through the
 * bridge. Everything goes through the UI and `window.runova`, never the component internals.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { default: AskAiPage } = await import('./AskAiPage');

/** Enough of the settings record for the chat to pick a model and skip the grammar check. */
const settings = {
  openaiApiKey: 'sk-test',
  openaiModel: 'gpt-4o',
  geminiApiKey: '',
  geminiModel: '',
  ollamaModel: '',
  grammar: { enabled: false, liveCheck: false },
};

function message(overrides: Partial<AskAiMessage> = {}): AskAiMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'What does this repo do?',
    provider: 'openai',
    model: 'gpt-4o',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function askBox(): HTMLElement {
  return screen.getByRole('textbox');
}

/**
 * The chat has no model until settings arrive, and sending without one is refused. The model
 * showing up in the picker is the same signal a user would wait for.
 */
async function waitForModel(): Promise<void> {
  await screen.findByText('gpt-4o');
}

const clearButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Clear history/ }) as HTMLButtonElement;

beforeEach(() => {
  // The store persists to localStorage, so a thread left by an earlier test would leak in.
  useAskAiStore.setState({ messages: [], openaiModel: '', geminiModel: '', ollamaModel: '' });
});

describe('AskAiPage with an empty thread', () => {
  it('renders the invitation to ask something and has nothing to clear', async () => {
    renderWithProviders(<AskAiPage />);

    expect(
      await screen.findByText('Ask anything, responses come straight from OpenAI.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Summarize what this project does' })).toBeTruthy();
    expect(clearButton().disabled).toBe(true);
  });

  it('drops a suggestion into the box so it can be sent as is', async () => {
    const { user } = renderWithProviders(<AskAiPage />, { bridge: { 'settings.get': settings } });

    await user.click(await screen.findByRole('button', { name: 'Help me write a commit message' }));

    expect((askBox() as HTMLTextAreaElement).value).toBe('Help me write a commit message');
  });
});

describe('AskAiPage with a thread', () => {
  it('shows both sides of the conversation and which model answered', async () => {
    useAskAiStore.setState({
      messages: [message(), message({ id: 'm2', role: 'assistant', content: 'It builds Runova.' })],
    });
    renderWithProviders(<AskAiPage />, { bridge: { 'settings.get': settings } });

    expect(await screen.findByText('What does this repo do?')).toBeTruthy();
    expect(screen.getByText('It builds Runova.')).toBeTruthy();
    expect(screen.getByText('OpenAI · gpt-4o')).toBeTruthy();
  });

  it('enables Clear history and empties the thread when it is pressed', async () => {
    useAskAiStore.setState({ messages: [message()] });
    const { user } = renderWithProviders(<AskAiPage />, { bridge: { 'settings.get': settings } });

    const clear = await screen.findByRole('button', { name: /Clear history/ });
    expect((clear as HTMLButtonElement).disabled).toBe(false);
    await user.click(clear);

    expect(screen.queryByText('What does this repo do?')).toBeNull();
    expect(
      await screen.findByText('Ask anything, responses come straight from OpenAI.'),
    ).toBeTruthy();
    expect(useAskAiStore.getState().messages).toEqual([]);
    expect(clearButton().disabled).toBe(true);
  });
});

describe('AskAiPage composer', () => {
  it('switches the provider from the pills under the question box', async () => {
    useAskAiStore.setState({ provider: 'openai' });
    const { user } = renderWithProviders(<AskAiPage />, { bridge: { 'settings.get': settings } });

    const providers = await screen.findByRole('group', { name: 'Provider' });
    expect(within(providers).getByRole('button', { name: 'OpenAI' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(providers).getByRole('button', { name: 'Gemini' }));

    expect(within(providers).getByRole('button', { name: 'Gemini' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      await screen.findByText('Ask anything, responses come straight from Gemini.'),
    ).toBeTruthy();
    useAskAiStore.setState({ provider: 'openai' });
  });

  it('sends with the round button inside the composer, once there is a question', async () => {
    const { user, bridge } = renderWithProviders(<AskAiPage />, {
      bridge: {
        'settings.get': settings,
        'ai.ask': async () => ({ ok: true, text: 'Sent by button.' }),
      },
    });
    await waitForModel();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(askBox(), 'Hello there');
    // Read again: the tooltip wraps a disabled button in a span, so the node is new.
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(bridge.$fn('ai.ask')).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Sent by button.')).toBeTruthy();
  });
});

describe('AskAiPage sending', () => {
  it('sends the question with the earlier turns as context and shows the answer', async () => {
    useAskAiStore.setState({
      messages: [
        message({ id: 'old-1', content: 'Hello' }),
        message({ id: 'old-2', role: 'assistant', content: 'Hi there.' }),
      ],
    });
    const { user, bridge } = renderWithProviders(<AskAiPage />, {
      bridge: {
        'settings.get': settings,
        'ai.ask': async () => ({ ok: true, text: 'It is an Electron desktop app.' }),
      },
    });

    await screen.findByText('Hi there.');
    await waitForModel();
    await user.type(askBox(), 'What is Runova?{Enter}');

    await waitFor(() =>
      expect(bridge.$fn('ai.ask')).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4o',
        prompt: 'What is Runova?',
        history: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there.' },
        ],
      }),
    );
    expect(await screen.findByText('It is an Electron desktop app.')).toBeTruthy();
    // The question stays on screen as a user bubble and the box is emptied for the next one.
    expect(screen.getByText('What is Runova?')).toBeTruthy();
    expect((askBox() as HTMLTextAreaElement).value).toBe('');
  });

  it('refuses to send before a model is chosen', async () => {
    // No settings answer at all, which is what the page sees before anything is configured.
    const { user } = renderWithProviders(<AskAiPage />);

    await user.type(askBox(), 'anyone there?{Enter}');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Choose a OpenAI model first.'));
    expect(useAskAiStore.getState().messages).toEqual([]);
  });

  it('shows the provider error as a message you can retry', async () => {
    let attempt = 0;
    const { user, bridge } = renderWithProviders(<AskAiPage />, {
      bridge: {
        'settings.get': settings,
        'ai.ask': async () => {
          attempt += 1;
          return attempt === 1
            ? { ok: false, error: 'Rate limit reached.' }
            : { ok: true, text: 'Second time lucky.' };
        },
      },
    });

    await waitForModel();
    await user.type(askBox(), 'Why is this failing?{Enter}');

    expect(await screen.findByText('Rate limit reached.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Retry/ }));

    expect(await screen.findByText('Second time lucky.')).toBeTruthy();
    expect(screen.queryByText('Rate limit reached.')).toBeNull();
    expect(bridge.$fn('ai.ask')).toHaveBeenCalledTimes(2);
  });
});
