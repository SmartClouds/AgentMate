import {
  createScene,
  type NarrationJobView,
  type StudioDocument,
  type VoiceEngineView,
  type VoiceProfileView,
} from '@runova/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMicrophone } from '../../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { VoiceKeysFields } from '../settings/VoiceKeysFields';
import { document, NOW, status } from '../testing/fixtures';
import { VoicePanel } from './VoicePanel';
import { VoiceProfilesDialog } from './VoiceProfilesDialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  toast.success.mockClear();
  toast.error.mockClear();
  installFakeMicrophone();
});

function engine(overrides: Partial<VoiceEngineView> = {}): VoiceEngineView {
  return {
    id: 'openai',
    label: 'OpenAI',
    problem: null,
    locked: false,
    keyIn: 'app',
    local: false,
    nonCommercial: false,
    clones: false,
    pricePerMillionChars: 15,
    retiresOn: null,
    ...overrides,
  };
}

const ENGINES: VoiceEngineView[] = [
  engine(),
  engine({
    id: 'gemini',
    label: 'Google Gemini',
    problem: 'Add a Gemini API key in Settings > AI.',
    pricePerMillionChars: null,
  }),
  engine({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    keyIn: 'studio',
    locked: true,
    problem: 'Unlock the vault to use ElevenLabs.',
    pricePerMillionChars: null,
  }),
  engine({
    id: 'azure',
    label: 'Azure Speech',
    keyIn: 'studio',
    problem: 'Add an Azure Speech key and region in Settings > Studio.',
    pricePerMillionChars: 16,
  }),
];

function job(overrides: Partial<NarrationJobView> = {}): NarrationJobView {
  return {
    id: 'j1',
    videoId: 'v1',
    voiceRef: 'openai:marin',
    sceneIds: ['s1', 's2'],
    status: 'running',
    done: 1,
    total: 3,
    sceneId: 's2',
    skipped: [],
    reused: 0,
    error: null,
    startedAt: NOW,
    endedAt: null,
    ...overrides,
  };
}

function narrated(): StudioDocument {
  const doc = document();
  doc.scenario.scenes = [
    createScene({ id: 's1', narration: 'سلام. این یک آزمایش است.', voiceRef: 'openai:marin' }),
    createScene({ id: 's2', narration: 'A second scene to say.' }),
    createScene({ id: 's3', narration: '', voiceRef: 'recording' }),
  ];
  return doc;
}

function renderPanel(
  options: {
    engines?: VoiceEngineView[];
    jobs?: NarrationJobView[];
    doc?: StudioDocument;
    voices?: { id: string; label: string; nonCommercial?: boolean; license?: string }[];
    profiles?: VoiceProfileView[];
  } = {},
) {
  const apply = vi.fn(async () => true);
  const adopt = vi.fn(async () => undefined);
  const onOpenDevSetup = vi.fn();
  const doc = options.doc ?? narrated();
  const view = renderWithProviders(
    <VoicePanel
      videoId="v1"
      document={doc}
      apply={apply}
      adopt={adopt}
      onOpenDevSetup={onOpenDevSetup}
    />,
    {
      bridge: {
        'studioAudio.engines': async () => options.engines ?? ENGINES,
        'studioAudio.voices': async () =>
          options.voices ?? [
            { id: 'marin', label: 'marin' },
            { id: 'cedar', label: 'cedar' },
          ],
        'studioAudio.profiles': async () => options.profiles ?? [],
        'studioAudio.transcribeTake': async () => ({ text: 'سلام، این صدای من است.', seconds: 6 }),
        'studioAudio.createProfile': async (input: { name: string }) =>
          profile({ name: input.name }),
        'studioAudio.cloneProfile': async () => profile({ elevenlabsVoiceId: 'v-1' }),
        'studioAudio.removeProfile': async () => undefined,
        'studioAudio.jobs': async () => options.jobs ?? [],
        'studioAudio.speak': async () => job(),
        'studioAudio.cancel': async () => undefined,
        'studioAudio.captionScene': async () => ({ seq: 9, document: doc, status: status() }),
        'studioAudio.record': async () => ({ seq: 9, document: doc, status: status() }),
        'ssh.unlockVault': async () => true,
      },
    },
  );
  return { ...view, apply, adopt, doc, onOpenDevSetup };
}

