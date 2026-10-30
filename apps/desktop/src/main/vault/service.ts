import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type DuplicatePolicy,
  detectDelimiter,
  detectImportFormat,
  exportEntriesCsv,
  findDuplicates,
  type GenericMapping,
  hostOf,
  type ImportMapResult,
  loginTargetUrl,
  mapImportRows,
  parseCsv,
  planImport,
  type SaveVaultCategoryInput,
  type SaveVaultEntryInput,
  suggestGenericMapping,
  type VaultCategory,
  type VaultEntry,
  type VaultEntrySummary,
  type VaultExportFormat,
  type VaultFieldRef,
  type VaultImportFormat,
} from '@runova/core';
import type {
  VaultCopyResult,
  VaultImportPreview,
  VaultImportResult,
  VaultLockReason,
  VaultLoginFilledEvent,
  VaultLoginResult,
  VaultLoginTarget,
  VaultStateEvent,
  VaultStatus,
  VaultUnlockResult,
} from '../../shared/apiTypes';
import { AttemptLimiter } from './attemptLimiter';
import { type LoginPage, startFill } from './autofill/fillSession';
import { ClipboardGuard, type ClipboardPort } from './clipboardGuard';
import { IdleTimer } from './idleLock';
import type { KdfCost } from './kdf';
import type { PowerPort, VaultFilePort } from './ports';
import { VaultError, VaultSession } from './session';
import { resolveVaultTimers, type VaultTimerSettings, type VaultTimers } from './timers';

export interface VaultServiceSettings extends VaultTimerSettings {
  vaultLockOnSystemLock: boolean;
}

export interface VaultEvents {
  stateChanged(event: VaultStateEvent): void;
  entriesChanged(): void;
  clipboardSettled(event: { cleared: boolean }): void;
  /** How a one-click login went, for a toast. */
  loginFilled?(event: VaultLoginFilledEvent): void;
}

/** Opens pages for one-click login. Main wires it to a BrowserWindow and the default browser. */
export interface VaultLoginPort {
  openWindow(url: string): LoginPage;
  openExternal(url: string): Promise<void>;
}

export interface VaultServiceDeps {
  files: VaultFilePort;
  clipboard: ClipboardPort;
  events: VaultEvents;
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  cost?: KdfCost;
  login?: VaultLoginPort;
}

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const SAMPLE_ROWS = 5;

interface PendingImport {
  fileName: string;
  rows: string[][];
  format: VaultImportFormat | null;
}

const DEFAULT_SETTINGS: VaultServiceSettings = {
  vaultAutoLockMinutes: 15,
  vaultClipboardClearSeconds: 30,
  vaultLockOnSystemLock: true,
};

/**
 * Everything the Vault IPC handlers call. Wraps the session with the parts that depend on time
 * and the OS: idle and system locking, password backoff, the clipboard, and CSV files.
 */
export class VaultService {
  private readonly session: VaultSession;
  private readonly limiter = new AttemptLimiter({ freeFailures: 2, baseMs: 1000, maxMs: 30_000 });
  private readonly idle = new IdleTimer(() => void this.lock('idle'));
  private readonly clipboardGuard: ClipboardGuard;
  private readonly pendingImports = new Map<string, PendingImport>();
  private settings = DEFAULT_SETTINGS;
  private timers: VaultTimers;
  private unlocking = false;
  private detachPower: (() => void) | null = null;
  /** One-click logins still waiting for their page. Each holds a password until it stops. */
  private readonly fills = new Set<() => void>();

  constructor(private readonly deps: VaultServiceDeps) {
    this.session = new VaultSession({ files: deps.files, cost: deps.cost });
    this.clipboardGuard = new ClipboardGuard(deps.clipboard, (result) =>
      deps.events.clipboardSettled(result),
    );
    this.timers = resolveVaultTimers(DEFAULT_SETTINGS, deps.env, deps.isPackaged);
  }

  applySettings(settings: VaultServiceSettings): void {
    this.settings = settings;
    this.timers = resolveVaultTimers(settings, this.deps.env, this.deps.isPackaged);
    this.limiter.setBaseMs(this.timers.backoffBaseMs);
    if (this.session.isUnlocked()) this.idle.arm(this.timers.autoLockMs);
  }

  attachPower(power: PowerPort): void {
    this.detachPower?.();
    this.detachPower = power.onSystemLock(() => {
      if (this.settings.vaultLockOnSystemLock && this.session.isUnlocked()) {
        void this.lock('system');
      }
    });
  }

  async status(): Promise<VaultStatus> {
    return {
      state: await this.session.state(),
      retryAfterMs: this.limiter.retryAfterMs(Date.now()),
      autoLockMinutes: this.settings.vaultAutoLockMinutes,
      clipboardClearSeconds: this.settings.vaultClipboardClearSeconds,
    };
  }

  async create(password: string): Promise<void> {
    await this.session.create(password);
    this.idle.arm(this.timers.autoLockMs);
    this.deps.events.stateChanged({ state: 'unlocked' });
  }

