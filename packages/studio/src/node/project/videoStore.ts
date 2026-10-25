import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { GenerationView } from '../../api.js';
import { applyOps, type EditOp } from '../../document/ops.js';
import {
  type Aspect,
  createDocument,
  parseDocument,
  type StudioDocument,
} from '../../document/schema.js';
import { pushTx, type TxRef, type UndoStacks } from '../../document/undo.js';
import { videoFolderName } from '../../text/names.js';
import { BlobStore } from '../blobs/blobStore.js';
import {
  type CodeRevision,
  type GenerationPatch,
  HistoryDb,
  type HistoryEntry,
  type MediaRecord,
  type NewGeneration,
  type Revision,
  type TxActor,
} from '../db/history.js';
import type { OpenSqlDriver } from '../db/sqlDriver.js';
import { readJsonFile, writeFileAtomic } from '../fs/atomicWrite.js';
import { readTree } from '../scenes/codeTree.js';

/**
 * One Studio video on disk: a folder holding the manifest (`studio.json`), the history
 * (`studio.db`, the source of truth) and the current document (`document.json`, a copy kept for
 * anything that only wants to read). Every edit is committed to the history before `apply`
 * returns, so an edit the editor has seen acknowledged survives a crash. `document.json` is
 * written shortly after, and rebuilt from the history when it is behind or torn.
 *
 * The caller holds the folder's lock (lock.ts) before opening a store.
 */

export const MANIFEST_FILE = 'studio.json';
export const DOCUMENT_FILE = 'document.json';
export const DB_FILE = 'studio.db';
/**
 * Copies of each scene's current code, to open in an editor of one's own. Only a copy: a change
 * there is not used until it is brought in through Studio as a new revision.
 */
export const SCENES_DIR = 'scenes';

const manifestSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string(),
  linkedProjectId: z.string().nullable(),
  createdAt: z.number(),
});
export type VideoManifest = z.infer<typeof manifestSchema>;

export interface VideoStoreDeps {
  openDb: OpenSqlDriver;
  now: () => number;
  /** A full snapshot is stored after this many entries. */
  snapshotEvery?: number;
  /** How long after an edit `document.json` is rewritten. */
  materializeDelayMs?: number;
  /** The folder is on a network drive, where SQLite cannot use WAL. */
  network?: boolean;
}

export interface NewVideoInput {
  id: string;
  title: string;
  language: string;
  aspect?: Aspect;
  linkedProjectId: string | null;
}

export interface ApplyInput {
  /** The version the editor made the edit against. */
  baseSeq: number;
  ops: EditOp[];
  label: string;
  actor?: TxActor;
  generationId?: string | null;
}

export interface EditResult {
  seq: number;
  document: StudioDocument;
}

