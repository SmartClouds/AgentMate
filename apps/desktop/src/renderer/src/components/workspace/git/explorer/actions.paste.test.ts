// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { explorerProject, useExplorerStore } from '@/stores/explorerStore';
import { type FakeBridge, installRunovaBridge } from '../../../../../../test/renderer/runovaBridge';
import { copyToClipboard, pasteInto, transferExternalEntries } from './actions';

/**
 * Pasting into the explorer, from either the in-app clipboard or files copied in Explorer/Finder.
 * The OS clipboard says which came last: copying in the app takes it over too, so files found
 * there at paste time were copied afterwards and win.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;

let bridge: FakeBridge;

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  bridge = installRunovaBridge();
  useExplorerStore.setState({ clipboard: null, projects: {} });
});

describe('pasteInto', () => {
  it('copies from the OS clipboard when the in-app clipboard is empty', async () => {
    bridge.$set('explorer.osClipboardPaths', ['C:\\shots\\a.png']);
    bridge.$set('explorer.pasteExternal', {
      moves: [{ from: 'C:\\shots\\a.png', to: 'C:\\work\\app\\a.png' }],
      conflicts: [],
    });

    await pasteInto(project, project.folderPath);

    expect(bridge.$fn('explorer.pasteExternal')).toHaveBeenCalledWith(
      'p1',
      ['C:\\shots\\a.png'],
      project.folderPath,
    );
  });

  it('uses the in-app clipboard when the OS clipboard holds no files', async () => {
    useExplorerStore.setState({
      clipboard: { mode: 'copy', projectId: 'p1', paths: ['C:\\work\\app\\a.txt'] },
    });
    bridge.$set('explorer.osClipboardPaths', []);
    bridge.$set('explorer.copy', {
      moves: [{ from: 'C:\\work\\app\\a.txt', to: 'C:\\work\\app\\sub\\a.txt' }],
      conflicts: [],
    });

    await pasteInto(project, 'C:\\work\\app\\sub');

    expect(bridge.$fn('explorer.copy')).toHaveBeenCalledWith(
      'p1',
      ['C:\\work\\app\\a.txt'],
      'C:\\work\\app\\sub',
    );
    expect(() => bridge.$fn('explorer.pasteExternal')).toThrow('has not been touched');
  });

  it('prefers files copied in the OS after an in-app copy, and forgets the stale in-app one', async () => {
    // An in-app copy takes the OS clipboard too, so files there were copied after it.
    useExplorerStore.setState({
      clipboard: { mode: 'copy', projectId: 'p1', paths: ['C:\\work\\app\\src'] },
    });
    bridge.$set('explorer.osClipboardPaths', ['C:\\shots\\b']);
    bridge.$set('explorer.pasteExternal', { moves: [], conflicts: [] });

    await pasteInto(project, project.folderPath);
    await pasteInto(project, project.folderPath);

    expect(bridge.$fn('explorer.pasteExternal')).toHaveBeenCalledTimes(2);
    expect(bridge.$fn('explorer.pasteExternal')).toHaveBeenLastCalledWith(
      'p1',
      ['C:\\shots\\b'],
      project.folderPath,
    );
    expect(() => bridge.$fn('explorer.copy')).toThrow('has not been touched');
    expect(useExplorerStore.getState().clipboard).toBeNull();
  });

  it('pastes a copied folder beside itself when it is pasted onto itself', async () => {
    useExplorerStore.setState({
      clipboard: { mode: 'copy', projectId: 'p1', paths: ['C:\\work\\app\\src'] },
    });
    bridge.$set('explorer.osClipboardPaths', []);
    bridge.$set('explorer.copy', { moves: [], conflicts: [] });

    await pasteInto(project, 'C:\\work\\app\\src');

    expect(bridge.$fn('explorer.copy')).toHaveBeenCalledWith(
      'p1',
      ['C:\\work\\app\\src'],
      'C:\\work\\app',
    );
  });

  it('pastes an OS-copied folder beside itself too, whatever case Explorer spelled it in', async () => {
    bridge.$set('explorer.osClipboardPaths', ['c:\\Work\\App\\src']);
    bridge.$set('explorer.pasteExternal', { moves: [], conflicts: [] });

    await pasteInto(project, 'C:\\work\\app\\src');

    expect(bridge.$fn('explorer.pasteExternal')).toHaveBeenCalledWith(
      'p1',
      ['c:\\Work\\App\\src'],
      'C:\\work\\app',
    );
  });

  it('falls back to the OS clipboard when the in-app clipboard belongs to a different project', async () => {
    useExplorerStore.setState({
      clipboard: { mode: 'copy', projectId: 'p2', paths: ['C:\\work\\other\\a.txt'] },
    });
    bridge.$set('explorer.osClipboardPaths', ['C:\\shots\\a.png']);
    bridge.$set('explorer.pasteExternal', {
      moves: [{ from: 'C:\\shots\\a.png', to: 'C:\\work\\app\\a.png' }],
      conflicts: [],
    });

    await pasteInto(project, project.folderPath);

    expect(bridge.$fn('explorer.pasteExternal')).toHaveBeenCalledWith(
      'p1',
      ['C:\\shots\\a.png'],
      project.folderPath,
    );
  });

  it('does nothing when neither clipboard has anything to paste', async () => {
    bridge.$set('explorer.osClipboardPaths', []);

    await pasteInto(project, project.folderPath);

    expect(() => bridge.$fn('explorer.pasteExternal')).toThrow('has not been touched');
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('copyToClipboard', () => {
  it('puts the copied paths on the OS clipboard too, so older OS files stop shadowing it', () => {
    copyToClipboard(project, ['C:\\work\\app\\src', 'C:\\work\\app\\a.txt'], 'copy');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'C:\\work\\app\\src\nC:\\work\\app\\a.txt',
    );
    expect(useExplorerStore.getState().clipboard).toEqual({
      mode: 'copy',
      projectId: 'p1',
      paths: ['C:\\work\\app\\src', 'C:\\work\\app\\a.txt'],
    });
  });

  it('lets a paste right after it read the OS clipboard only once the copy has landed there', async () => {
    let land: () => void = () => undefined;
    vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    bridge.$set('explorer.osClipboardPaths', []);
    bridge.$set('explorer.copy', { moves: [], conflicts: [] });

    copyToClipboard(project, ['C:\\work\\app\\a.txt'], 'copy');
    const pasted = pasteInto(project, 'C:\\work\\app\\sub');
    await Promise.resolve();
    expect(() => bridge.$fn('explorer.osClipboardPaths')).toThrow('has not been touched');

    land();
    await pasted;
    expect(bridge.$fn('explorer.copy')).toHaveBeenCalled();
  });
});

describe('transferExternalEntries', () => {
  it('opens the target folder and selects what landed, the same as an ordinary copy', async () => {
    bridge.$set('explorer.pasteExternal', {
      moves: [{ from: 'C:\\shots\\a.png', to: 'C:\\work\\app\\sub\\a.png' }],
      conflicts: [],
    });

    const ok = await transferExternalEntries(project, ['C:\\shots\\a.png'], 'C:\\work\\app\\sub');

    expect(ok).toBe(true);
    const state = explorerProject('p1');
    expect(state.open['C:\\work\\app\\sub']).toBe(true);
    expect(state.selected).toEqual(['C:\\work\\app\\sub\\a.png']);
  });

  it('reports the failure with a toast when the external copy rejects', async () => {
    bridge.$set('explorer.pasteExternal', () => Promise.reject(new Error('disk full')));

    const ok = await transferExternalEntries(project, ['C:\\shots\\a.png'], project.folderPath);

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Could not copy', { description: 'disk full' });
  });
});
