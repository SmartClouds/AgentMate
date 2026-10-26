import type { ActivityEvent } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PromptHistoryEntry } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Prompt history over the real SQLite store (through the node:sqlite stand-in), so the search and
 * the per-project scoping run as real queries rather than as a mock's idea of them. Adding an
 * entry also writes an activity line, and the wording of that line is built from parts that a
 * translation does not have, which is where it went wrong before.
 */

const userData = useTempUserData();
expectChannelsCovered(IPC.promptHistory);

async function register(): Promise<void> {
  await loadIpc(
    () => import('./promptHistory'),
    (module) => module.registerPromptHistoryHandlers(),
  );
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    rawInput: 'add a login form',
    content: 'You are a senior engineer. Build a login form.',
    promptType: 'Full Stack',
    targetAI: 'Claude Code',
    source: 'generate',
    projectId: null,
    ...overrides,
  };
}

async function activity(): Promise<ActivityEvent[]> {
  const { store } = await import('../store');
  return store.getActivity();
}

beforeEach(async () => {
  await register();
});

describe('prompt history', () => {
  it('is empty on a fresh profile', async () => {
    await expect(invoke(IPC.promptHistory.list)).resolves.toEqual([]);
  });

  it('adds an entry and lists it back', async () => {
    const added = await invoke<PromptHistoryEntry>(IPC.promptHistory.add, entry());

    expect(added).toMatchObject({ rawInput: 'add a login form', promptType: 'Full Stack' });
    const listed = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list);
    expect(listed.map((one) => one.id)).toEqual([added.id]);
  });

  it('lists only the entries of one project when asked for it', async () => {
    await invoke(IPC.promptHistory.add, entry({ projectId: 'p1', rawInput: 'mine' }));
    await invoke(IPC.promptHistory.add, entry({ projectId: 'p2', rawInput: 'theirs' }));

    const mine = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list, 'p1');

    expect(mine.map((one) => one.rawInput)).toEqual(['mine']);
  });

  it('searches the text of the prompt and of what was asked for', async () => {
    await invoke(IPC.promptHistory.add, entry({ rawInput: 'add a login form' }));
    await invoke(
      IPC.promptHistory.add,
      entry({ rawInput: 'write release notes', content: 'Summarize the changes since v1.' }),
    );

    const hits = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.search, 'login');

    expect(hits.map((one) => one.rawInput)).toEqual(['add a login form']);
  });

  it('keeps a search inside the project it was made in', async () => {
    await invoke(IPC.promptHistory.add, entry({ projectId: 'p1', rawInput: 'login for p1' }));
    await invoke(IPC.promptHistory.add, entry({ projectId: 'p2', rawInput: 'login for p2' }));

    const hits = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.search, 'login', 'p1');

    expect(hits.map((one) => one.rawInput)).toEqual(['login for p1']);
  });

  it('writes an activity line naming the prompt type and the target', async () => {
    await invoke(IPC.promptHistory.add, entry());

    const events = await activity();
    expect(events[0]?.message).toBe('Generated a Full Stack prompt for Claude Code');
  });

  it('says translated, and leaves out the parts a translation does not have', async () => {
    // A translation carries no prompt type or target, and the sentence used to read
    // "Generated a undefined prompt for undefined". The columns are not nullable, so the
    // renderer sends empty strings rather than nulls.
    await invoke(
      IPC.promptHistory.add,
      entry({ source: 'translate', promptType: '', targetAI: '' }),
    );

    const events = await activity();
    expect(events[0]?.message).toBe('Translated a prompt');
  });

  it('sets tags and reads them back', async () => {
    const added = await invoke<PromptHistoryEntry>(IPC.promptHistory.add, entry());

    await invoke(IPC.promptHistory.setTags, added.id, ['login', 'ui']);

    const [stored] = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list);
    expect(stored.tags).toEqual(['login', 'ui']);
  });

  it('moves an entry to another project, and back to none', async () => {
    const added = await invoke<PromptHistoryEntry>(IPC.promptHistory.add, entry());

    await invoke(IPC.promptHistory.setProject, added.id, 'p1');
    expect(await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list, 'p1')).toHaveLength(1);

    await invoke(IPC.promptHistory.setProject, added.id, null);
    expect(await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list, 'p1')).toEqual([]);
  });

  it('removes an entry and leaves the rest', async () => {
    const doomed = await invoke<PromptHistoryEntry>(IPC.promptHistory.add, entry());
    await invoke(IPC.promptHistory.add, entry({ rawInput: 'kept' }));

    await invoke(IPC.promptHistory.remove, doomed.id);

    const listed = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list);
    expect(listed.map((one) => one.rawInput)).toEqual(['kept']);
  });

  it('keeps the history in the database across a restart', async () => {
    await invoke(IPC.promptHistory.add, entry({ rawInput: 'survives' }));

    await register();

    const listed = await invoke<PromptHistoryEntry[]>(IPC.promptHistory.list);
    expect(listed.map((one) => one.rawInput)).toEqual(['survives']);
    // The database lives under the profile this test was given, not the real one.
    expect(userData.dir).toBeTruthy();
  });
});