  async unlock(password: string): Promise<VaultUnlockResult> {
    const wait = this.limiter.retryAfterMs(Date.now());
    if (wait > 0) return { ok: false, reason: 'throttled', retryAfterMs: wait };
    if (this.unlocking) return { ok: false, reason: 'busy', retryAfterMs: 0 };
    this.unlocking = true;
    try {
      if (!(await this.session.unlock(password))) {
        this.limiter.recordFailure(Date.now());
        return {
          ok: false,
          reason: 'wrong-password',
          retryAfterMs: this.limiter.retryAfterMs(Date.now()),
        };
      }
    } finally {
      this.unlocking = false;
    }
    this.limiter.reset();
    this.idle.arm(this.timers.autoLockMs);
    this.deps.events.stateChanged({ state: 'unlocked' });
    return { ok: true };
  }

  async lock(reason: VaultLockReason): Promise<void> {
    const wasUnlocked = this.session.isUnlocked();
    this.idle.stop();
    this.clipboardGuard.clearIfOurs();
    // Pending imports hold the parsed file, passwords included.
    this.pendingImports.clear();
    for (const stop of [...this.fills]) stop();
    await this.session.lock();
    if (wasUnlocked) this.deps.events.stateChanged({ state: 'locked', reason });
  }

  async verifyPassword(password: string): Promise<boolean> {
    this.idle.touch();
    return this.session.verifyPassword(password);
  }

  async changePassword(current: string, next: string): Promise<boolean> {
    this.idle.touch();
    return this.session.changePassword(current, next);
  }

  async reset(): Promise<void> {
    this.idle.stop();
    this.clipboardGuard.clearIfOurs();
    this.pendingImports.clear();
    await this.session.reset();
    this.limiter.reset();
    this.deps.events.stateChanged({ state: 'uninitialized', reason: 'reset' });
  }

  touch(): void {
    this.idle.touch();
  }

  list(): VaultEntrySummary[] {
    const list = this.session.list();
    this.idle.touch();
    return list;
  }

  getForEdit(id: string): VaultEntry {
    const entry = this.session.getEntry(id);
    this.idle.touch();
    return entry;
  }

  reveal(id: string, ref: VaultFieldRef): string {
    const value = this.session.reveal(id, ref);
    this.idle.touch();
    return value;
  }

  copy(id: string, ref: VaultFieldRef): VaultCopyResult {
    const value = this.session.reveal(id, ref);
    this.idle.touch();
    this.session.markUsed(id);
    return this.clipboardGuard.copy(value, this.timers.clipboardClearMs);
  }

  save(input: SaveVaultEntryInput): Promise<VaultEntrySummary> {
    return this.changed(this.session.save(input));
  }

  remove(ids: string[]): Promise<number> {
    return this.changed(this.session.remove(ids));
  }

  patch(id: string, change: { favorite?: boolean; tags?: string[] }): Promise<VaultEntrySummary> {
    return this.changed(this.session.patch(id, change));
  }

  duplicate(id: string): Promise<VaultEntrySummary> {
    return this.changed(this.session.duplicate(id));
  }

  listCategories(): VaultCategory[] {
    const list = this.session.listCategories();
    this.idle.touch();
    return list;
  }

  saveCategory(input: SaveVaultCategoryInput): Promise<VaultCategory> {
    return this.changed(this.session.saveCategory(input));
  }

  deleteCategory(id: string): Promise<number> {
    return this.changed(this.session.deleteCategory(id));
  }

  reorderCategories(ids: string[]): Promise<void> {
    return this.changed(this.session.reorderCategories(ids));
  }

  moveEntries(ids: string[], categoryId: string | null): Promise<number> {
    return this.changed(this.session.moveEntries(ids, categoryId));
  }

  /**
   * One-click login. The window target opens Runova's login window and fills the form there once
   * the page is on one of the entry's hosts. The system browser can't be typed into, so it gets
   * the site and the password goes on the clipboard, cleared like any other copy.
   */
  async openLogin(id: string, target: VaultLoginTarget): Promise<VaultLoginResult> {
    const ready = this.loginEntry(id);
    if (!ready.ok) return ready;
    const { entry, url, login } = ready;
    this.session.markUsed(id);
    if (target === 'system') {
      const copied = entry.password
        ? this.clipboardGuard.copy(entry.password, this.timers.clipboardClearMs)
        : null;
      await login.openExternal(url);
      return { ok: true, clearsAt: copied?.clearsAt ?? null };
    }
    this.fill(entry, login.openWindow(url));
    return { ok: true, clearsAt: null };
  }

  /** Fills a page the renderer already opened, such as a Workspace browser tab. */
  fillGuest(id: string, page: LoginPage): VaultLoginResult {
    const ready = this.loginEntry(id);
    if (!ready.ok) return ready;
    this.session.markUsed(id);
    this.fill(ready.entry, page);
    return { ok: true, clearsAt: null };
  }

