import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocument } from '../../document/schema.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { HistoryDb, type NewGeneration, type NewTx } from './history.js';

const tempDir = useTempDirs();
const opened: HistoryDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function openDb(file?: string): Promise<HistoryDb> {
  const db = HistoryDb.open(openNodeSqlite, file ?? join(await tempDir(), 'studio.db'));
  opened.push(db);
  return db;
}

function tx(over: Partial<NewTx> = {}): NewTx {
  return {
    at: 1000,
    kind: 'edit',
    of: null,
    actor: 'user',
    label: 'Edited the title',
    generationId: null,
    ops: [{ op: 'doc.set', field: 'title', value: 'New' }],
    inverse: [{ op: 'doc.set', field: 'title', value: 'Old' }],
    ...over,
  };
}

describe('HistoryDb', () => {
  it('starts empty', async () => {
    const db = await openDb();
    expect(db.head()).toBe(0);
    expect(db.refs()).toEqual([]);
  });

  it('numbers entries in order and reads them back whole', async () => {
    const db = await openDb();
    expect(db.append(tx({ label: 'one' }))).toBe(1);
    expect(db.append(tx({ label: 'two', actor: 'ai', generationId: 'g1' }))).toBe(2);
    expect(db.head()).toBe(2);
    expect(db.tx(2)).toEqual({ seq: 2, ...tx({ label: 'two', actor: 'ai', generationId: 'g1' }) });
    expect(db.tx(9)).toBeUndefined();
  });

  it('lists the refs undo needs, oldest first', async () => {
    const db = await openDb();
    db.append(tx());
    db.append(tx({ kind: 'undo', of: 1 }));
    expect(db.refs()).toEqual([
      { seq: 1, kind: 'edit', of: null },
      { seq: 2, kind: 'undo', of: 1 },
    ]);
  });

  it('stores a snapshot with an entry and finds the latest one at or before a point', async () => {
    const db = await openDb();
    const first = createDocument({ id: 'v1', title: 'First', language: 'en' });
    const later = createDocument({ id: 'v1', title: 'Later', language: 'en' });
    db.append(tx({ kind: 'mark' }), first);
    db.append(tx());
    db.append(tx(), later);
    db.append(tx());
    expect(db.snapshotAtOrBefore(2)).toEqual({ seq: 1, document: first });
    expect(db.snapshotAtOrBefore(4)).toEqual({ seq: 3, document: later });
    expect(db.snapshotAtOrBefore(0)).toBeUndefined();
    expect(db.lastSnapshotSeq()).toBe(3);
  });

  it('reads the entries between two points for a replay', async () => {
    const db = await openDb();
    for (let i = 0; i < 5; i += 1) db.append(tx({ label: `e${i}` }));
    expect(db.txsBetween(2, 4).map((t) => t.label)).toEqual(['e2', 'e3']);
  });

  it('pages the history newest first, without the op payloads', async () => {
    const db = await openDb();
    for (let i = 1; i <= 5; i += 1) db.append(tx({ label: `e${i}`, at: i }));
    expect(db.entries({ limit: 2 }).map((e) => e.label)).toEqual(['e5', 'e4']);
    expect(db.entries({ before: 4, limit: 10 }).map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(db.entries({ limit: 1 })[0]).toEqual({
      seq: 5,
      at: 5,
      kind: 'edit',
      of: null,
      actor: 'user',
      label: 'e5',
      generationId: null,
      opCount: 1,
    });
  });

  it('never lets history be changed or deleted, even by hand-written SQL', async () => {
    const file = join(await tempDir(), 'studio.db');
    const db = await openDb(file);
    db.append(tx(), createDocument({ id: 'v1', title: 'A', language: 'en' }));
    db.addRevision({ seq: 1, at: 1, label: 'Scenario written', kind: 'milestone' });
    for (const sql of [
      'UPDATE txs SET label = 1',
      'DELETE FROM txs',
      'UPDATE snapshots SET hash = 1',
      'DELETE FROM snapshots',
      'UPDATE revisions SET label = 1',
      'DELETE FROM revisions',
    ]) {
      expect(() => db.unsafeExec(sql), sql).toThrow(/append-only/);
    }
    expect(db.head()).toBe(1);
  });

  it('keeps the metadata it is given', async () => {
    const db = await openDb();
    db.setMeta('videoId', 'v1');
    db.setMeta('videoId', 'v2');
    expect(db.getMeta('videoId')).toBe('v2');
    expect(db.getMeta('missing')).toBeNull();
  });

  it('lists named milestones', async () => {
    const db = await openDb();
    db.append(tx());
    db.addRevision({ seq: 1, at: 5, label: 'Scenario written', kind: 'milestone' });
    expect(db.revisions()).toEqual([
      { id: 1, seq: 1, at: 5, label: 'Scenario written', kind: 'milestone' },
    ]);
  });

  it('writes an entry and its snapshot together or not at all', async () => {
    const db = await openDb();
    const broken = { ...createDocument({ id: 'v1', title: 'A', language: 'en' }) } as never;
    expect(() =>
      db.append(tx(), {
        toJSON: () => {
          throw new Error('boom');
        },
      } as never),
    ).toThrow('boom');
    expect(db.head()).toBe(0);
    db.append(tx(), broken);
    expect(db.head()).toBe(1);
  });

  it('passes an integrity check on a healthy file', async () => {
    const db = await openDb();
    expect(db.quickCheck()).toBe(true);
  });

  it('holds the file exclusively, so a second writer cannot open it', async () => {
    const file = join(await tempDir(), 'studio.db');
    const db = await openDb(file);
    db.append(tx());
    expect(() => HistoryDb.open(openNodeSqlite, file, { busyTimeoutMs: 50 })).toThrow(
      /locked|busy/i,
    );
  });
});

describe('HistoryDb generations', () => {
  const generation = (over: Partial<NewGeneration> = {}): NewGeneration => ({
    id: 'g1',
    parentId: null,
    stage: 'scenario',
    status: 'running',
    cliId: 'claude-code',
    cliName: null,
    model: 'opus',
    effort: 'high',
    instruction: 'A video about water',
    params: { targetSeconds: 45, styleId: null },
    startedAt: 1000,
    ...over,
  });

  it('records a generation and reads it back with its attempts', async () => {
    const db = await openDb();
    db.addGeneration(generation());
    db.updateGeneration('g1', {
      cliName: 'Claude Code',
      attempts: [
        {
          requestHash: 'a'.repeat(64),
          outputHash: null,
          logHash: null,
          startedAt: 1000,
          finishedAt: 2000,
          issues: ['x'],
          error: null,
        },
      ],
    });
    db.updateGeneration('g1', { status: 'done', resultSeq: 7, finishedAt: 3000 });
    expect(db.generation('g1')).toMatchObject({
      id: 'g1',
      stage: 'scenario',
      status: 'done',
      cliName: 'Claude Code',
      model: 'opus',
      effort: 'high',
      params: { targetSeconds: 45, styleId: null },
      resultSeq: 7,
      finishedAt: 3000,
      proposal: null,
      error: null,
    });
    expect(db.generation('g1')?.attempts).toHaveLength(1);
    expect(db.generation('nope')).toBeUndefined();
  });

  it('lists generations newest first', async () => {
    const db = await openDb();
    db.addGeneration(generation({ id: 'g1', startedAt: 1 }));
    db.addGeneration(generation({ id: 'g2', startedAt: 2, stage: 'edit' }));
    expect(db.generations({ limit: 10 }).map((g) => g.id)).toEqual(['g2', 'g1']);
    expect(db.generations({ limit: 1 }).map((g) => g.id)).toEqual(['g2']);
  });

  it('marks runs left running by a crash as interrupted', async () => {
    const db = await openDb();
    db.addGeneration(generation({ id: 'g1' }));
    db.addGeneration(generation({ id: 'g2', status: 'done' }));
    expect(db.interruptRunning(5000)).toBe(1);
    expect(db.generation('g1')).toMatchObject({ status: 'interrupted', finishedAt: 5000 });
    expect(db.generation('g2')?.status).toBe('done');
  });

  it('never lets a generation record be deleted', async () => {
    const db = await openDb();
    db.addGeneration(generation());
    expect(() => db.unsafeExec("DELETE FROM generations WHERE id = 'g1'")).toThrow(/append-only/);
  });
});
