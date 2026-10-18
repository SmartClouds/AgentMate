// @vitest-environment jsdom
import type { AppSettings } from '@agentmat/core';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonacoEditorProps } from '@/components/editor/MonacoEditor';
import { usePromptBuilderStore } from '@/stores/promptBuilderStore';
import { installFakeMicrophone } from '../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The microphones on the Prompt Builder page, the same pair the Build Prompt dialog has. Dictate
 * adds to the request in the language the chip shows; Speak prompt writes straight into the
 * generated prompt, always as English, and never goes near Generate or Translate.
 */

// Monaco needs workers and layout jsdom does not have; a textarea keeps the same contract.
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: MonacoEditorProps) => (
    <textarea
      aria-label="Generated prompt"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const { default: PromptBuilderPage } = await import('./PromptBuilderPage');

const SPOKEN = 'Add a dark mode toggle to the settings page';

function baseSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    promptBuilderProvider: 'openai',
    openaiModel: 'gpt-4o-mini',
    speechModel: 'base',
    speechLanguage: 'en',
    ...patch,
  } as AppSettings;
}

function renderPage(settings: AppSettings, bridge: Record<string, unknown> = {}) {
  const transcribe = vi.fn(async (_input: { language: string }) => ({ ok: true, text: SPOKEN }));
  const ask = vi.fn(async () => ({ ok: true, text: 'GENERATED' }));
  const translate = vi.fn(async () => 'TRANSLATED');
  const assessRun = vi.fn(async (_input: { prompt: string; promptType?: string }) => ({
    ok: false,
    error: 'not needed here',
  }));
  let current = settings;
  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    current = { ...current, ...patch };
    return current;
  });
  const view = renderWithProviders(<PromptBuilderPage />, {
    route: '/prompt-builder',
    bridge: {
      'settings.get': async () => current,
      'settings.update': update,
      'projects.list': [],
      'cli.detectAll': [],
      'speech.transcribe': transcribe,
      'ai.ask': ask,
      'ai.assessRun': assessRun,
      'translate.text': translate,
      ...bridge,
    },
  });
  return { ...view, transcribe, ask, translate, assessRun, update };
}

const output = () => screen.getByLabelText<HTMLTextAreaElement>('Generated prompt');
const requestBox = () => screen.getByLabelText<HTMLTextAreaElement>('Your request');
const speakButton = () => screen.getByRole('button', { name: 'Speak prompt' });
const dictateButton = () => screen.getByRole('button', { name: 'Dictate' });
const stopButton = () => screen.getByRole('button', { name: 'Stop and transcribe' });

beforeEach(() => {
  installFakeMicrophone();
  usePromptBuilderStore.setState({ rawInput: '', generated: '' });
});

describe('Speak prompt on the Prompt Builder page', () => {
  it('puts the words into the generated prompt as spoken, in English', async () => {
    const { user, transcribe, ask, translate } = renderPage(
      baseSettings({ speechLanguage: 'fa', speechModel: 'large-v3-turbo' }),
    );

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());

    await waitFor(() => expect(output()).toHaveValue(SPOKEN));
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }));
    expect(ask).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
    expect(requestBox()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
  });

  it('adds a second take after the first one', async () => {
    const { user, transcribe } = renderPage(baseSettings());
    transcribe
      .mockResolvedValueOnce({ ok: true, text: 'Add a login page.' })
      .mockResolvedValueOnce({ ok: true, text: 'Use OAuth.' });

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());
    await waitFor(() => expect(output()).toHaveValue('Add a login page.'));
    await user.click(speakButton());
    await user.click(stopButton());

    await waitFor(() => expect(output()).toHaveValue('Add a login page. Use OAuth.'));
  });

  it('sizes the spoken prompt without a prompt type, like a translation', async () => {
    const { user, assessRun } = renderPage(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    expect(assessRun.mock.calls[0]?.[0].prompt).toBe(SPOKEN);
    expect(assessRun.mock.calls[0]?.[0].promptType).toBeUndefined();
  });

  it('cannot start while Dictate is recording, and the other way round', async () => {
    const { user } = renderPage(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    expect(speakButton()).toBeDisabled();
    await user.click(stopButton());
    await waitFor(() => expect(speakButton()).toBeEnabled());

    await user.click(speakButton());
    expect(dictateButton()).toBeDisabled();
  });

  it('shows the clock and can be thrown away with Escape', async () => {
    const { user, transcribe } = renderPage(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    expect(screen.getByText('Stop 0:00')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(speakButton()).toBeEnabled());
    expect(transcribe).not.toHaveBeenCalled();
    expect(output()).toHaveValue('');
  });

  it('can stop a slow transcription, which stops the work in main too', async () => {
    const cancel = vi.fn(async () => undefined);
    const { user } = renderPage(baseSettings(), {
      'speech.transcribe': vi.fn(() => new Promise(() => undefined)),
      'speech.cancel': cancel,
    });

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());
    await screen.findByText('Writing down what you said…');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(speakButton()).toBeEnabled());
    expect(cancel).toHaveBeenCalledWith(expect.any(String));
    expect(screen.queryByText('Writing down what you said…')).not.toBeInTheDocument();
  });
});

describe('Dictate on the Prompt Builder page', () => {
  it('listens for the language the chip shows and writes into the request', async () => {
    const { user, transcribe } = renderPage(
      baseSettings({ speechLanguage: 'fa', speechModel: 'large-v3-turbo' }),
    );
    transcribe.mockResolvedValueOnce({ ok: true, text: 'یک صفحه ورود اضافه کن' });

    expect(
      await screen.findByRole('button', { name: 'Dictation language: Persian (فارسی)' }),
    ).toBeInTheDocument();
    await user.click(dictateButton());
    await user.click(stopButton());

    await waitFor(() => expect(requestBox()).toHaveValue('یک صفحه ورود اضافه کن'));
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'fa' }));
    expect(output()).toHaveValue('');
  });

  it('never sends the old "auto" setting to the model', async () => {
    const { user, transcribe } = renderPage(baseSettings({ speechLanguage: 'auto' }));

    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    await user.click(stopButton());

    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(transcribe.mock.calls[0]?.[0].language).not.toBe('auto');
  });

  it('saves a language picked from the chip', async () => {
    const { user, update } = renderPage(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Dictation language: English' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Persian (فارسی)' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ speechLanguage: 'fa' }));
    expect(
      await screen.findByRole('button', { name: 'Dictation language: Persian (فارسی)' }),
    ).toBeInTheDocument();
  });

  it('can be thrown away while transcribing with the button next to it', async () => {
    const cancel = vi.fn(async () => undefined);
    const { user } = renderPage(baseSettings(), {
      'speech.transcribe': vi.fn(() => new Promise(() => undefined)),
      'speech.cancel': cancel,
    });

    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    await user.click(stopButton());
    await user.click(await screen.findByRole('button', { name: 'Cancel transcription' }));

    expect(dictateButton()).toBeEnabled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
