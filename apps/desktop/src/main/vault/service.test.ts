import type { SaveVaultEntryInput } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardPort } from './clipboardGuard';
import type { KdfCost } from './kdf';
import type { PowerPort } from './ports';
import { type VaultEvents, VaultService, type VaultServiceSettings } from './service';
import { MemoryVaultFiles } from './testing/memoryVaultFiles';

const FAST: KdfCost = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

const SETTINGS: VaultServiceSettings = {
  vaultAutoLockMinutes: 15,
  vaultClipboardClearSeconds: 30,
  vaultLockOnSystemLock: true,
};

const login = (overrides: Partial<Extract<SaveVaultEntryInput, { type: 'login' }>> = {}) =>
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
  options: { settings?: Partial<VaultServiceSettings>; env?: Record<string, string> } = {},
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
    const entry = await service.save(login());
    service.copy(entry.id, 'password');
    await service.lock('manual');
    expect(clipboard()).toBe('');
    expect(events.clipboardSettled).toHaveBeenCalledWith({ cleared: true });
  });

  it('shuts down by clearing the clipboard and locking', async () => {
    const { service, clipboard, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(login());
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
    const entry = await service.save(login());
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
    const entry = await service.save(login());
    service.copy(entry.id, 'password');
    setClipboard('mine');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboard()).toBe('mine');
    expect(events.clipboardSettled).toHaveBeenCalledWith({ cleared: false });
  });

  it('keeps the clipboard when clearing is turned off', async () => {
    const { service } = setup({ settings: { vaultClipboardClearSeconds: 0 } });
    await service.create(PASSWORD);
    const entry = await service.save(login());
    expect(service.copy(entry.id, 'username')).toEqual({ clearsAt: null });
  });

  it('announces entry changes for remove, patch and duplicate', async () => {
    const { service, events } = setup();
    await service.create(PASSWORD);
    const entry = await service.save(login());
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
