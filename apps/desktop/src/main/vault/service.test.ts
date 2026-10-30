import type { SaveVaultEntryInput } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardPort } from './clipboardGuard';
import type { KdfCost } from './kdf';
import type { PowerPort } from './ports';
import {
  type VaultEvents,
  type VaultLoginPort,
  VaultService,
  type VaultServiceSettings,
} from './service';
import { MemoryVaultFiles } from './testing/memoryVaultFiles';

const FAST: KdfCost = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

const SETTINGS: VaultServiceSettings = {
  vaultAutoLockMinutes: 15,
  vaultClipboardClearSeconds: 30,
  vaultLockOnSystemLock: true,
};

const loginInput = (overrides: Partial<Extract<SaveVaultEntryInput, { type: 'login' }>> = {}) =>
  ({
    type: 'login',
    title: 'GitHub',
    tags: [],
    favorite: false,
    notes: '',
    username: 'octo',
    password: 'S3NT1NEL-password',
    urls: ['github.com'],
    totpSecret: '',
    ...overrides,
  }) satisfies SaveVaultEntryInput;

function setup(
  options: {
    settings?: Partial<VaultServiceSettings>;
    env?: Record<string, string>;
    login?: VaultLoginPort;
    loginFilled?: VaultEvents['loginFilled'];
  } = {},
) {
  let clipboardText = '';
  const clipboard: ClipboardPort = {
    readText: () => clipboardText,
    writeText: (text) => {
      clipboardText = text;
    },
  };
  const events: VaultEvents = {
    stateChanged: vi.fn(),
    entriesChanged: vi.fn(),
    clipboardSettled: vi.fn(),
    loginFilled: options.loginFilled,
  };
  let systemLockListener: (() => void) | null = null;
  const power: PowerPort = {
    onSystemLock: (listener) => {
      systemLockListener = listener;
      return () => {
        systemLockListener = null;
      };
    },
  };
  const files = new MemoryVaultFiles();
  const service = new VaultService({
    files,
    cost: FAST,
    clipboard,
    events,
    env: options.env ?? {},
    isPackaged: false,
    login: options.login,
  });
  service.applySettings({ ...SETTINGS, ...options.settings });
  return {
    service,
    files,
    events,
    power,
    clipboard: () => clipboardText,
    setClipboard: (text: string) => {
      clipboardText = text;
    },
    fireSystemLock: () => systemLockListener?.(),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VaultService status and unlocking', () => {
  it('reports state and the timer settings, and announces create and lock', async () => {
    const { service, events } = setup();
    expect(await service.status()).toEqual({
      state: 'uninitialized',
      retryAfterMs: 0,
      autoLockMinutes: 15,
      clipboardClearSeconds: 30,
    });
    await service.create(PASSWORD);
    expect(events.stateChanged).toHaveBeenLastCalledWith({ state: 'unlocked' });
    await service.lock('manual');
    expect(events.stateChanged).toHaveBeenLastCalledWith({ state: 'locked', reason: 'manual' });
    expect((await service.status()).state).toBe('locked');
  });

  it('throttles guessing after a couple of wrong passwords, then lets the right one in', async () => {
    const { service } = setup();
    await service.create(PASSWORD);
    await service.lock('manual');

    expect(await service.unlock('wrong one number 1')).toEqual({
      ok: false,
      reason: 'wrong-password',
      retryAfterMs: 0,
    });
    expect(await service.unlock('wrong one number 2')).toMatchObject({ retryAfterMs: 0 });
    expect(await service.unlock('wrong one number 3')).toEqual({
      ok: false,
      reason: 'wrong-password',
      retryAfterMs: 1000,
    });
    expect(await service.unlock(PASSWORD)).toEqual({
      ok: false,
      reason: 'throttled',
      retryAfterMs: 1000,
    });
    expect((await service.status()).retryAfterMs).toBe(1000);

    vi.advanceTimersByTime(1000);
    expect(await service.unlock(PASSWORD)).toEqual({ ok: true });
    await service.lock('manual');
    expect(await service.unlock('wrong again, but fresh')).toMatchObject({ retryAfterMs: 0 });
  });

  it('uses the shorter test backoff only when the override is present', async () => {
    const { service } = setup({ env: { RUNOVA_VAULT_TEST_TIMERS: 'backoffBaseMs=300' } });
    await service.create(PASSWORD);
    await service.lock('manual');
    await service.unlock('bad 1 bad 1 bad');
    await service.unlock('bad 2 bad 2 bad');
    expect(await service.unlock('bad 3 bad 3 bad')).toMatchObject({ retryAfterMs: 300 });
  });

  it('refuses a second unlock while one is still running', async () => {
    const { service } = setup();
    await service.create(PASSWORD);
    await service.lock('manual');
    const first = service.unlock(PASSWORD);
    expect(await service.unlock(PASSWORD)).toEqual({ ok: false, reason: 'busy', retryAfterMs: 0 });
    expect(await first).toEqual({ ok: true });
  });
});

