import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, withPlatform } from '../../test/main/fixtures';

/**
 * Files copied on the server are staged in a folder of ours and that folder's entries go on the
 * Windows clipboard. PowerShell is the boundary, so it is replaced here: the real call would
 * overwrite whatever the person has copied.
 */

const execState = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; env: Record<string, string | undefined> }[],
  failure: null as Error | null,
}));

/** See clipboardPaths.test.ts for why the stand-in carries the promisify symbol. */
vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => undefined, {
    [custom]: (
      file: string,
      args: string[],
      options: { env: Record<string, string | undefined> },
    ) => {
      execState.calls.push({ file, args, env: options.env });
      if (execState.failure) return Promise.reject(execState.failure);
      return Promise.resolve({ stdout: '', stderr: '' });
    },
  });
  return { execFile };
});

const { prepareStagingFolder, putFilesOnClipboard, stagingSupported, sweepStaleStaging } =
  await import('./remoteClipboard');

beforeEach(() => {
  execState.calls = [];
  execState.failure = null;
});

describe('prepareStagingFolder', () => {
  it('hands back an empty folder under this process and the session', async () => {
    const root = tempDir();

    const folder = await prepareStagingFolder('session-1', root);

    expect(folder).toBe(join(root, String(process.pid), 'session-1'));
    expect(existsSync(folder)).toBe(true);
  });

  it('clears what the session staged for its previous copy', async () => {
    const root = tempDir();
    const first = await prepareStagingFolder('session-1', root);
    writeFileSync(join(first, 'old.txt'), 'old');

    const second = await prepareStagingFolder('session-1', root);

    expect(second).toBe(first);
    expect(existsSync(join(second, 'old.txt'))).toBe(false);
  });

  it('leaves another session alone', async () => {
    const root = tempDir();
    const other = await prepareStagingFolder('session-2', root);
    writeFileSync(join(other, 'keep.txt'), 'keep');

    await prepareStagingFolder('session-1', root);

    expect(existsSync(join(other, 'keep.txt'))).toBe(true);
  });
});

describe('sweepStaleStaging', () => {
  function stage(root: string, pid: number): string {
    const folder = join(root, String(pid), 'session');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'file.txt'), 'x');
    return join(root, String(pid));
  }

  it('removes what a run that is gone left behind', async () => {
    const root = tempDir();
    const dead = stage(root, 111111);

    await sweepStaleStaging(root, () => false);

    expect(existsSync(dead)).toBe(false);
  });

  it('keeps another running AgentMate, and this one', async () => {
    const root = tempDir();
    const running = stage(root, 222222);
    const own = stage(root, process.pid);

    await sweepStaleStaging(root, () => false);

    expect(existsSync(running)).toBe(false);
    expect(existsSync(own)).toBe(true);

    const alive = stage(root, 333333);
    await sweepStaleStaging(root, (pid) => pid === 333333);
    expect(existsSync(alive)).toBe(true);
  });

  it('ignores anything that is not a process id', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'notes'));

    await sweepStaleStaging(root, () => false);

    expect(existsSync(join(root, 'notes'))).toBe(true);
  });

  it('has nothing to do before the first copy ever made a folder', async () => {
    await expect(sweepStaleStaging(join(tempDir(), 'missing'))).resolves.toBeUndefined();
  });
});

describe('putFilesOnClipboard', () => {
  it('copies Windows paths through Set-Clipboard, joined in the environment, not the script', async () => {
    const paths = ['C:\\Temp\\a b.txt', "C:\\Temp\\it's [1].txt", 'C:\\Temp\\folder'];

    await withPlatform('win32', () => putFilesOnClipboard(paths));

    const [call] = execState.calls;
    expect(call.file).toBe('powershell.exe');
    expect(call.env.AGENTMATE_CLIPBOARD_PATHS).toBe(paths.join('|'));
    const script = call.args.at(-1) ?? '';
    expect(script).toContain('Set-Clipboard -LiteralPath');
    // A file name never reaches the script text.
    expect(script).not.toContain('a b.txt');
    expect(script).not.toContain("it's");
  });

  it('says so in plain words when Windows would not take them', async () => {
    execState.failure = new Error('Command failed: powershell.exe ... exit 1');

    await expect(withPlatform('win32', () => putFilesOnClipboard(['C:\\a.txt']))).rejects.toThrow(
      'Windows would not take the files onto the clipboard. Try again.',
    );
  });

  it('does not try on a system without the Windows clipboard', async () => {
    await expect(withPlatform('linux', () => putFilesOnClipboard(['/a.txt']))).rejects.toThrow(
      /only supported on Windows/,
    );
    expect(execState.calls).toEqual([]);
  });
});

describe('stagingSupported', () => {
  it.each([
    ['win32', true],
    ['darwin', false],
    ['linux', false],
  ] as const)('on %s is %s', async (platform, expected) => {
    expect(await withPlatform(platform, stagingSupported)).toBe(expected);
  });
});
