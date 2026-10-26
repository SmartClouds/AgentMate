import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { withPlatform } from '../../test/main/fixtures';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Anything the renderer hands to the OS. openExternal is the one that matters: a url from a
 * README, an agent transcript or a pasted link reaches it, so a scheme other than http(s) has to
 * be refused rather than handed to the shell.
 */

const execState = vi.hoisted(() => ({
  calls: [] as { file: string; args: readonly string[] }[],
  fail: false,
}));

// A process boundary: spawning the real `code` binary is not this test's business.
vi.mock('node:child_process', () => ({
  execFile: (file: string, ...rest: unknown[]) => {
    const callback = rest.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    execState.calls.push({ file, args: (rest[0] as string[]) ?? [] });
    if (execState.fail) callback(new Error('spawn ENOENT'), '', '');
    else callback(null, '', '');
  },
}));

useTempUserData();

expectChannelsCovered(IPC.shell);

beforeEach(async () => {
  execState.calls = [];
  execState.fail = false;
  await loadIpc(
    () => import('./shell'),
    (module) => module.registerShellHandlers(),
  );
});

describe('shell:openExternal', () => {
  it('opens http and https links', async () => {
    await invoke(IPC.shell.openExternal, 'https://runova.dev/docs');
    await invoke(IPC.shell.openExternal, 'http://127.0.0.1:5173/');
    expect(electronState.openedExternal).toEqual([
      'https://runova.dev/docs',
      'http://127.0.0.1:5173/',
    ]);
  });

  it.each([
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'vscode://file/C:/secret',
    'data:text/html,<script>fetch("https://evil.test")</script>',
    'ms-msdt:/id',
  ])('refuses %s', async (url) => {
    await expect(invoke(IPC.shell.openExternal, url)).rejects.toThrow('Refusing to open URL');
    expect(electronState.openedExternal).toEqual([]);
  });

  it('rejects something that is not a url at all', async () => {
    await expect(invoke(IPC.shell.openExternal, 'runova.dev')).rejects.toThrow();
    expect(electronState.openedExternal).toEqual([]);
  });
});

describe('shell:openPath', () => {
  it('hands the path to the OS', async () => {
    await invoke(IPC.shell.openPath, 'C:\\projects\\demo');
    expect(electronState.openedPaths).toEqual(['C:\\projects\\demo']);
  });
});

describe('shell:openInEditor', () => {
  it('goes through cmd.exe with an argv array on Windows, never a joined string', async () => {
    await withPlatform('win32', () => invoke(IPC.shell.openInEditor, 'C:\\a b\\project'));
    expect(execState.calls).toEqual([
      { file: 'cmd.exe', args: ['/d', '/s', '/c', 'code', 'C:\\a b\\project'] },
    ]);
  });

  it('calls code directly elsewhere', async () => {
    await withPlatform('darwin', () => invoke(IPC.shell.openInEditor, '/Users/me/project'));
    expect(execState.calls).toEqual([{ file: 'code', args: ['/Users/me/project'] }]);
  });

  it('turns a missing code binary into an explanation, not a spawn error', async () => {
    execState.fail = true;
    await expect(
      withPlatform('linux', () => invoke(IPC.shell.openInEditor, '/home/me/project')),
    ).rejects.toThrow('Could not open VS Code');
  });
});
