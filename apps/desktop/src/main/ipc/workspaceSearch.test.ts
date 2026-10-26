import { beforeEach, describe, expect, it } from 'vitest';
import type { SymbolIndex, TextSearchBatch, TextSearchSummary } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { tempDir, writeTree } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import { ripgrepPath } from '../search/ripgrepPath';

/**
 * The workspace search's side of IPC. The renderer names a project by id and never a folder,
 * so every search stays inside a folder the app already knows about.
 */

const userData = useTempUserData();
const PROJECT_ID = 'p1';
const project = { dir: '' };

expectChannelsCovered(IPC.workspaceSearch, [IPC.workspaceSearch.onTextResults]);

const PLAIN = { matchCase: false, wholeWord: false, regex: false };

beforeEach(async () => {
  project.dir = writeTree(tempDir('runova-wsearch-'), {
    'src/store.ts': 'export class UserStore {\n  load() {\n    return needle;\n  }\n}\n',
    'README.md': 'needle in the readme\n',
  });
  userData.writeData('projects.json', [
    { id: PROJECT_ID, name: 'Demo', folderPath: project.dir, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  await loadIpc(
    () => import('./workspaceSearch'),
    (module) => module.registerWorkspaceSearchHandlers(),
  );
});

describe('workspace search IPC', () => {
  it('refuses a project it does not know', async () => {
    await expect(
      invoke(IPC.workspaceSearch.text, 'nope', 'r1', { ...PLAIN, query: 'x' }),
    ).rejects.toThrow('That project no longer exists.');
    await expect(invoke(IPC.workspaceSearch.symbols, 'nope')).rejects.toThrow(
      'That project no longer exists.',
    );
  });

  it('refuses a malformed request id', async () => {
    await expect(
      invoke(IPC.workspaceSearch.text, PROJECT_ID, 'x'.repeat(65), { ...PLAIN, query: 'x' }),
    ).rejects.toThrow('not valid');
    await expect(invoke(IPC.workspaceSearch.cancel, 42)).rejects.toThrow('not valid');
  });

  it.skipIf(!ripgrepPath())('streams text matches to the window that asked', async () => {
    const sender = fakeWebContents();
    const summary = await invokeFrom<TextSearchSummary>(
      sender,
      IPC.workspaceSearch.text,
      PROJECT_ID,
      'r1',
      { ...PLAIN, query: 'needle' },
    );
    expect(summary).toMatchObject({ requestId: 'r1', matches: 2, files: 2 });
    const batches = sender
      .sentOn(IPC.workspaceSearch.onTextResults)
      .map(([batch]) => batch as TextSearchBatch);
    expect(batches.every((batch) => batch.requestId === 'r1')).toBe(true);
    expect(batches.flatMap((batch) => batch.files.map((file) => file.path)).sort()).toEqual([
      'README.md',
      'src/store.ts',
    ]);
  });

  it('says a cancel for a finished search found nothing to stop', async () => {
    expect(await invoke(IPC.workspaceSearch.cancel, 'long-gone')).toBe(false);
  });

  it.skipIf(!ripgrepPath())('hands over the symbol index, then only news', async () => {
    const index = await invoke<SymbolIndex>(IPC.workspaceSearch.symbols, PROJECT_ID);
    expect(index.names).toEqual(['UserStore', 'load']);
    expect(await invoke(IPC.workspaceSearch.symbols, PROJECT_ID, index.version)).toEqual({
      unchanged: true,
      version: index.version,
    });
  });
});
