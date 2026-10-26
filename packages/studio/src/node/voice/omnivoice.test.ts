import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_STATEMENT } from '../../api.js';
import { useTempDirs } from '../../test/tempDir.js';
import { encodeWav, parseWav } from '../../voice/wav.js';
import { createOmniVoiceSpeaker } from './omnivoice.js';
import { VoiceProfiles } from './voiceProfiles.js';

const FAKE = join(__dirname, '..', '..', 'test', 'fakeSidecar.mjs');
const SCRIPT = join(__dirname, '..', '..', '..', 'assets', 'voice', 'omnivoice_server.py');
const tempDir = useTempDirs();
const speakers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(speakers.splice(0).map((s) => s.stop()));
  delete process.env.FAKE_SIDECAR;
});

async function setup(
  options: { idleShutdownMs?: number; python?: string; env?: Record<string, string> } = {},
) {
  const root = await tempDir();
  let n = 0;
  const profiles = new VoiceProfiles(
    join(root, 'voices'),
    () => 1000,
    () => `p${++n}`,
  );
  const take = join(root, 'take.wav');
  await writeFile(take, encodeWav(new Uint8Array(24_000 * 2 * 4), 24_000));
  const profile = await profiles.create({
    name: 'Amin',
    lang: 'fa',
    wav: take,
    seconds: 4,
    transcript: 'سلام، این صدای من است.',
    consent: true,
  });
  const logs: string[] = [];
  const speaker = createOmniVoiceSpeaker({
    python: options.python ?? process.execPath,
    prefixArgs: options.python ? [] : [FAKE],
    script: SCRIPT,
    modelDir: join(root, 'model'),
    workDir: join(root, 'work'),
    profiles,
    onLog: (line) => logs.push(line),
    idleShutdownMs: options.idleShutdownMs,
    env: options.env,
  });
  speakers.push(speaker);
  return { root, profiles, profile, speaker, logs };
}

describe('voice profiles', () => {
  it('keeps a copy of the take with the consent given, and forgets it on removal', async () => {
    const { profiles, profile } = await setup();
    expect(profile).toMatchObject({
      id: 'p1',
      name: 'Amin',
      consent: { statement: CONSENT_STATEMENT, at: 1000 },
      bindings: {},
    });
    expect(parseWav(await readFile(profiles.recording('p1'))).seconds).toBe(4);
    await expect(
      profiles.create({
        name: 'X',
        lang: 'en',
        wav: profiles.recording('p1'),
        seconds: 4,
        transcript: '',
        consent: false,
      }),
    ).rejects.toThrow('A voice profile needs your confirmation that you may use this voice.');
    expect(await profiles.update('p1', { elevenlabs: 'voice-123', name: ' ' })).toMatchObject({
      name: 'Amin',
      bindings: { elevenlabs: 'voice-123' },
    });
    expect((await profiles.update('p1', { elevenlabs: null })).bindings).toEqual({});
    await profiles.remove('p1');
    expect(await profiles.list()).toEqual([]);
    await expect(profiles.update('p1', { name: 'Y' })).rejects.toThrow(
      'That voice profile is not there any more.',
    );
  });
});

