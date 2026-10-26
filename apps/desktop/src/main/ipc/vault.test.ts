import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaveVaultEntryInput } from '@runova/core';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultStatus } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { vaultErrorCode } from '../../shared/vaultErrors';
import { VaultService } from '../vault/service';
import { MemoryVaultFiles } from '../vault/testing/memoryVaultFiles';
import { registerVaultHandlers, type VaultDialogs } from './vault';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  ipcMain: { handle: vi.fn() },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

const PASSWORD = 'correct horse battery staple';
const SENTINEL = 'S3NT1NEL';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** Stands in for ipcMain and lets a test call a channel as the main window or as some other window. */
class FakeIpc {
  readonly handlers = new Map<string, Listener>();
  readonly mainSender = { id: 1 };
  readonly otherSender = { id: 2 };

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return this.invokeAs<T>(this.mainSender, channel, ...args);
  }

  async invokeAs<T>(sender: object, channel: string, ...args: unknown[]): Promise<T> {
    const listener = this.handlers.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return (await listener({ sender } as unknown as IpcMainInvokeEvent, ...args)) as T;
  }
}

let dir = '';
let clipboardText = '';
let ipc: FakeIpc;
let service: VaultService;
let dialogs: VaultDialogs;

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return vaultErrorCode(error);
  }
  return 'resolved';
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runova-vault-ipc-'));
  clipboardText = '';
  ipc = new FakeIpc();
  service = new VaultService({
    files: new MemoryVaultFiles(),
    cost: { N: 1024, r: 8, p: 1 },
    clipboard: { readText: () => clipboardText, writeText: (t) => (clipboardText = t) },
    events: { stateChanged: vi.fn(), entriesChanged: vi.fn(), clipboardSettled: vi.fn() },
    env: {},
    isPackaged: false,
  });
  dialogs = {
    pickImportFile: vi.fn(async () => null),
    pickExportPath: vi.fn(async () => join(dir, 'export.csv')),
  };
  registerVaultHandlers({
    ipc,
    service,
    dialogs,
    fetchIcon: vi.fn(async () => null),
    guard: (event) => event.sender === ipc.mainSender,
  });
});

