import {
  type DuplicatePolicy,
  GENERIC_COLUMN_TARGETS,
  type GenericMapping,
  SaveVaultEntryInputSchema,
  VAULT_LIMITS,
  type VaultExportFormat,
  VaultFieldRefSchema,
} from '@runova/core';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  VaultExportResult,
  VaultImportPreview,
  VaultImportResult,
  VaultStatus,
  VaultUnlockResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { encodeVaultError } from '../../shared/vaultErrors';
import type { VaultService } from '../vault/service';
import { VaultError } from '../vault/session';

export interface VaultDialogs {
  pickImportFile(): Promise<string | null>;
  /** `format` picks the suggested file name. */
  pickExportPath(format: VaultExportFormat): Promise<string | null>;
}

export interface VaultIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface VaultHandlerDeps {
  ipc: VaultIpcRegistry;
  service: VaultService;
  dialogs: VaultDialogs;
  /** Downloads a site's favicon as a small data URL, or null when there isn't one. */
  fetchIcon: (siteUrl: string) => Promise<string | null>;
  /** True only for the app's main window. Widgets and the pet share the preload but get nothing. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const invalid = (message: string) => new VaultError('invalid', message);

function text(value: unknown, name: string, max = VAULT_LIMITS.secret): string {
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be text.`);
  return value;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > VAULT_LIMITS.entries) {
    throw invalid('Expected a list of entry ids.');
  }
  return value.map((id) => text(id, 'Entry id', VAULT_LIMITS.id));
}

function fieldRef(value: unknown) {
  const parsed = VaultFieldRefSchema.safeParse(value);
  if (!parsed.success) throw invalid('Unknown field.');
  return parsed.data;
}

function mapping(value: unknown): GenericMapping | null {
  if (value === null || value === undefined) return null;
  const columns = (value as { columns?: unknown }).columns;
  if (
    !Array.isArray(columns) ||
    !columns.every((c) => (GENERIC_COLUMN_TARGETS as readonly unknown[]).includes(c))
  ) {
    throw invalid('Invalid column mapping.');
  }
  return { columns: columns as GenericMapping['columns'] };
}

function oneOf<T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (!options.includes(value as T)) throw invalid(`Unknown ${name}.`);
  return value as T;
}

function patchChange(value: unknown): { favorite?: boolean; tags?: string[] } {
  const raw = (value ?? {}) as { favorite?: unknown; tags?: unknown };
  const change: { favorite?: boolean; tags?: string[] } = {};
  if (raw.favorite !== undefined) {
    if (typeof raw.favorite !== 'boolean') throw invalid('favorite must be true or false.');
    change.favorite = raw.favorite;
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.length > VAULT_LIMITS.tags * 2) {
      throw invalid('tags must be a list.');
    }
    change.tags = raw.tags.map((tag) => text(tag, 'Tag', VAULT_LIMITS.tagLength));
  }
  return change;
}

export function registerVaultHandlers({
  ipc,
  service,
  dialogs,
  fetchIcon,
  guard,
}: VaultHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!guard(event)) {
        throw new Error(
          encodeVaultError('forbidden', 'The vault is only available in the main window.'),
        );
      }
      try {
        return await run(...args);
      } catch (error) {
        if (error instanceof VaultError)
          throw new Error(encodeVaultError(error.code, error.message));
        throw error;
      }
    });
  };

  handle(IPC.vault.status, (): Promise<VaultStatus> => service.status());
  handle(IPC.vault.create, (password) => service.create(text(password, 'Password')));
  handle(
    IPC.vault.unlock,
    (password): Promise<VaultUnlockResult> => service.unlock(text(password, 'Password')),
  );
  handle(IPC.vault.lock, () => service.lock('manual'));
  handle(IPC.vault.changePassword, (current, next) =>
    service.changePassword(text(current, 'Current password'), text(next, 'New password')),
  );
  handle(IPC.vault.reset, () => service.reset());
  handle(IPC.vault.list, () => service.list());
  handle(IPC.vault.getForEdit, (id) => service.getForEdit(text(id, 'Entry id', VAULT_LIMITS.id)));
  handle(IPC.vault.reveal, (id, ref) =>
    service.reveal(text(id, 'Entry id', VAULT_LIMITS.id), fieldRef(ref)),
  );
  handle(IPC.vault.copy, (id, ref) =>
    service.copy(text(id, 'Entry id', VAULT_LIMITS.id), fieldRef(ref)),
  );
  handle(IPC.vault.save, (input) => {
    const parsed = SaveVaultEntryInputSchema.safeParse(input);
    if (!parsed.success) throw invalid('That entry could not be saved. Check the fields.');
    return service.save(parsed.data);
  });
  handle(IPC.vault.remove, (list) => service.remove(ids(list)));
  handle(IPC.vault.patch, (id, change) =>
    service.patch(text(id, 'Entry id', VAULT_LIMITS.id), patchChange(change)),
  );
  handle(IPC.vault.duplicate, (id) => service.duplicate(text(id, 'Entry id', VAULT_LIMITS.id)));
  handle(IPC.vault.touch, () => service.touch());
  handle(IPC.vault.fetchIcon, (url) => fetchIcon(text(url, 'Website', VAULT_LIMITS.url)));

  handle(IPC.vault.importOpen, async (): Promise<VaultImportPreview | null> => {
    const path = await dialogs.pickImportFile();
    return path ? service.importOpen(path) : null;
  });
  handle(
    IPC.vault.importPreview,
    (token, map): VaultImportPreview =>
      service.importPreview(text(token, 'Import token', 64), mapping(map)),
  );
  handle(
    IPC.vault.importCommit,
    (token, map, policy): Promise<VaultImportResult> =>
      service.importCommit(
        text(token, 'Import token', 64),
        mapping(map),
        oneOf<DuplicatePolicy>(policy, ['skip', 'replace', 'keepBoth'], 'duplicate policy'),
      ),
  );
  handle(IPC.vault.importCancel, (token) => service.importCancel(text(token, 'Import token', 64)));

  handle(IPC.vault.exportCsv, async (password, format): Promise<VaultExportResult> => {
    const pass = text(password, 'Password');
    const kind = oneOf<VaultExportFormat>(format, ['runova', 'bitwarden'], 'export format');
    if (!(await service.verifyPassword(pass))) return { ok: false, reason: 'wrong-password' };
    const path = await dialogs.pickExportPath(kind);
    if (!path) return { ok: false, reason: 'cancelled' };
    if (!(await service.exportCsv(pass, kind, path)))
      return { ok: false, reason: 'wrong-password' };
    return { ok: true };
  });
}
