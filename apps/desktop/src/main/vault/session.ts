import { randomUUID } from 'node:crypto';
import {
  applySaveInput,
  duplicateEntry,
  masterPasswordProblem,
  normalizeTags,
  readEntryField,
  type SaveVaultEntryInput,
  SaveVaultEntryInputSchema,
  toEntrySummary,
  type VaultEntry,
  VaultEntrySchema,
  type VaultEntrySummary,
  type VaultFieldRef,
  type VaultPayload,
  VaultPayloadSchema,
} from '@runova/core';
import type { VaultErrorCode } from '../../shared/vaultErrors';
import {
  createVaultFile,
  openVaultFile,
  readVaultFileShape,
  rewrapVaultFile,
  sealVaultData,
  type VaultFileV1,
} from './format';
import { DEFAULT_VAULT_KDF_COST, isWeakerThan, type KdfCost } from './kdf';
import type { VaultFilePort } from './ports';

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultSessionOptions {
  files: VaultFilePort;
  cost?: KdfCost;
  now?: () => number;
  newId?: () => string;
  /** How long "last used" updates wait before they are written, so copying a few fields writes once. */
  lastUsedFlushMs?: number;
}

interface Unlocked {
  file: VaultFileV1;
  dataKey: Buffer;
  createdAt: number;
  entries: VaultEntry[];
}

const LOCKED = () => new VaultError('locked', 'The vault is locked.');