  async importOpen(filePath: string): Promise<VaultImportPreview> {
    this.session.list();
    const info = await stat(filePath);
    if (info.size > MAX_IMPORT_BYTES) {
      throw new VaultError('invalid', 'That file is larger than 10 MB. Split it and try again.');
    }
    const text = await readFile(filePath, 'utf-8');
    const rows = parseCsv(text, { delimiter: detectDelimiter(text) });
    if (rows.length === 0) throw new VaultError('invalid', 'That file has no rows to import.');
    const token = randomUUID();
    this.pendingImports.set(token, {
      fileName: basename(filePath),
      rows,
      format: detectImportFormat(rows[0]),
    });
    this.idle.touch();
    return this.importPreview(token, null);
  }

  importPreview(token: string, mapping: GenericMapping | null): VaultImportPreview {
    const pending = this.pendingImport(token);
    const headers = pending.rows[0];
    const suggested = suggestGenericMapping(headers);
    const mapped = this.mapPending(pending, mapping);
    const duplicates = findDuplicates(this.session.allEntries(), mapped.entries);
    this.idle.touch();
    return {
      token,
      fileName: pending.fileName,
      format: pending.format,
      headers,
      mapping: mapping ?? suggested,
      rowCount: pending.rows.length - 1,
      importable: mapped.entries.length,
      duplicates: {
        identical: duplicates.filter((d) => d.kind === 'identical').length,
        conflict: duplicates.filter((d) => d.kind === 'conflict').length,
      },
      skipped: mapped.skipped,
      sample: mapped.entries.slice(0, SAMPLE_ROWS).map((entry) => ({
        type: entry.type,
        title: entry.title,
        username: entry.type === 'login' ? (entry.username ?? '') : '',
        host:
          entry.type === 'login' || entry.type === 'apiKey' ? hostOf(entry.urls?.[0] ?? '') : '',
      })),
    };
  }

  async importCommit(
    token: string,
    mapping: GenericMapping | null,
    policy: DuplicatePolicy,
  ): Promise<VaultImportResult> {
    const pending = this.pendingImport(token);
    this.pendingImports.delete(token);
    const mapped = this.mapPending(pending, mapping);
    let counts = { added: 0, replaced: 0, skipped: 0 };
    await this.session.replaceAll((entries) => {
      const plan = planImport(entries, mapped.entries, policy, {
        now: Date.now(),
        newId: randomUUID,
      });
      counts = { added: plan.added, replaced: plan.replaced, skipped: plan.skipped };
      return plan.entries;
    });
    this.idle.touch();
    this.deps.events.entriesChanged();
    return { ...counts, invalid: mapped.skipped };
  }

  importCancel(token: string): void {
    this.pendingImports.delete(token);
  }

  /** Plain text on disk, so it asks for the master password again first. */
  async exportCsv(password: string, format: VaultExportFormat, filePath: string): Promise<boolean> {
    if (!(await this.session.verifyPassword(password))) return false;
    const csv = exportEntriesCsv(this.session.allEntries(), format, this.session.listCategories());
    await writeFile(filePath, csv, { encoding: 'utf-8', mode: 0o600 });
    this.idle.touch();
    return true;
  }

  async shutdown(): Promise<void> {
    this.detachPower?.();
    this.detachPower = null;
    await this.lock('quit');
    this.clipboardGuard.dispose();
  }

  private async changed<T>(work: Promise<T>): Promise<T> {
    const result = await work;
    this.idle.touch();
    this.deps.events.entriesChanged();
    return result;
  }

  private loginEntry(id: string):
    | {
        ok: true;
        entry: Extract<VaultEntry, { type: 'login' }>;
        url: string;
        login: VaultLoginPort;
      }
    | Extract<VaultLoginResult, { ok: false }> {
    const entry = this.session.getEntry(id);
    this.idle.touch();
    if (entry.type !== 'login') return { ok: false, reason: 'not-login' };
    const url = loginTargetUrl(entry.urls);
    if (!url) return { ok: false, reason: 'no-url' };
    if (!this.deps.login) return { ok: false, reason: 'unavailable' };
    return { ok: true, entry, url, login: this.deps.login };
  }

  private fill(entry: Extract<VaultEntry, { type: 'login' }>, page: LoginPage): void {
    const stop = startFill({
      page,
      urls: entry.urls,
      creds: {
        username: entry.username,
        password: entry.password,
        submit: entry.autoSubmit === true,
      },
      isUnlocked: () => this.session.isUnlocked(),
      onDone: (outcome) => this.deps.events.loginFilled?.({ entryId: entry.id, ...outcome }),
      onStop: () => this.fills.delete(stop),
    });
    this.fills.add(stop);
  }

  private pendingImport(token: string): PendingImport {
    this.session.list();
    const pending = this.pendingImports.get(token);
    if (!pending) throw new VaultError('not-found', 'This import has expired. Start it again.');
    return pending;
  }

  private mapPending(pending: PendingImport, mapping: GenericMapping | null): ImportMapResult {
    if (pending.format && !mapping) return mapImportRows(pending.rows, pending.format);
    return mapImportRows(pending.rows, mapping ?? suggestGenericMapping(pending.rows[0]));
  }
}