function profile(overrides: Partial<VoiceProfileView> = {}): VoiceProfileView {
  return {
    id: 'p1',
    name: 'Amin',
    lang: 'fa',
    seconds: 6,
    transcript: 'سلام',
    createdAt: NOW,
    consentAt: NOW,
    elevenlabsVoiceId: null,
    ...overrides,
  };
}

const LOCAL: VoiceEngineView[] = [
  engine({
    id: 'piper',
    label: 'Piper',
    keyIn: 'none',
    local: true,
    pricePerMillionChars: null,
    problem: 'Install Piper and its voices from Agent Tools, Dev Setup (Studio).',
  }),
  engine({
    id: 'omnivoice',
    label: 'OmniVoice',
    keyIn: 'none',
    local: true,
    clones: true,
    nonCommercial: true,
    pricePerMillionChars: null,
  }),
];

const row = (n: number) => screen.getByRole('listitem', { name: `Scene ${n}` });

describe('VoicePanel', () => {
  it('speaks every scene with narration in the picked voice, and says what it costs', async () => {
    const { user, bridge } = renderPanel();
    const speakAll = await screen.findByRole('button', { name: 'Speak every scene' });
    await waitFor(() => expect(speakAll.hasAttribute('disabled')).toBe(false));
    // 46 characters at $15 a million.
    expect(screen.getByText('OpenAI lists this at under a cent.')).toBeTruthy();
    expect(within(row(1)).getByText('OpenAI, marin')).toBeTruthy();
    expect(within(row(2)).getByText('No voice')).toBeTruthy();
    expect(within(row(3)).getByText('Your recording')).toBeTruthy();
    await user.click(speakAll);
    expect(bridge.$fn('studioAudio.speak')).toHaveBeenCalledWith({
      videoId: 'v1',
      sceneIds: ['s1', 's2'],
      voiceRef: 'openai:marin',
    });
    await user.click(within(row(2)).getByRole('button', { name: 'Speak scene 2' }));
    expect(bridge.$fn('studioAudio.speak')).toHaveBeenLastCalledWith({
      videoId: 'v1',
      sceneIds: ['s2'],
      voiceRef: 'openai:marin',
    });
    expect(within(row(3)).getByRole('button', { name: 'Speak scene 3' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows a run under way with Stop, and a stopped run with what went wrong', async () => {
    const running = renderPanel({ jobs: [job()] });
    const progress = await screen.findByRole('status', { name: 'Narration progress' });
    expect(progress.textContent).toContain('Speaking scene 2: 1 of 3 pieces');
    await running.user.click(within(progress).getByRole('button', { name: 'Stop' }));
    expect(running.bridge.$fn('studioAudio.cancel')).toHaveBeenCalledWith('v1', 'j1');
    expect(screen.getByRole('button', { name: 'Speak every scene' })).toHaveProperty(
      'disabled',
      true,
    );
    running.unmount();

    renderPanel({
      jobs: [job({ status: 'failed', error: 'OpenAI refused the key. Check it in Settings.' })],
    });
    expect(
      await screen.findByText(
        'Narration stopped: OpenAI refused the key. Check it in Settings.. Speaking again redoes only what is missing.',
      ),
    ).toBeTruthy();
  });

  it('says what an engine needs, and unlocks the vault for a locked one', async () => {
    const { user, queryClient } = renderPanel({
      engines: [ENGINES[2] as VoiceEngineView],
      doc: { ...narrated(), scenario: { ...narrated().scenario, scenes: [] } },
    });
    expect(await screen.findByText('Unlock the vault to use ElevenLabs.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Speak every scene' })).toHaveProperty(
      'disabled',
      true,
    );
    const refetch = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/passkey/i);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('captions a scene through the service, and turns ducking off as an undoable edit', async () => {
    const { user, bridge, adopt, apply } = renderPanel();
    await user.click(
      within(await screen.findByRole('listitem', { name: 'Scene 1' })).getByRole('button', {
        name: 'Caption',
      }),
    );
    expect(bridge.$fn('studioAudio.captionScene')).toHaveBeenCalledWith('v1', 's1');
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    const duck = screen.getByRole('switch', { name: /Lower the music/ });
    expect(duck.getAttribute('aria-checked')).toBe('true');
    await user.click(duck);
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'render.set', patch: { audio: { sampleRate: 48_000, lufs: -14, duck: false } } }],
      'Music kept at its level',
    );
  });

  it('records a scene with the narration in view, plays the take back and puts it on the scene', async () => {
    const { user, bridge, adopt } = renderPanel();
    await user.click(
      within(await screen.findByRole('listitem', { name: 'Scene 1' })).getByRole('button', {
        name: 'Record scene 1',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Record scene 1' });
    expect(within(dialog).getByLabelText('Narration to read').textContent).toBe(
      'سلام. این یک آزمایش است.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Start recording' }));
    const meter = await within(dialog).findByRole('meter', { name: 'Microphone level' });
    await waitFor(() => expect(Number(meter.getAttribute('aria-valuenow'))).toBe(50));
    await user.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(await within(dialog).findByLabelText('Your take')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Use this take' }));
    await waitFor(() =>
      expect(bridge.$fn('studioAudio.record')).toHaveBeenCalledWith({
        videoId: 'v1',
        sceneId: 's1',
        bytes: expect.any(Uint8Array),
        mimeType: 'audio/webm',
      }),
    );
    expect(adopt).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Your recording is now the narration of scene 1.');
  });

  it('asks for a scenario first when there are no scenes', async () => {
    renderPanel({ doc: document() });
    expect(await screen.findByText('No scenes yet')).toBeTruthy();
  });
});

describe('VoiceKeysFields', () => {
  it('saves and removes the ElevenLabs key, and needs the Azure region', async () => {
    const saved = [engine(), engine({ id: 'elevenlabs', label: 'ElevenLabs', keyIn: 'studio' })];
    const { user, bridge } = renderWithProviders(<VoiceKeysFields />, {
      bridge: {
        'studioAudio.engines': async () => ENGINES,
        'studioAudio.setKey': async () => saved,
      },
    });
    const elevenKey = await screen.findByLabelText('ElevenLabs key');
    expect(screen.getAllByText('Not set')).toHaveLength(1);
    expect(screen.getByText('Locked in the vault')).toBeTruthy();
    await user.type(elevenKey, 'xi-1');
    const saves = screen.getAllByRole('button', { name: 'Save' });
    await user.click(saves[0] as HTMLElement);
    expect(bridge.$fn('studioAudio.setKey')).toHaveBeenCalledWith({
      engine: 'elevenlabs',
      key: 'xi-1',
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Key saved.');
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(bridge.$fn('studioAudio.setKey')).toHaveBeenLastCalledWith({
      engine: 'elevenlabs',
      key: null,
    });

    await user.type(screen.getByLabelText('Azure Speech key and region'), 'az');
    const azureSave = screen.getAllByRole('button', { name: 'Save' })[1] as HTMLElement;
    expect(azureSave).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Azure region'), 'WestEurope');
    expect(azureSave).toHaveProperty('disabled', false);
    await user.click(azureSave);
    expect(bridge.$fn('studioAudio.setKey')).toHaveBeenLastCalledWith({
      engine: 'azure',
      key: 'az',
      region: 'westeurope',
    });
  });
});

describe('local voices in the panel', () => {
  it('sends the user to Dev Setup for an engine that is not installed', async () => {
    const { user, onOpenDevSetup } = renderPanel({
      engines: [LOCAL[0] as VoiceEngineView],
      doc: { ...narrated(), scenario: { ...narrated().scenario, scenes: [] } },
    });
    expect(
      await screen.findByText('Install Piper and its voices from Agent Tools, Dev Setup (Studio).'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open Dev Setup' }));
    expect(onOpenDevSetup).toHaveBeenCalled();
  });

  it('says OmniVoice is for non-commercial use, and a non-commercial Piper voice too', async () => {
    const omni = renderPanel({
      engines: [LOCAL[1] as VoiceEngineView],
      doc: { ...narrated(), scenario: { ...narrated().scenario, scenes: [] } },
      voices: [{ id: 'p1', label: 'Amin', nonCommercial: true, license: 'CC BY-NC 4.0' }],
    });
    expect(
      await screen.findByText(
        'Everything OmniVoice speaks is for non-commercial use only (its model is CC BY-NC 4.0).',
      ),
    ).toBeTruthy();
    omni.unmount();
    renderPanel({
      engines: [{ ...(LOCAL[0] as VoiceEngineView), problem: null }],
      doc: { ...narrated(), scenario: { ...narrated().scenario, scenes: [] } },
      voices: [
        {
          id: 'en_US-hfc_female-medium',
          label: 'HFC Female',
          nonCommercial: true,
          license: 'CC BY-NC-SA 4.0',
        },
      ],
    });
    expect(
      await screen.findByText('HFC Female is for non-commercial use only (CC BY-NC-SA 4.0).'),
    ).toBeTruthy();
  });
});

describe('VoiceProfilesDialog', () => {
  function renderDialog(profiles: VoiceProfileView[] = []) {
    return renderWithProviders(<VoiceProfilesDialog open onOpenChange={vi.fn()} lang="fa" />, {
      bridge: {
        'studioAudio.profiles': async () => profiles,
        'studioAudio.transcribeTake': async () => ({ text: 'سلام، این صدای من است.', seconds: 6 }),
        'studioAudio.createProfile': async (input: { name: string }) =>
          profile({ name: input.name }),
        'studioAudio.cloneProfile': async () => profile({ elevenlabsVoiceId: 'v-1' }),
        'studioAudio.removeProfile': async () => undefined,
      },
    });
  }

  it('records a take, fills in what it says, and saves it only with a name and consent', async () => {
    const { user, bridge } = renderDialog();
    expect(await screen.findByText('No voices yet')).toBeTruthy();
    expect(screen.getByLabelText('Text to read').textContent).toMatch(/^امروز/);
    await user.type(screen.getByRole('textbox', { name: 'New voice' }), 'Amin');
    await user.click(screen.getByRole('button', { name: 'Record' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    const said = await screen.findByLabelText('What the take says');
    expect((said as HTMLTextAreaElement).value).toBe('سلام، این صدای من است.');
    expect(bridge.$fn('studioAudio.transcribeTake')).toHaveBeenCalledWith({
      bytes: expect.any(Uint8Array),
      mimeType: 'audio/webm',
      lang: 'fa',
    });
    const save = screen.getByRole('button', { name: 'Save voice' });
    expect(save).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox'));
    expect(save).toHaveProperty('disabled', false);
    await user.click(save);
    await waitFor(() =>
      expect(bridge.$fn('studioAudio.createProfile')).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Amin',
          lang: 'fa',
          consent: true,
          transcript: 'سلام، این صدای من است.',
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Amin is ready to speak with.');
  });

  it('uploads to ElevenLabs and deletes only after asking', async () => {
    const { user, bridge } = renderDialog([
      profile(),
      profile({ id: 'p2', name: 'Sara', elevenlabsVoiceId: 'v-2' }),
    ]);
    const amin = await screen.findByRole('listitem', { name: 'Amin' });
    confirm.mockResolvedValueOnce(false);
    await user.click(within(amin).getByRole('button', { name: 'Upload to ElevenLabs' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await user.click(within(amin).getByRole('button', { name: 'Upload to ElevenLabs' }));
    // Declined once, so the one upload is the second, agreed one.
    await waitFor(() => expect(bridge.$fn('studioAudio.cloneProfile')).toHaveBeenCalledTimes(1));
    expect(bridge.$fn('studioAudio.cloneProfile')).toHaveBeenCalledWith('p1');
    const sara = screen.getByRole('listitem', { name: 'Sara' });
    expect(within(sara).getByText('In ElevenLabs')).toBeTruthy();
    await user.click(within(sara).getByRole('button', { name: 'Delete Sara' }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Delete Sara?',
        description: expect.stringMatching(/removed from your ElevenLabs account/),
        variant: 'destructive',
      }),
    );
    await waitFor(() => expect(bridge.$fn('studioAudio.removeProfile')).toHaveBeenCalledWith('p2'));
  });
});