afterEach(async () => {
  await service.lock('manual');
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('vault IPC handlers', () => {
  it('registers a handler for every invoke channel', () => {
    const invokeChannels = Object.entries(IPC.vault)
      .filter(([name]) => !name.startsWith('on'))
      .map(([, channel]) => channel);
    expect([...ipc.handlers.keys()].sort()).toEqual(invokeChannels.sort());
  });

  it('refuses calls from any window other than the main one', async () => {
    expect(await codeOf(ipc.invokeAs(ipc.otherSender, IPC.vault.create, PASSWORD))).toBe(
      'forbidden',
    );
    expect(await codeOf(ipc.invokeAs(ipc.otherSender, IPC.vault.status))).toBe('forbidden');
    expect((await ipc.invoke<VaultStatus>(IPC.vault.status)).state).toBe('uninitialized');
  });

  it('passes error codes through, and rejects malformed arguments as invalid', async () => {
    expect(await codeOf(ipc.invoke(IPC.vault.create, 'short'))).toBe('weak-password');
    await ipc.invoke(IPC.vault.create, PASSWORD);
    expect(await codeOf(ipc.invoke(IPC.vault.remove, 'not-a-list'))).toBe('invalid');
    expect(await codeOf(ipc.invoke(IPC.vault.reveal, 'id', 'bogus-field'))).toBe('invalid');
    expect(await codeOf(ipc.invoke(IPC.vault.unlock, 42))).toBe('invalid');
    expect(await codeOf(ipc.invoke(IPC.vault.importCommit, 'token', null, 'overwrite-all'))).toBe(
      'invalid',
    );
    await ipc.invoke(IPC.vault.lock);
    expect(await codeOf(ipc.invoke(IPC.vault.list))).toBe('locked');
  });

  it('never sends a secret except through reveal, getForEdit and the clipboard', async () => {
    const results: unknown[] = [];
    const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const result = await ipc.invoke<T>(channel, ...args);
      results.push(result);
      return result;
    };

    await call(IPC.vault.create, PASSWORD);
    const inputs: SaveVaultEntryInput[] = [
      {
        type: 'login',
        title: 'GitHub',
        tags: ['work'],
        favorite: false,
        notes: `${SENTINEL}-notes`,
        username: 'octocat',
        password: `${SENTINEL}-password`,
        urls: ['github.com'],
        totpSecret: `${SENTINEL}-totp`,
      },
      {
        type: 'apiKey',
        title: 'Stripe',
        tags: [],
        favorite: false,
        service: 'Stripe',
        keyId: 'pk_live',
        secret: `${SENTINEL}-secret`,
      },
      { type: 'note', title: 'Recovery', tags: [], favorite: false, notes: `${SENTINEL}-note` },
      {
        type: 'custom',
        title: 'Router',
        tags: [],
        favorite: false,
        fields: [
          { label: 'PIN', value: `${SENTINEL}-pin`, concealed: true },
          { label: 'Model', value: 'AX3000', concealed: false },
        ],
      },
    ];
    const saved: { id: string }[] = [];
    for (const input of inputs) saved.push(await call(IPC.vault.save, input));

    await call(IPC.vault.list);
    await call(IPC.vault.status);
    await call(IPC.vault.patch, saved[0].id, { favorite: true, tags: ['work', 'dev'] });
    await call(IPC.vault.duplicate, saved[1].id);
    const copied = await call<{ clearsAt: number }>(IPC.vault.copy, saved[0].id, 'password');
    await call(IPC.vault.touch);
    await call(IPC.vault.remove, [saved[2].id]);
    await call(IPC.vault.lock);
    await call(IPC.vault.unlock, PASSWORD);
    await call(IPC.vault.list);

    expect(JSON.stringify(results)).not.toContain(SENTINEL);
    expect(copied.clearsAt).toBeGreaterThan(Date.now());
    expect(clipboardText).toBe('');

    expect(await ipc.invoke(IPC.vault.reveal, saved[0].id, 'password')).toBe(
      `${SENTINEL}-password`,
    );
    expect(await ipc.invoke(IPC.vault.getForEdit, saved[3].id)).toMatchObject({
      fields: [{ value: `${SENTINEL}-pin` }, { value: 'AX3000' }],
    });
    await ipc.invoke(IPC.vault.copy, saved[1].id, 'secret');
    expect(clipboardText).toBe(`${SENTINEL}-secret`);
  });

  it('returns null when the import file picker is cancelled', async () => {
    await ipc.invoke(IPC.vault.create, PASSWORD);
    expect(await ipc.invoke(IPC.vault.importOpen)).toBeNull();
    expect(dialogs.pickImportFile).toHaveBeenCalled();
  });

  it('checks the password before asking where to export, and writes the file after', async () => {
    await ipc.invoke(IPC.vault.create, PASSWORD);
    await ipc.invoke(IPC.vault.save, {
      type: 'note',
      title: 'Recovery',
      tags: [],
      favorite: false,
      notes: `${SENTINEL}-note`,
    });

    expect(await ipc.invoke(IPC.vault.exportCsv, 'wrong password!!', 'runova')).toEqual({
      ok: false,
      reason: 'wrong-password',
    });
    expect(dialogs.pickExportPath).not.toHaveBeenCalled();

    vi.mocked(dialogs.pickExportPath).mockResolvedValueOnce(null);
    expect(await ipc.invoke(IPC.vault.exportCsv, PASSWORD, 'bitwarden')).toEqual({
      ok: false,
      reason: 'cancelled',
    });

    expect(await ipc.invoke(IPC.vault.exportCsv, PASSWORD, 'runova')).toEqual({ ok: true });
    expect(dialogs.pickExportPath).toHaveBeenLastCalledWith('runova');
    expect(await readFile(join(dir, 'export.csv'), 'utf-8')).toContain(`${SENTINEL}-note`);
  });
});

describe('vault IPC handlers: account and import flows', () => {
  const NEXT = 'amber falcon river 77';

  it('changes the master password and resets the vault', async () => {
    await ipc.invoke(IPC.vault.create, PASSWORD);
    expect(await ipc.invoke(IPC.vault.changePassword, 'wrong one entirely', NEXT)).toBe(false);
    expect(await ipc.invoke(IPC.vault.changePassword, PASSWORD, NEXT)).toBe(true);
    await ipc.invoke(IPC.vault.lock);
    expect(await ipc.invoke(IPC.vault.unlock, NEXT)).toEqual({ ok: true });
    await ipc.invoke(IPC.vault.reset);
    expect((await ipc.invoke<VaultStatus>(IPC.vault.status)).state).toBe('uninitialized');
  });

  it('previews, remaps, commits and cancels an import picked through the dialog', async () => {
    await ipc.invoke(IPC.vault.create, PASSWORD);
    const csv = join(dir, 'other.csv');
    await writeFile(csv, `Site;Login;Secret\nRouter;admin;${SENTINEL}-rt\n`);
    vi.mocked(dialogs.pickImportFile).mockResolvedValue(csv);
    const mapping = { columns: ['title', 'ignore', 'password'] };

    const opened = await ipc.invoke<{ token: string; format: null }>(IPC.vault.importOpen);
    expect(opened.format).toBeNull();
    const remapped = await ipc.invoke(IPC.vault.importPreview, opened.token, mapping);
    expect(JSON.stringify(remapped)).not.toContain(SENTINEL);
    expect(
      await codeOf(ipc.invoke(IPC.vault.importPreview, opened.token, { columns: ['bogus'] })),
    ).toBe('invalid');
    expect(await ipc.invoke(IPC.vault.importCommit, opened.token, mapping, 'skip')).toMatchObject({
      added: 1,
    });

    const again = await ipc.invoke<{ token: string }>(IPC.vault.importOpen);
    await ipc.invoke(IPC.vault.importCancel, again.token);
    expect(await codeOf(ipc.invoke(IPC.vault.importCommit, again.token, null, 'skip'))).toBe(
      'not-found',
    );
  });

  it('validates patch, save, id and export arguments', async () => {
    await ipc.invoke(IPC.vault.create, PASSWORD);
    const saved = await ipc.invoke<{ id: string }>(IPC.vault.save, {
      type: 'note',
      title: 'N',
      tags: [],
      favorite: false,
      notes: 'x',
    });
    expect(await codeOf(ipc.invoke(IPC.vault.patch, saved.id, { favorite: 'yes' }))).toBe(
      'invalid',
    );
    expect(await codeOf(ipc.invoke(IPC.vault.patch, saved.id, { tags: 'work' }))).toBe('invalid');
    expect(await ipc.invoke(IPC.vault.patch, saved.id, { tags: ['work'] })).toMatchObject({
      tags: ['work'],
    });
    expect(await codeOf(ipc.invoke(IPC.vault.save, { type: 'wallet' }))).toBe('invalid');
    expect(await codeOf(ipc.invoke(IPC.vault.getForEdit, 'x'.repeat(500)))).toBe('invalid');
    expect(await codeOf(ipc.invoke(IPC.vault.exportCsv, PASSWORD, 'pdf'))).toBe('invalid');
    expect(await ipc.invoke(IPC.vault.duplicate, saved.id)).toMatchObject({ title: 'N (copy)' });
    expect(await codeOf(ipc.invoke(IPC.vault.duplicate, 'missing'))).toBe('not-found');
  });

  it('lets unexpected errors through unchanged', async () => {
    await ipc.invoke(IPC.vault.create, PASSWORD);
    vi.mocked(dialogs.pickImportFile).mockRejectedValueOnce(new Error('dialog crashed'));
    await expect(ipc.invoke(IPC.vault.importOpen)).rejects.toThrow('dialog crashed');
  });
});