function describeInvalid(error: unknown): string {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (issues?.length) {
    const [issue] = issues;
    const path = issue.path.map(String).join('.');
    if (path === 'title') return 'Give the entry a title.';
    return path ? `${path}: ${issue.message}` : issue.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The unlocked vault in main. Decrypted entries live here and nowhere else; the renderer only
 * ever gets summaries, plus the one value it asked to reveal. Every change is written through a
 * queue that seals a copy and only swaps it in after the file write succeeds.
 */
export class VaultSession {
  private unlocked: Unlocked | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private usedDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly files: VaultFilePort;
  private readonly cost: KdfCost;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly lastUsedFlushMs: number;

  constructor(options: VaultSessionOptions) {
    this.files = options.files;
    this.cost = options.cost ?? DEFAULT_VAULT_KDF_COST;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.lastUsedFlushMs = options.lastUsedFlushMs ?? 2000;
  }

  isUnlocked(): boolean {
    return this.unlocked !== null;
  }

  async state(): Promise<VaultState> {
    if (this.unlocked) return 'unlocked';
    return (await this.files.read()) === null ? 'uninitialized' : 'locked';
  }

  async create(password: string): Promise<void> {
    const problem = masterPasswordProblem(password);
    if (problem) throw new VaultError('weak-password', problem);
    if (this.unlocked || (await this.files.read()) !== null) {
      throw new VaultError('exists', 'A vault already exists.');
    }
    const payload: VaultPayload = { schemaVersion: 1, createdAt: this.now(), entries: [] };
    const { file, dataKey } = await createVaultFile(password, payload, this.cost);
    await this.files.write(file);
    this.unlocked = { file, dataKey, createdAt: payload.createdAt, entries: [] };
  }

  /** False for a wrong password. Throws for a missing or damaged vault. */
  async unlock(password: string): Promise<boolean> {
    if (this.unlocked) return true;
    const raw = await this.files.read();
    if (raw === null) throw new VaultError('uninitialized', 'There is no vault yet.');
    let file = readVaultFileShape(raw);
    const opened = file ? await openVaultFile(file, password) : 'corrupt';
    if (opened === 'wrong-password') return false;
    if (opened === 'corrupt' || !file) {
      throw new VaultError('corrupt', 'The vault file is damaged and cannot be opened.');
    }

    if (isWeakerThan(file.kdf, this.cost)) {
      try {
        const upgraded = await rewrapVaultFile(opened.payload, password, this.cost, {
          dataKey: opened.dataKey,
          rotateDataKey: false,
        });
        await this.files.write(upgraded.file);
        file = upgraded.file;
      } catch {
        // Still opens fine under the old cost. The upgrade is retried on the next unlock.
      }
    }
    this.unlocked = {
      file,
      dataKey: opened.dataKey,
      createdAt: opened.payload.createdAt,
      entries: opened.payload.entries,
    };
    return true;
  }

  async lock(): Promise<void> {
    if (!this.unlocked) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.usedDirty) {
      this.usedDirty = false;
      await this.mutate(() => undefined).catch(() => undefined);
    } else {
      await this.queue;
    }
    if (!this.unlocked) return;
    this.unlocked.dataKey.fill(0);
    this.unlocked = null;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const { file } = this.requireUnlocked();
    const opened = await openVaultFile(file, password);
    if (typeof opened === 'string') return false;
    opened.dataKey.fill(0);
    return true;
  }

  async changePassword(current: string, next: string): Promise<boolean> {
    const problem = masterPasswordProblem(next);
    if (problem) throw new VaultError('weak-password', problem);
    if (!(await this.verifyPassword(current))) return false;

    return this.enqueue(async () => {
      const state = this.requireUnlocked();
      const payload: VaultPayload = {
        schemaVersion: 1,
        createdAt: state.createdAt,
        entries: state.entries,
      };
      const rewrapped = await rewrapVaultFile(payload, next, this.cost, {
        dataKey: state.dataKey,
        rotateDataKey: true,
      });
      await this.files.write(rewrapped.file);
      if (this.unlocked === state) {
        state.dataKey.fill(0);
        this.unlocked = { ...state, file: rewrapped.file, dataKey: rewrapped.dataKey };
      }
      return true;
    });
  }

  async reset(): Promise<void> {
    await this.queue;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.usedDirty = false;
    this.unlocked?.dataKey.fill(0);
    this.unlocked = null;
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    await this.files.moveAside(`reset-${stamp}`);
  }

  list(): VaultEntrySummary[] {
    return this.requireUnlocked().entries.map(toEntrySummary);
  }

  getEntry(id: string): VaultEntry {
    return structuredClone(this.findEntry(id));
  }

  reveal(id: string, ref: VaultFieldRef): string {
    const value = readEntryField(this.findEntry(id), ref);
    if (value === undefined) throw new VaultError('not-found', 'That field does not exist.');
    return value;
  }

  allEntries(): VaultEntry[] {
    return structuredClone(this.requireUnlocked().entries);
  }

  save(input: SaveVaultEntryInput): Promise<VaultEntrySummary> {
    const parsed = SaveVaultEntryInputSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(new VaultError('invalid', describeInvalid(parsed.error)));
    }
    return this.mutate((entries) => {
      const data = parsed.data;
      const index = data.id ? entries.findIndex((entry) => entry.id === data.id) : -1;
      if (data.id && index === -1)
        throw new VaultError('not-found', 'That entry no longer exists.');
      let entry: VaultEntry;
      try {
        entry = applySaveInput(index === -1 ? undefined : entries[index], data, this.clock());
      } catch (error) {
        throw new VaultError('invalid', describeInvalid(error));
      }
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
      return toEntrySummary(entry);
    });
  }

  remove(ids: string[]): Promise<number> {
    const doomed = new Set(ids);
    return this.mutate((entries) => {
      const before = entries.length;
      const kept = entries.filter((entry) => !doomed.has(entry.id));
      entries.splice(0, entries.length, ...kept);
      return before - kept.length;
    });
  }

  patch(id: string, change: { favorite?: boolean; tags?: string[] }): Promise<VaultEntrySummary> {
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) throw new VaultError('not-found', 'That entry no longer exists.');
      const current = entries[index];
      const next = {
        ...current,
        favorite: change.favorite ?? current.favorite,
        tags: change.tags ? normalizeTags(change.tags) : current.tags,
        updatedAt: change.tags ? this.now() : current.updatedAt,
      };
      const parsed = VaultEntrySchema.safeParse(next);
      if (!parsed.success) throw new VaultError('invalid', describeInvalid(parsed.error));
      entries[index] = parsed.data;
      return toEntrySummary(parsed.data);
    });
  }

  duplicate(id: string): Promise<VaultEntrySummary> {
    return this.mutate((entries) => {
      const source = entries.find((entry) => entry.id === id);
      if (!source) throw new VaultError('not-found', 'That entry no longer exists.');
      const copy = duplicateEntry(source, this.clock());
      entries.push(copy);
      return toEntrySummary(copy);
    });
  }

  /** Updates "last used" in memory now and writes it a little later, batched. */
  markUsed(id: string): void {
    const entry = this.requireUnlocked().entries.find((e) => e.id === id);
    if (!entry) return;
    entry.lastUsedAt = this.now();
    this.usedDirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.usedDirty || !this.unlocked) return;
      this.usedDirty = false;
      this.mutate(() => undefined).catch(() => {
        this.usedDirty = true;
      });
    }, this.lastUsedFlushMs);
  }

  /** One write for a whole import. `update` gets a copy and returns the new list. */
  replaceAll(update: (entries: VaultEntry[]) => VaultEntry[]): Promise<void> {
    return this.mutate((entries) => {
      const next = update(structuredClone(entries));
      entries.splice(0, entries.length, ...next);
    });
  }

  toJSON(): Record<string, unknown> {
    return { unlocked: this.unlocked !== null };
  }

  private clock() {
    return { now: this.now(), newId: this.newId };
  }

  private requireUnlocked(): Unlocked {
    if (!this.unlocked) throw LOCKED();
    return this.unlocked;
  }

  private findEntry(id: string): VaultEntry {
    const entry = this.requireUnlocked().entries.find((e) => e.id === id);
    if (!entry) throw new VaultError('not-found', 'That entry no longer exists.');
    return entry;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private mutate<T>(change: (entries: VaultEntry[]) => T): Promise<T> {
    return this.enqueue(async () => {
      const state = this.requireUnlocked();
      const draft = structuredClone(state.entries);
      const result = change(draft);
      const parsed = VaultPayloadSchema.safeParse({
        schemaVersion: 1,
        createdAt: state.createdAt,
        entries: draft,
      });
      if (!parsed.success) throw new VaultError('invalid', describeInvalid(parsed.error));

      // Sealed with a copy of the key, so a lock that zeroes the real one mid-write can't
      // leave this encrypting under zeros.
      const key = Buffer.from(state.dataKey);
      let next: VaultFileV1;
      try {
        next = sealVaultData(state.file, key, parsed.data);
      } finally {
        key.fill(0);
      }
      await this.files.write(next);
      if (this.unlocked === state) {
        this.unlocked = { ...state, file: next, entries: draft };
      }
      return result;
    });
  }
}
