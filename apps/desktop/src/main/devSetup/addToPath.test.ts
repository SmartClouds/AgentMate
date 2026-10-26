import type { DevDetection } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { addToolToPath } from './addToPath';

/**
 * "Add to PATH" for a tool that is installed but off PATH. The folder comes from where the main
 * process found the tool, never from the renderer, and only a tool that really is off PATH gets
 * that far.
 */

const REFUSED = 'That tool is already on your PATH, or was not found.';

const offPath = (path: string | null): DevDetection => ({
  state: 'found',
  version: '3.27.0',
  path,
  onPath: false,
});

function setup(
  detection: DevDetection,
  os: 'win32' | 'darwin' | 'linux' = 'win32',
  added: { changed: boolean; where: string } = { changed: true, where: 'your user PATH' },
) {
  const detect = vi.fn(async () => detection);
  const addToUserPath = vi.fn(async () => added);
  return { detect, addToUserPath, deps: { os, detect, addToUserPath } };
}

describe('addToolToPath: which folder', () => {
  it('adds the folder a Windows tool was found in', async () => {
    const { deps, addToUserPath } = setup(
      offPath('C:\\Users\\me\\develop\\flutter\\bin\\flutter.bat'),
    );

    await addToolToPath('flutter', deps);

    expect(addToUserPath).toHaveBeenCalledWith('C:\\Users\\me\\develop\\flutter\\bin');
  });

  it('adds the folder a macOS or Linux tool was found in', async () => {
    const mac = setup(offPath('/Users/me/develop/flutter/bin/flutter'), 'darwin');
    const linux = setup(offPath('/home/me/develop/flutter/bin/flutter'), 'linux');

    await addToolToPath('flutter', mac.deps);
    await addToolToPath('flutter', linux.deps);

    expect(mac.addToUserPath).toHaveBeenCalledWith('/Users/me/develop/flutter/bin');
    expect(linux.addToUserPath).toHaveBeenCalledWith('/home/me/develop/flutter/bin');
  });

  it('keeps a space in a Windows folder name', async () => {
    const { deps, addToUserPath } = setup(offPath('C:\\Program Files\\Git\\cmd\\git.exe'));

    await addToolToPath('git', deps);

    expect(addToUserPath).toHaveBeenCalledWith('C:\\Program Files\\Git\\cmd');
  });
});

describe('addToolToPath: what it hands back', () => {
  it('returns whatever the PATH edit returned', async () => {
    const { deps } = setup(offPath('/home/me/bin/tool'), 'linux', {
      changed: false,
      where: '/home/me/.profile',
    });

    await expect(addToolToPath('flutter', deps)).resolves.toEqual({
      changed: false,
      where: '/home/me/.profile',
    });
  });

  it('lets an error from the PATH edit through unchanged', async () => {
    const { deps, addToUserPath } = setup(offPath('C:\\Users\\me\\100%\\tool.exe'));
    addToUserPath.mockRejectedValue(new Error('That folder cannot go on the PATH.'));

    await expect(addToolToPath('flutter', deps)).rejects.toThrow(
      'That folder cannot go on the PATH.',
    );
  });
});

describe('addToolToPath: looking first', () => {
  it('looks again rather than trusting what was remembered', async () => {
    const { deps, detect } = setup(offPath('/home/me/bin/tool'), 'linux');

    await addToolToPath('flutter', deps);

    expect(detect).toHaveBeenCalledWith('flutter', { force: true });
  });

  it('refuses a tool that is already on PATH, and changes nothing', async () => {
    const { deps, addToUserPath } = setup({
      state: 'found',
      version: '3.27.0',
      path: 'C:\\Flutter\\bin\\flutter.bat',
      onPath: true,
    });

    await expect(addToolToPath('flutter', deps)).rejects.toThrow(REFUSED);
    expect(addToUserPath).not.toHaveBeenCalled();
  });

  it('refuses a tool that was not found', async () => {
    const { deps, addToUserPath } = setup({ state: 'absent' });

    await expect(addToolToPath('flutter', deps)).rejects.toThrow(REFUSED);
    expect(addToUserPath).not.toHaveBeenCalled();
  });

  it('refuses a check that failed', async () => {
    const { deps, addToUserPath } = setup({ state: 'error', message: 'boom' });

    await expect(addToolToPath('flutter', deps)).rejects.toThrow(REFUSED);
    expect(addToUserPath).not.toHaveBeenCalled();
  });

  it('refuses a tool found without a location, since there is no folder to add', async () => {
    const { deps, addToUserPath } = setup(offPath(null));

    await expect(addToolToPath('flutter', deps)).rejects.toThrow(REFUSED);
    expect(addToUserPath).not.toHaveBeenCalled();
  });
});
