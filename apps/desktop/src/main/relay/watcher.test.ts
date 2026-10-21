import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayWatcher } from './watcher';

/** The board's live updates, against real folders (fs.watch). */

let root: string;
let tasksDir: string;
let handoffsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-watch-'));
  tasksDir = join(root, 'docs', 'tasks');
  handoffsDir = join(tasksDir, 'handoffs');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function watcher(onChange = vi.fn()) {
  const instance = createRelayWatcher({
    resolve: async () => ({ tasksDir, handoffsDir }),
    onChange,
    debounceMs: 40,
    retryMs: 50,
  });
  return { instance, onChange };
}

describe('createRelayWatcher', () => {
  it('reports task and handoff changes once per burst', async () => {
    mkdirSync(handoffsDir, { recursive: true });
    const { instance, onChange } = watcher();
    instance.watch('p1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(join(tasksDir, 'T001-a.md'), 'a');
    writeFileSync(join(handoffsDir, 'T001.md'), 'b');
    writeFileSync(join(handoffsDir, 'T001.md'), 'c');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const merged = onChange.mock.calls.map(([, change]) => change);
    expect(merged.some((change) => change.tasks)).toBe(true);
    expect(merged.flatMap((change) => change.handoffs)).toContain('T001');
    instance.dispose();
  });

  it('ignores the guide and other notes', async () => {
    mkdirSync(handoffsDir, { recursive: true });
    const { instance, onChange } = watcher();
    instance.watch('p1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(join(tasksDir, 'RELAY.md'), 'guide');
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const [, change] of onChange.mock.calls) {
      expect(change).toEqual({ handoffs: [], tasks: false });
    }
    instance.dispose();
  });

  it('starts watching a folder that only appears later', async () => {
    const { instance, onChange } = watcher();
    instance.watch('p1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    mkdirSync(handoffsDir, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(join(handoffsDir, 'T002.md'), 'x');
    await vi.waitFor(
      () => expect(onChange.mock.calls.flatMap(([, change]) => change.handoffs)).toContain('T002'),
      { timeout: 2000 },
    );
    instance.dispose();
  });

  it('holds a project while it is watched or live, and lets go after', () => {
    const { instance } = watcher();
    instance.watch('p1');
    instance.setLive(['p1', 'p2']);
    instance.unwatch('p1');
    expect(instance.watching().sort()).toEqual(['p1', 'p2']);
    instance.setLive([]);
    expect(instance.watching()).toEqual([]);
    instance.dispose();
  });
});
