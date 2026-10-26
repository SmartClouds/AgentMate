import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Screenshot, rotate, record and install.
 *
 * The parts worth pinning down are that a screenshot is read as bytes rather than through the
 * line-based runner that would corrupt a PNG, that a recording is stopped on the device so the
 * mp4 is not left truncated, and that a capture can only ever be revealed from inside the folder
 * we write to.
 */

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  answers: [] as { match: string; stdout?: string; error?: string }[],
  written: new Map<string, unknown>(),
}));

vi.mock('./exec', () => ({
  AndroidCommandError: class extends Error {},
  AndroidToolMissingError: class extends Error {},
  runAdb: (_sdk: unknown, args: string[]) => {
    state.calls.push(args);
    const line = args.join(' ');
    const answer = state.answers.find((a) => line.includes(a.match));
    if (answer?.error) return Promise.reject(new Error(answer.error));
    return Promise.resolve(answer?.stdout ?? '');
  },
  runAdbBinary: (_sdk: unknown, args: string[]) => {
    state.calls.push(args);
    return Promise.resolve(Buffer.from('PNGBYTES'));
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  writeFile: async (path: string, data: unknown) => {
    state.written.set(String(path), data);
  },
}));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/home/dev/${name}` },
  shell: { showItemInFolder: () => undefined, openPath: async () => '' },
}));

vi.mock('../store', () => ({ store: { getSettings: async () => ({ androidCapturePath: null }) } }));

const sdk = { paths: { adb: '/sdk/platform-tools/adb' } } as never;

beforeEach(() => {
  state.calls.length = 0;
  state.answers.length = 0;
  state.written.clear();
});

describe('takeScreenshot', () => {
  it('reads the PNG as bytes, not through the text runner', async () => {
    const { takeScreenshot } = await import('./deviceActions');

    const result = await takeScreenshot(sdk, 'emulator-5554', 'Pixel 7');

    // `exec-out` writes raw PNG on stdout; a line reader that strips ANSI would corrupt it.
    expect(state.calls[0]).toEqual(['-s', 'emulator-5554', 'exec-out', 'screencap', '-p']);
    expect(result.path).toMatch(/Pixel_7-\d{8}-\d{6}\.png$/);
    expect(state.written.get(result.path)).toBeInstanceOf(Buffer);
  });
});

describe('rotateDevice', () => {
  it('turns auto-rotate off first, or the setting is ignored', async () => {
    const { rotateDevice } = await import('./deviceActions');
    state.answers.push({ match: 'user_rotation', stdout: '' });

    await rotateDevice(sdk, 'emulator-5554');

    const lines = state.calls.map((args) => args.join(' '));
    expect(lines.some((line) => line.includes('accelerometer_rotation 0'))).toBe(true);
    expect(lines.some((line) => line.includes('user_rotation'))).toBe(true);
  });

  it('steps through the four orientations', async () => {
    const { rotateDevice } = await import('./deviceActions');
    state.answers.push({ match: 'get system user_rotation', stdout: '3\n' });

    await rotateDevice(sdk, 'emulator-5554');

    const put = state.calls.find((args) => args.join(' ').includes('put system user_rotation'));
    // Wraps back to 0 rather than asking for a rotation the device has no name for.
    expect(put?.at(-1)).toBe('0');
  });
});

describe('recording', () => {
  it('stops on the device, then pulls and cleans up', async () => {
    const { startRecording, stopRecording } = await import('./deviceActions');

    const handle = startRecording(sdk, 'emulator-5554', 'Pixel 7');
    await handle.started;
    await stopRecording(handle.id);

    const lines = state.calls.map((args) => args.join(' '));
    // A host-side kill leaves a truncated, unplayable mp4, so the recorder is interrupted on
    // the device and given a moment to finalize the file.
    expect(lines.some((line) => line.includes('pkill -INT -f screenrecord'))).toBe(true);
    expect(lines.some((line) => line.includes('pull'))).toBe(true);
    expect(lines.some((line) => line.includes('rm '))).toBe(true);
  });

  it('refuses to stop a recording it does not know about', async () => {
    const { stopRecording } = await import('./deviceActions');

    await expect(stopRecording('nope')).rejects.toThrow();
  });
});

describe('installApk', () => {
  it('replaces an existing install and grants the runtime permissions', async () => {
    const { installApk } = await import('./deviceActions');
    state.answers.push({ match: 'install', stdout: 'Performing Streamed Install\nSuccess\n' });

    const result = await installApk(sdk, 'emulator-5554', ['/tmp/app.apk']);

    expect(result.ok).toBe(true);
    const args = state.calls.find((call) => call.includes('install'));
    expect(args).toContain('-r');
    expect(args).toContain('-g');
    expect(args).toContain('/tmp/app.apk');
  });

  it('uses install-multiple for a split APK set', async () => {
    const { installApk } = await import('./deviceActions');
    state.answers.push({ match: 'install-multiple', stdout: 'Success\n' });

    await installApk(sdk, 'emulator-5554', ['/tmp/base.apk', '/tmp/split.apk']);

    expect(state.calls.some((call) => call.includes('install-multiple'))).toBe(true);
  });

  it('turns an INSTALL_FAILED code into something a person can act on', async () => {
    const { installApk } = await import('./deviceActions');
    state.answers.push({
      match: 'install',
      error: 'adb: failed to install: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]',
    });

    const result = await installApk(sdk, 'emulator-5554', ['/tmp/app.apk']);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/signed with a different key|Uninstall/i);
  });
});

describe('revealCapture', () => {
  it('only reveals a file inside the captures folder', async () => {
    const { revealCapture } = await import('./deviceActions');

    await expect(revealCapture('/home/dev/pictures/Runova/Android/a.png')).resolves.not.toThrow();
    // A path from the renderer must not be able to point anywhere it likes.
    await expect(revealCapture('/etc/passwd')).rejects.toThrow();
    await expect(
      revealCapture('/home/dev/pictures/Runova/Android/../../../secrets.txt'),
    ).rejects.toThrow();
  });
});