export interface VideoStatus {
  seq: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

/** The editor's copy is older than the video: someone else (an AI run, another window) changed it. */
export class StaleEditError extends Error {
  override name = 'StaleEditError';
  constructor(readonly currentSeq: number) {
    super('The video changed since this edit was made. Refresh and try again.');
  }
}

const DEFAULT_SNAPSHOT_EVERY = 100;

export async function createVideoFolder(
  root: string,
  input: NewVideoInput,
  deps: VideoStoreDeps,
): Promise<{ folder: string; manifest: VideoManifest }> {
  await mkdir(root, { recursive: true });
  const folder = join(root, videoFolderName(input.title, input.id));
  try {
    await mkdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A folder named ${folder} already exists.`);
    }
    throw error;
  }
  const manifest: VideoManifest = {
    formatVersion: 1,
    id: input.id,
    title: input.title,
    linkedProjectId: input.linkedProjectId,
    createdAt: deps.now(),
  };
  const document = createDocument(input);
  const db = HistoryDb.open(deps.openDb, join(folder, DB_FILE), { network: deps.network });
  try {
    db.setMeta('videoId', input.id);
    db.append(
      {
        at: manifest.createdAt,
        kind: 'mark',
        of: null,
        actor: 'system',
        label: 'Video created',
        generationId: null,
        ops: [],
        inverse: [],
      },
      document,
    );
  } finally {
    db.close();
  }
  await writeFileAtomic(join(folder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeMaterialized(folder, 1, document, deps.now());
  return { folder, manifest };
}

export async function readVideoManifest(folder: string): Promise<VideoManifest> {
  const read = await readJsonFile(join(folder, MANIFEST_FILE));
  const parsed = read.state === 'ok' ? manifestSchema.safeParse(read.value) : null;
  if (!parsed?.success) throw new Error(`${folder} is not a Studio video folder.`);
  return parsed.data;
}

async function writeMaterialized(
  folder: string,
  revision: number,
  document: StudioDocument,
  at: number,
) {
  const body = { revision, savedAt: at, document };
  await writeFileAtomic(join(folder, DOCUMENT_FILE), `${JSON.stringify(body)}\n`);
}

/** document.json, when it parses and holds a valid document. */
async function readMaterialized(
  folder: string,
): Promise<{ revision: number; document: StudioDocument } | null> {
  const read = await readJsonFile(join(folder, DOCUMENT_FILE));
  if (read.state !== 'ok') return null;
  const value = read.value as { revision?: unknown; document?: unknown };
  if (typeof value?.revision !== 'number') return null;
  try {
    return { revision: value.revision, document: parseDocument(value.document) };
  } catch {
    return null;
  }
}

export class VideoStore {
  private stacks: UndoStacks = { undo: [], redo: [] };
  private current: StudioDocument;
  private head: number;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Disk writes run one at a time, in order, so an older document never lands after a newer one. */
  private writes: Promise<void> = Promise.resolve();
  private readonly snapshotEvery: number;

  private constructor(
    readonly folder: string,
    private manifestValue: VideoManifest,
    private readonly db: HistoryDb,
    private readonly deps: VideoStoreDeps,
    document: StudioDocument,
    head: number,
    refs: TxRef[],
  ) {
    this.current = document;
    this.head = head;
    this.snapshotEvery = deps.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    for (const ref of refs) pushTx(this.stacks, ref);
  }

  static async open(folder: string, deps: VideoStoreDeps): Promise<VideoStore> {
    const manifest = await readVideoManifest(folder);
    const db = HistoryDb.open(deps.openDb, join(folder, DB_FILE), { network: deps.network });
    try {
      if (!db.quickCheck()) throw new Error('The history file of this video is damaged.');
      const saved = await readMaterialized(folder);
      if (db.head() === 0) {
        // The history file was lost or never finished. The last saved document is the best
        // starting point left, and a mark keeps undo from reaching past it.
        if (!saved)
          throw new Error('The history is missing and there is no saved copy to rebuild it from.');
        db.setMeta('videoId', manifest.id);
        db.append(
          {
            at: deps.now(),
            kind: 'mark',
            of: null,
            actor: 'system',
            label: 'Recovered from document.json',
            generationId: null,
            ops: [],
            inverse: [],
          },
          saved.document,
        );
      }
      // An AI run cannot outlive the app that started it.
      db.interruptRunning(deps.now());
      const head = db.head();
      const store = new VideoStore(
        folder,
        manifest,
        db,
        deps,
        documentAt(db, head),
        head,
        db.refs(),
      );
      if (saved?.revision !== head) await store.flush();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get document(): StudioDocument {
    return this.current;
  }

  get seq(): number {
    return this.head;
  }

  get manifest(): VideoManifest {
    return this.manifestValue;
  }

  get blobs(): BlobStore {
    return BlobStore.forVideo(this.folder);
  }

  addGeneration(generation: NewGeneration): void {
    this.assertOpen();
    this.db.addGeneration(generation);
  }

  updateGeneration(id: string, patch: GenerationPatch): void {
    this.assertOpen();
    this.db.updateGeneration(id, patch);
  }

  generation(id: string): GenerationView | undefined {
    return this.db.generation(id);
  }

  generations(options: { limit: number }): GenerationView[] {
    return this.db.generations(options);
  }

  status(): VideoStatus {
    const label = (seq: number | undefined, strip?: string) => {
      if (seq === undefined) return null;
      const text = this.db.tx(seq)?.label ?? null;
      return text && strip && text.startsWith(strip) ? text.slice(strip.length) : text;
    };
    return {
      seq: this.head,
      canUndo: this.stacks.undo.length > 0,
      canRedo: this.stacks.redo.length > 0,
      undoLabel: label(this.stacks.undo.at(-1), 'Redo: '),
      redoLabel: label(this.stacks.redo.at(-1), 'Undo: '),
    };
  }

  apply(input: ApplyInput): EditResult {
    this.assertOpen();
    if (input.baseSeq !== this.head) throw new StaleEditError(this.head);
    if (input.ops.length === 0) return { seq: this.head, document: this.current };
    return this.commit(
      'edit',
      null,
      input.ops,
      input.label,
      input.actor ?? 'user',
      input.generationId ?? null,
    );
  }

  undo(): EditResult | null {
    this.assertOpen();
    const target = this.stacks.undo.at(-1);
    if (target === undefined) return null;
    const tx = this.db.tx(target);
    if (!tx) return null;
    const label = tx.label.startsWith('Redo: ') ? tx.label.slice(6) : tx.label;
    return this.commit('undo', target, tx.inverse, `Undo: ${label}`, 'user', null);
  }

  redo(): EditResult | null {
    this.assertOpen();
    const target = this.stacks.redo.at(-1);
    if (target === undefined) return null;
    const tx = this.db.tx(target);
    if (!tx) return null;
    const label = tx.label.startsWith('Undo: ') ? tx.label.slice(6) : tx.label;
    return this.commit('redo', target, tx.inverse, `Redo: ${label}`, 'user', null);
  }

  /** Puts back the video as it was at version `seq`, as a new entry. Nothing is thrown away. */
  restore(seq: number): EditResult {
    const earlier = this.documentAt(seq);
    const result = this.commit(
      'edit',
      null,
      [{ op: 'doc.replace', document: earlier }],
      `Restored version ${seq}`,
      'user',
      null,
      true,
    );
    this.db.addRevision({
      seq: result.seq,
      at: this.deps.now(),
      label: `Restored version ${seq}`,
      kind: 'restore',
    });
    return result;
  }

  documentAt(seq: number): StudioDocument {
    if (!Number.isInteger(seq) || seq < 1 || seq > this.head) {
      throw new Error(`There is no version ${seq} of this video.`);
    }
    return documentAt(this.db, seq);
  }

  history(options: { before?: number; limit: number }): HistoryEntry[] {
    return this.db.entries(options);
  }

  /**
   * Points a scene at a code tree (already in the blob store), as one history entry, and records
   * the revision. Undo puts the scene back on its previous tree; the revision list keeps them all.
   */
  setSceneCode(input: {
    sceneId: string;
    treeHash: string;
    author: CodeRevision['author'];
    label: string;
    generationId?: string | null;
  }): EditResult {
    this.assertOpen();
    const scene = this.current.scenario.scenes.find((s) => s.id === input.sceneId);
    if (!scene) throw new Error('That scene is not in the video any more.');
    const result = this.commit(
      'edit',
      null,
      [
        {
          op: 'scene.update',
          sceneId: input.sceneId,
          patch: { code: { treeHash: input.treeHash } },
        },
      ],
      input.label,
      input.author,
      input.generationId ?? null,
    );
    const parent = this.db.codeRevisions(input.sceneId)[0];
    this.db.addCodeRevision({
      sceneId: input.sceneId,
      treeHash: input.treeHash,
      parentId: parent?.id ?? null,
      generationId: input.generationId ?? null,
      author: input.author,
      label: input.label,
      at: this.deps.now(),
    });
    return result;
  }

  addMedia(record: MediaRecord): MediaRecord {
    return this.db.addMedia(record);
  }

  media(hash: string): MediaRecord | undefined {
    return this.db.media(hash);
  }

  mediaList(): MediaRecord[] {
    return this.db.mediaList();
  }

  /** A code tree's thumbnail (a PNG blob), from the check that passed it. */
  setThumbnail(treeHash: string, pngHash: string): void {
    this.db.setMeta(`thumbnail:${treeHash}`, pngHash);
  }

  thumbnail(treeHash: string): string | null {
    return this.db.getMeta(`thumbnail:${treeHash}`);
  }

  codeRevisions(sceneId: string): CodeRevision[] {
    return this.db.codeRevisions(sceneId);
  }

  /** Rewrites `scenes/<id>/` from the scene's current tree. Best effort: it is only a copy. */
  async mirrorScene(sceneId: string): Promise<void> {
    const dir = join(this.folder, SCENES_DIR, sceneId);
    const treeHash = this.current.scenario.scenes.find((s) => s.id === sceneId)?.code.treeHash;
    try {
      await rm(dir, { recursive: true, force: true });
      if (!treeHash) return;
      const manifest = await readTree(this.blobs, treeHash);
      for (const file of manifest.files) {
        const target = join(dir, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await this.blobs.bytes(file.hash));
      }
    } catch {
      // The history and the blobs hold the code; a copy that could not be written costs nothing.
    }
  }

  revisions(): Revision[] {
    return this.db.revisions();
  }

  /** Writes document.json (and the manifest, if the title changed) now. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const revision = this.head;
    const document = this.current;
    const at = this.deps.now();
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await writeMaterialized(this.folder, revision, document, at);
        if (document.title !== this.manifestValue.title) {
          this.manifestValue = { ...this.manifestValue, title: document.title };
          await writeFileAtomic(
            join(this.folder, MANIFEST_FILE),
            `${JSON.stringify(this.manifestValue, null, 2)}\n`,
          );
        }
      });
    await this.writes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.db.close();
  }

  /** Stops as a crash would: the history is closed, nothing pending is written. Tests only. */
  crashForTest(): void {
    if (this.timer) clearTimeout(this.timer);
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('This video is closed.');
  }

  private commit(
    kind: 'edit' | 'undo' | 'redo',
    of: number | null,
    ops: EditOp[],
    label: string,
    actor: TxActor,
    generationId: string | null,
    forceSnapshot = false,
  ): EditResult {
    this.assertOpen();
    const { document, inverse } = applyOps(this.current, ops);
    const dueSnapshot =
      forceSnapshot || this.head + 1 - this.db.lastSnapshotSeq() >= this.snapshotEvery;
    const seq = this.db.append(
      { at: this.deps.now(), kind, of, actor, label, generationId, ops, inverse },
      dueSnapshot ? document : undefined,
    );
    this.current = document;
    this.head = seq;
    pushTx(this.stacks, { seq, kind, of });
    this.scheduleMaterialize();
    return { seq, document };
  }

  private scheduleMaterialize(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.flush().catch(() => undefined),
      this.deps.materializeDelayMs ?? 1000,
    );
    this.timer.unref?.();
  }
}

/** The document at `seq`: the nearest snapshot at or before it, with the entries after it replayed. */
function documentAt(db: HistoryDb, seq: number): StudioDocument {
  const snapshot = db.snapshotAtOrBefore(seq);
  if (!snapshot) throw new Error('The history of this video has no starting point.');
  let document = snapshot.document;
  for (const tx of db.txsBetween(snapshot.seq, seq)) document = applyOps(document, tx.ops).document;
  return document;
}