describe('OmniVoice through its sidecar', () => {
  it('clones the profile voice, sending its recording and transcript, and keeps the model loaded', async () => {
    const { speaker, profiles, logs } = await setup();
    const wav = parseWav(await speaker({ voice: 'p1', text: 'سلام دنیا', lang: 'fa' }));
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.seconds).toBeCloseTo(9 * 0.05, 2);
    await speaker({ voice: 'p1', text: 'دوباره', lang: 'fa' });
    expect(speaker.host.starts).toBe(1);
    expect(logs).toContain('loading the model');
    expect(profiles.recording('p1')).toMatch(/p1\.wav$/);
  });

  it('fails only the piece in flight when the sidecar dies, and starts it again for the next (AC3)', async () => {
    const { speaker } = await setup();
    const crashed = speaker({ voice: 'p1', text: 'CRASH now', lang: 'fa' });
    // Each piece looks its profile up first; queue the next one only once the crash owns the sidecar.
    await vi.waitFor(() => expect(speaker.host.starts).toBe(1));
    const next = speaker({ voice: 'p1', text: 'بعدی', lang: 'fa' });
    await expect(crashed).rejects.toMatchObject({
      message: 'OmniVoice stopped unexpectedly (exit code 3).',
      retryable: true,
    });
    expect(parseWav(await next).frames).toBeGreaterThan(0);
    expect(speaker.host.starts).toBe(2);
  });

  it('refuses a profile without consent or one that is gone, and reports a refused piece', async () => {
    const { speaker, root } = await setup();
    const file = join(root, 'voices', 'profiles.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.profiles[0].consent = { statement: '', at: 0 };
    await writeFile(file, JSON.stringify(saved));
    await expect(speaker({ voice: 'p1', text: 'سلام', lang: 'fa' })).rejects.toThrow(
      'This voice profile has no consent recorded, so it cannot be cloned.',
    );
    await expect(speaker({ voice: 'nope', text: 'سلام', lang: 'fa' })).rejects.toThrow(
      'That voice profile is not there any more.',
    );
    expect(speaker.host.starts).toBe(0);
  });

  it('says why the model would not load, stops a piece on request, and stops when idle', async () => {
    process.env.FAKE_SIDECAR = 'fatal';
    const broken = await setup();
    await expect(broken.speaker({ voice: 'p1', text: 'a', lang: 'fa' })).rejects.toThrow(
      'OmniVoice could not start: OutOfMemoryError: CUDA out of memory',
    );
    delete process.env.FAKE_SIDECAR;

    const { speaker } = await setup({ idleShutdownMs: 50 });
    await expect(speaker({ voice: 'p1', text: 'BAD take', lang: 'fa' })).rejects.toThrow(
      'OmniVoice could not speak this. ValueError: reference audio is too short',
    );
    const controller = new AbortController();
    const hanging = speaker({ voice: 'p1', text: 'HANG', lang: 'fa', signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(hanging).rejects.toThrow('Stopped.');
    await speaker({ voice: 'p1', text: 'سلام', lang: 'fa' });
    expect(speaker.host.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(speaker.host.running).toBe(false);
  });
});

const python = ['python', 'python3'].find(
  (p) => spawnSync(p, ['--version'], { windowsHide: true }).status === 0,
);

describe.skipIf(!python)('the real sidecar script, with stand-ins for torch and OmniVoice', () => {
  it('loads the model from its folder, clones with the reference, and writes a 16-bit WAV', async () => {
    const root = await tempDir();
    const stubs = join(root, 'stubs');
    await mkdir(join(stubs, 'torch'), { recursive: true });
    await mkdir(join(stubs, 'omnivoice'), { recursive: true });
    await writeFile(
      join(stubs, 'torch', '__init__.py'),
      'float16 = "f16"\nfloat32 = "f32"\nclass cuda:\n    @staticmethod\n    def is_available():\n        return False\nclass backends:\n    pass\n',
    );
    await writeFile(
      join(stubs, 'omnivoice', '__init__.py'),
      [
        'import json',
        'class OmniVoice:',
        '    sampling_rate = 24000',
        '    @classmethod',
        '    def from_pretrained(cls, path, device_map=None, dtype=None):',
        '        m = cls()',
        '        m.loaded = (path, device_map, dtype)',
        '        return m',
        '    def generate(self, text, ref_audio=None, ref_text=None):',
        '        open(text and __file__ + ".log", "w", encoding="utf-8").write(json.dumps([text, ref_audio, ref_text, self.loaded]))',
        '        return [[0.5] * (len(text) * 1200)]',
        '',
      ].join('\n'),
    );
    const { speaker, root: videoRoot } = await setup({ python, env: { PYTHONPATH: stubs } });
    const wav = parseWav(await speaker({ voice: 'p1', text: 'سلام دنیا', lang: 'fa' }));
    expect(wav).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    expect(wav.seconds).toBeCloseTo((9 * 1200) / 24_000, 3);
    const [text, ref, refText, loaded] = JSON.parse(
      await readFile(join(stubs, 'omnivoice', '__init__.py.log'), 'utf8'),
    );
    expect(text).toBe('سلام دنیا');
    expect(ref).toMatch(/p1\.wav$/);
    expect(refText).toBe('سلام، این صدای من است.');
    expect(loaded).toEqual([join(videoRoot, 'model'), 'cpu', 'f32']);
  });
});
