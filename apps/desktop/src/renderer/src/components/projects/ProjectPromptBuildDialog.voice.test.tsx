// @vitest-environment jsdom
import type { AppSettings, Project } from '@agentmat/core';
import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeMicrophone,
  fakeMicTrack as track,
} from '../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectPromptBuildDialog } from './ProjectPromptBuildDialog';

/**
 * The two microphones in Build Prompt. Dictate adds to the request in the language the chip
 * shows; Speak prompt writes straight into the generated prompt, always as English, and never
 * goes near Generate or Translate. The microphone is the shared fake one.
 */

const project = {
  id: 'p1',
  name: 'Demo',
  folderPath: 'C:/demo',
  agentType: 'claude-code',
  cliId: null,
  iconDataUrl: null,
  iconFile: null,
  iconBgColor: null,
  iconColor: null,
} as Project;

const SPOKEN = 'Add a dark mode toggle to the settings page';

function baseSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    promptBuilderProvider: 'openai',
    openaiModel: 'gpt-4o-mini',
    promptBuilderAutoSize: false,
    speechModel: 'base',
    speechLanguage: 'en',
    ...patch,
  } as AppSettings;
}

function renderDialog(
  settings: AppSettings,
  bridge: Record<string, unknown> = {},
  onOpenChange: (open: boolean) => void = vi.fn(),
) {
  const transcribe = vi.fn(async (_input: { language: string }) => ({ ok: true, text: SPOKEN }));
  const ask = vi.fn(async () => ({ ok: true, text: 'GENERATED' }));
  const translate = vi.fn(async () => 'TRANSLATED');
  // Saved settings are what the next read answers with, the way the main process does it.
  let current = settings;
  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    current = { ...current, ...patch };
    return current;
  });
  const view = renderWithProviders(
    <ProjectPromptBuildDialog open onOpenChange={onOpenChange} projectId="p1" projectName="Demo" />,
    {
      bridge: {
        'settings.get': async () => current,
        'settings.update': update,
        'projects.list': [project],
        'cli.detectAll': [],
        'speech.transcribe': transcribe,
        'ai.ask': ask,
        'translate.text': translate,
        ...bridge,
      },
    },
  );
  return { ...view, transcribe, ask, translate, update };
}

const output = () => screen.getByLabelText<HTMLTextAreaElement>('Generated prompt');
const requestBox = () => screen.getByLabelText<HTMLTextAreaElement>('Your request');
const speakButton = () => screen.getByRole('button', { name: 'Speak prompt' });
const dictateButton = () => screen.getByRole('button', { name: 'Dictate' });
const stopButton = () => screen.getByRole('button', { name: 'Stop and transcribe' });

beforeEach(() => {
  installFakeMicrophone();
});