describe('VaultService locking', () => {
  it('locks after the idle period and any vault activity pushes it back', async () => {
    const { service, events } = setup({ settings: { vaultAutoLockMinutes: 1 } });
    await service.create(PASSWORD);
    await vi.advanceTimersByTimeAsync(50_000);
    service.list();
    await vi.advanceTimersByTimeAsync(50_000);
    expect((await service.status()).state).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(async () => expect((await service.status()).state).toBe('locked'));
    expect(events.stateChanged).toHaveBeenLastCalledWith({ state: 'locked', reason: 'idle' });
  });

  it('never idles out when auto-lock is off, and picks up a changed setting right away', async () => {
    const { service } = setup({ settings: { vaultAutoLockMinutes: 0 } });
    await service.create(PASSWORD);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect((await service.status()).state).toBe('unlocked');

    service.applySettings({ ...SETTINGS, vaultAutoLockMinutes: 5 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(async () => expect((await service.status()).state).toBe('locked'));
  });

  it('locks when the computer locks or sleeps, unless that setting is off', async () => {
    const on = setup();
    on.service.attachPower(on.power);
    await on.service.create(PASSWORD);
    on.fireSystemLock();
    await vi.waitFor(async () => expect((await on.service.status()).state).toBe('locked'));
    expect(on.events.stateChanged).toHaveBeenLastCalledWith({ state: 'locked', reason: 'system' });

    const off = setup({ settings: { vaultLockOnSystemLock: false } });
    off.service.attachPower(off.power);
    await off.service.create(PASSWORD);
    off.fireSystemLock();
    await vi.advanceTimersByTimeAsync(10);
    expect((await off.service.status()).state).toBe('unlocked');
  });

  it('clears a copied secret from the clipboard when it locks', async () => {
    const { service, clipboard, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    service.copy(entry.id, 'password');
    await service.lock('manual');
    expect(clipboard()).toBe('');
    expect(events.clipboardSettled).toHaveBeenCalledWith({ cleared: true });
  });

  it('shuts down by clearing the clipboard and locking', async () => {
    const { service, clipboard, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    service.copy(entry.id, 'password');
    await service.shutdown();
    expect(clipboard()).toBe('');
    expect(events.stateChanged).toHaveBeenLastCalledWith({ state: 'locked', reason: 'quit' });
  });
});

describe('VaultService entries', () => {
  it('copies in main, returns when the clipboard clears, and records use', async () => {
    const { service, clipboard, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    expect(events.entriesChanged).toHaveBeenCalled();

    const now = Date.now();
    expect(service.copy(entry.id, 'password')).toEqual({ clearsAt: now + 30_000 });
    expect(clipboard()).toBe('S3NT1NEL-password');
    expect(service.list()[0].lastUsedAt).toBe(now);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboard()).toBe('');
    expect(events.clipboardSettled).toHaveBeenCalledWith({ cleared: true });
  });

  it('does not clear when the user copied something else', async () => {
    const { service, clipboard, setClipboard, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    service.copy(entry.id, 'password');
    setClipboard('mine');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboard()).toBe('mine');
    expect(events.clipboardSettled).toHaveBeenCalledWith({ cleared: false });
  });

  it('keeps the clipboard when clearing is turned off', async () => {
    const { service } = setup({ settings: { vaultClipboardClearSeconds: 0 } });
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    expect(service.copy(entry.id, 'username')).toEqual({ clearsAt: null });
  });

  it('announces entry changes for remove, patch and duplicate', async () => {
    const { service, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    vi.mocked(events.entriesChanged).mockClear();
    await service.patch(entry.id, { favorite: true });
    const copy = await service.duplicate(entry.id);
    await service.remove([copy.id]);
    expect(events.entriesChanged).toHaveBeenCalledTimes(3);
  });

  it('resets the vault and says so', async () => {
    const { service, events, files } = setup();
    await service.create(PASSWORD);
    await service.reset();
    expect((await service.status()).state).toBe('uninitialized');
    expect(events.stateChanged).toHaveBeenLastCalledWith({
      state: 'uninitialized',
      reason: 'reset',
    });
    expect(Object.keys(files.aside)).toHaveLength(1);
  });
});

describe('VaultService categories', () => {
  it('announces every category change so the list refreshes', async () => {
    const { service, events } = setup();
    await service.create(PASSWORD);
    vi.mocked(events.entriesChanged).mockClear();

    const work = await service.saveCategory({ name: 'Work', color: 'blue', icon: 'briefcase' });
    const entry = await service.save(loginInput());
    await service.moveEntries([entry.id], work.id);
    await service.reorderCategories([work.id]);
    expect(service.listCategories().map((c) => c.name)).toEqual(['Work']);
    expect(service.list()[0].categoryId).toBe(work.id);
    expect(await service.deleteCategory(work.id)).toBe(1);
    expect(events.entriesChanged).toHaveBeenCalledTimes(5);
  });

  it('exports the category as the Bitwarden folder', async () => {
    const { service } = setup();
    await service.create(PASSWORD);
    const work = await service.saveCategory({ name: 'Clients', color: 'blue', icon: 'briefcase' });
    await service.save(loginInput({ categoryId: work.id }));
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vault-export-'));
    const target = join(dir, 'out.csv');
    vi.useRealTimers();
    expect(await service.exportCsv(PASSWORD, 'bitwarden', target)).toBe(true);
    expect((await readFile(target, 'utf-8')).split('\n')[1]).toMatch(/^Clients,/);
  });
});

describe('VaultService one-click login', () => {
  class FakePage {
    url = 'about:blank';
    scripts: string[] = [];
    listeners = new Map<string, Set<() => void>>();
    getURL = () => this.url;
    isDestroyed = () => false;
    async executeJavaScript(code: string) {
      this.scripts.push(code);
      return { username: true, password: true, submitted: code.includes('"submit":true') };
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, (this.listeners.get(event) ?? new Set()).add(listener));
    }
    removeListener(event: string, listener: () => void) {
      this.listeners.get(event)?.delete(listener);
    }
    load(url: string) {
      this.url = url;
      for (const listener of this.listeners.get('did-finish-load') ?? []) listener();
    }
  }

  function withLogin() {
    const page = new FakePage();
    const login = {
      openWindow: vi.fn((_url: string) => page),
      openExternal: vi.fn(async (_url: string) => undefined),
    };
    const loginFilled = vi.fn();
    const ctx = setup({ login, loginFilled });
    return { ...ctx, page, login, loginFilled };
  }

  it('opens the login window on the first website and fills it there', async () => {
    const { service, page, login, loginFilled } = withLogin();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput({ urls: ['github.com/login', 'gist.github.com'] }));

    await expect(service.openLogin(entry.id, 'window')).resolves.toEqual({
      ok: true,
      clearsAt: null,
    });
    expect(login.openWindow).toHaveBeenCalledWith('https://github.com/login');
    page.load('https://github.com/login');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.scripts[0]).toContain('"username":"octo"');
    expect(page.scripts[0]).toContain('"submit":false');
    expect(loginFilled).toHaveBeenCalledWith({
      entryId: entry.id,
      host: 'github.com',
      result: 'filled',
      submitted: false,
    });
    expect(service.list()[0].lastUsedAt).not.toBeNull();
  });

  it('presses sign in when the entry asks for it', async () => {
    const { service, page } = withLogin();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput({ autoSubmit: true }));
    await service.openLogin(entry.id, 'window');
    page.load('https://github.com/');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.scripts[0]).toContain('"submit":true');
  });

  it('opens the default browser and copies the password for it', async () => {
    const { service, login, clipboard } = withLogin();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    const result = await service.openLogin(entry.id, 'system');
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.clearsAt).toBeGreaterThan(Date.now());
    expect(clipboard()).toBe('S3NT1NEL-password');
    expect(login.openExternal).toHaveBeenCalledWith('https://github.com/');
    expect(login.openWindow).not.toHaveBeenCalled();
  });

  it('fills a workspace browser tab it is handed', async () => {
    const { service, loginFilled } = withLogin();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    const tab = new FakePage();
    tab.url = 'https://github.com/login';
    expect(service.fillGuest(entry.id, tab)).toEqual({ ok: true, clearsAt: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.scripts).toHaveLength(1);
    expect(loginFilled).toHaveBeenCalled();
  });

  it('refuses entries that are not logins or have nowhere to go', async () => {
    const { service, login } = withLogin();
    await service.create(PASSWORD);
    const note = await service.save({ type: 'note', title: 'N', tags: [], favorite: false });
    const bare = await service.save(loginInput({ urls: [] }));
    await expect(service.openLogin(note.id, 'window')).resolves.toEqual({
      ok: false,
      reason: 'not-login',
    });
    await expect(service.openLogin(bare.id, 'system')).resolves.toEqual({
      ok: false,
      reason: 'no-url',
    });
    expect(login.openWindow).not.toHaveBeenCalled();
    expect(login.openExternal).not.toHaveBeenCalled();
  });

  it('stops filling when the vault locks', async () => {
    const { service, page, loginFilled } = withLogin();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    await service.openLogin(entry.id, 'window');
    await service.lock('manual');
    page.load('https://github.com/login');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.scripts).toEqual([]);
    expect(loginFilled).not.toHaveBeenCalled();
    expect(page.listeners.get('did-finish-load')?.size ?? 0).toBe(0);
  });

  it('says one-click login is unavailable without a way to open pages', async () => {
    const { service } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(loginInput());
    await expect(service.openLogin(entry.id, 'window')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
