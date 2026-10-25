import {
  createScene,
  type NarrationJobView,
  type StudioDocument,
  type VoiceEngineView,
} from '@agentmat/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMicrophone } from '../../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { VoiceKeysFields } from '../settings/VoiceKeysFields';
import { document, NOW, status } from '../testing/fixtures';
import { VoicePanel } from './VoicePanel';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
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
  options: { engines?: VoiceEngineView[]; jobs?: NarrationJobView[]; doc?: StudioDocument } = {},
) {
  const apply = vi.fn(async () => true);
  const adopt = vi.fn(async () => undefined);
  const doc = options.doc ?? narrated();
  const view = renderWithProviders(
    <VoicePanel videoId="v1" document={doc} apply={apply} adopt={adopt} />,
    {
      bridge: {
        'studioAudio.engines': async () => options.engines ?? ENGINES,
        'studioAudio.voices': async () => [
          { id: 'marin', label: 'marin' },
          { id: 'cedar', label: 'cedar' },
        ],
        'studioAudio.jobs': async () => options.jobs ?? [],
        'studioAudio.speak': async () => job(),
        'studioAudio.cancel': async () => undefined,
        'studioAudio.captionScene': async () => ({ seq: 9, document: doc, status: status() }),
        'studioAudio.record': async () => ({ seq: 9, document: doc, status: status() }),
        'ssh.unlockVault': async () => true,
      },
    },
  );
  return { ...view, apply, adopt, doc };
}

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