describe('Speak prompt', () => {
  it('puts the words into the generated prompt as spoken, in English', async () => {
    const { user, transcribe, ask, translate } = renderDialog(
      // Even with Dictate set to Persian, Speak prompt listens for English.
      baseSettings({ speechLanguage: 'fa', speechModel: 'large-v3-turbo' }),
    );

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());

    await waitFor(() => expect(output()).toHaveValue(SPOKEN));
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }));
    expect(ask).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
    // The request stays as it was; nothing was written there.
    expect(requestBox()).toHaveValue('');
    // What can be done with a generated prompt can be done with this one.
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Save draft/ })).toBeEnabled();
  });

  it('adds a second take after the first one', async () => {
    const { user, transcribe } = renderDialog(baseSettings());
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

  it('cannot start while Dictate is recording, and the other way round', async () => {
    const { user } = renderDialog(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    expect(speakButton()).toBeDisabled();
    await user.click(stopButton());
    await waitFor(() => expect(speakButton()).toBeEnabled());

    await user.click(speakButton());
    expect(dictateButton()).toBeDisabled();
  });

  it('shows the clock and can be thrown away with Escape without closing the dialog', async () => {
    const onOpenChange = vi.fn();
    const { user, transcribe } = renderDialog(baseSettings(), {}, onOpenChange);

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    expect(screen.getByText('Stop 0:00')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(speakButton()).toBeEnabled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(output()).toHaveValue('');
  });

  it('can be thrown away with the discard button', async () => {
    const { user, transcribe } = renderDialog(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(screen.getByRole('button', { name: 'Discard recording' }));

    expect(speakButton()).toBeEnabled();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('a transcription that takes a long time', () => {
  // The large model can take minutes on a long recording. The user is never stuck waiting.
  function slowBridge() {
    const cancel = vi.fn(async () => undefined);
    return {
      cancel,
      bridge: {
        'speech.transcribe': vi.fn(() => new Promise(() => undefined)),
        'speech.cancel': cancel,
      },
    };
  }

  it('can be cancelled from next to the mic, which stops the work in main', async () => {
    const { cancel, bridge } = slowBridge();
    const { user } = renderDialog(baseSettings(), bridge);

    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    await user.click(stopButton());
    await user.click(await screen.findByRole('button', { name: 'Cancel transcription' }));

    expect(dictateButton()).toBeEnabled();
    expect(cancel).toHaveBeenCalledWith(expect.any(String));
  });

  it('can be cancelled with Escape, and the dialog stays open', async () => {
    const onOpenChange = vi.fn();
    const { cancel, bridge } = slowBridge();
    const { user } = renderDialog(baseSettings(), bridge, onOpenChange);

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());
    await screen.findByText('Writing down what you said…');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(speakButton()).toBeEnabled());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('sizing a spoken prompt', () => {
  function renderSizing(autoSize: boolean) {
    const assessRun = vi.fn(async (_input: { prompt: string; promptType?: string }) => ({
      ok: false,
      error: 'not needed here',
    }));
    const view = renderDialog(baseSettings({ promptBuilderAutoSize: autoSize }), {
      'ai.assessRun': assessRun,
    });
    return { ...view, assessRun };
  }

  it('sizes it as soon as it lands when sizing is on, without a prompt type', async () => {
    const { user, assessRun } = renderSizing(true);

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    expect(assessRun.mock.calls[0]?.[0].prompt).toBe(SPOKEN);
    // It was never shaped by the prompt type, so the CLI is not told one.
    expect(assessRun.mock.calls[0]?.[0].promptType).toBeUndefined();
  });

  it('waits for the chip when sizing is off, and still leaves the prompt type out', async () => {
    const { user, assessRun } = renderSizing(false);

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    await user.click(stopButton());
    await waitFor(() => expect(output()).toHaveValue(SPOKEN));
    expect(assessRun).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Size run' }));

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    expect(assessRun.mock.calls[0]?.[0].promptType).toBeUndefined();
  });
});

describe('Dictate language', () => {
  it('listens for the language the chip shows', async () => {
    const { user, transcribe } = renderDialog(
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
    const { user, transcribe } = renderDialog(baseSettings({ speechLanguage: 'auto' }));

    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    await user.click(stopButton());

    await waitFor(() => expect(transcribe).toHaveBeenCalled());
    const language = transcribe.mock.calls[0]?.[0].language;
    expect(language).not.toBe('auto');
    expect(language).toMatch(/^[a-z]{2}$/);
  });

  it('saves a language picked from the chip', async () => {
    const { user, update } = renderDialog(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Dictation language: English' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Persian (فارسی)' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ speechLanguage: 'fa' }));
    expect(
      await screen.findByRole('button', { name: 'Dictation language: Persian (فارسی)' }),
    ).toBeInTheDocument();
  });

  it('warns that the small model gets Persian wrong and offers the large one', async () => {
    const { user, update } = renderDialog(baseSettings({ speechLanguage: 'fa' }));

    await user.click(
      await screen.findByRole('button', { name: 'Dictation language: Persian (فارسی)' }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: /Use a model that understands Persian/ }),
    );

    await waitFor(() => expect(update).toHaveBeenCalledWith({ speechModel: 'large-v3-turbo' }));
  });

  it('does not warn about English on the small model', async () => {
    const { user } = renderDialog(baseSettings());

    await user.click(await screen.findByRole('button', { name: 'Dictation language: English' }));

    await screen.findByRole('menuitemradio', { name: 'English' });
    expect(screen.queryByRole('menuitem', { name: /Use a model that understands/ })).toBeNull();
  });
});

describe('closing the dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(false)}>
          close from outside
        </button>
        <ProjectPromptBuildDialog
          open={open}
          onOpenChange={setOpen}
          projectId="p1"
          projectName="Demo"
        />
      </>
    );
  }

  it('lets go of the microphone Speak prompt was holding', async () => {
    const transcribe = vi.fn(async () => ({ ok: true, text: SPOKEN }));
    const { user } = renderWithProviders(<Harness />, {
      bridge: {
        'settings.get': baseSettings(),
        'projects.list': [project],
        'cli.detectAll': [],
        'speech.transcribe': transcribe,
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Speak prompt' }));
    track.stop.mockClear();
    // Radix makes everything outside the open dialog inert, so the outside button is clicked
    // the way a parent closing it programmatically would.
    screen.getByRole('button', { name: 'close from outside', hidden: true }).click();

    await waitFor(() => expect(track.stop).toHaveBeenCalled());
    // Stopping still transcribes, so what was said is kept for when the dialog opens again.
    await waitFor(() => expect(transcribe).toHaveBeenCalled());
  });
});
