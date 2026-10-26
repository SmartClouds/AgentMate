import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, withPlatform } from '../../test/main/fixtures';

/**
 * Cursor keeps its session in the VS Code `globalStorage` SQLite database rather than a JSON file,
 * so this reads a real database built by the fixture below. What matters is that the read is
 * read-only (Cursor is normally running and holding the file), that it never throws whatever it
 * finds, and that the account id comes from the JWT's own `sub` claim rather than the stored key.
 *
 * Every lookup path is pinned to a temp folder through the environment, so no test can reach a
 * Cursor installation that happens to exist on the machine running it.
 */

const APP_USER_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

const NOW = new Date('2026-03-01T12:00:00.000Z');

let configDir = '';

type Module = typeof import('./cursorAccount');

async function loadModule(): Promise<Module> {
  vi.resetModules();
  return import('./cursorAccount');
}

/** The path the module reads when CURSOR_CONFIG_DIR points at `configDir`. */
function statePath(root = configDir): string {
  return join(root, 'User', 'globalStorage', 'state.vscdb');
}

/** Writes a state database with Cursor's own ItemTable shape and the given rows. */
function writeState(rows: Record<string, string>, root = configDir): string {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // Rewritable, because a couple of tests replace the state between two reads.
    db.exec(`
      DROP TABLE IF EXISTS ItemTable;
      CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    `);
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  } finally {
    // Windows will not remove the temp folder while this handle is open.
    db.close();
  }
  return path;
}

/** An unsigned JWT with the claims under test. The reader never checks the signature. */
function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.signature`;
}

function validToken(sub = 'auth0|user_01'): string {
  return jwt({ sub, exp: Math.floor(NOW.getTime() / 1000) + 3600 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  configDir = tempDir('runova-cursor-config-');
  mkdirSync(join(configDir, 'User', 'globalStorage'), { recursive: true });
  vi.stubEnv('CURSOR_CONFIG_DIR', configDir);
  // The per-platform branches read these, so they are pinned at empty folders. Otherwise a test
  // could pick up the Cursor installation of whoever is running it.
  vi.stubEnv('APPDATA', tempDir('runova-cursor-appdata-'));
  vi.stubEnv('XDG_CONFIG_HOME', tempDir('runova-cursor-xdg-'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a signed in installation', () => {
  it('reads the token, the email, the plan and the id from the JWT', async () => {
    writeState({
      'cursorAuth/accessToken': `"${validToken()}"`,
      'cursorAuth/cachedEmail': '"dev@example.com"',
      'cursorAuth/stripeMembershipType': '"pro_plus"',
      'glass.lastSignedInAuthId': '"auth0|stale_id"',
    });
    const { readCursorAccount } = await loadModule();

    const account = readCursorAccount();

    expect(account).toEqual({
      accessToken: validToken(),
      // The JWT wins over the stored key, so the two cannot drift apart.
      userId: 'auth0|user_01',
      email: 'dev@example.com',
      plan: { id: 'pro-plus', label: 'Pro+' },
      signedOut: false,
      tokenExpired: false,
      missing: false,
    });
  });

  it('falls back to the stored auth id when the JWT carries no sub', async () => {
    writeState({
      'cursorAuth/accessToken': `"${jwt({ exp: 9_999_999_999 })}"`,
      'glass.lastSignedInAuthId': '"auth0|from_the_key"',
    });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().userId).toBe('auth0|from_the_key');
  });

  it('falls back when the token is not a JWT at all', async () => {
    writeState({
      'cursorAuth/accessToken': '"not-a-jwt"',
      'glass.lastSignedInAuthId': '"auth0|from_the_key"',
    });
    const { readCursorAccount } = await loadModule();

    const account = readCursorAccount();

    expect(account.userId).toBe('auth0|from_the_key');
    // No exp claim to read, so the token is used rather than assumed stale.
    expect(account.accessToken).toBe('not-a-jwt');
    expect(account.tokenExpired).toBe(false);
  });

  it('survives a JWT whose payload is not JSON', async () => {
    const broken = `${Buffer.from('{}').toString('base64url')}.@@@.sig`;
    writeState({ 'cursorAuth/accessToken': `"${broken}"` });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().userId).toBeNull();
  });

  it('drops an expired session instead of firing a request that must 401', async () => {
    writeState({
      'cursorAuth/accessToken': `"${jwt({ sub: 'auth0|user_01', exp: Math.floor(NOW.getTime() / 1000) - 60 })}"`,
    });
    const { readCursorAccount } = await loadModule();

    const account = readCursorAccount();

    expect(account.accessToken).toBeNull();
    expect(account.tokenExpired).toBe(true);
    // The id survives, so the card can name the account it wants a re-login for.
    expect(account.userId).toBe('auth0|user_01');
    expect(account.signedOut).toBe(false);
  });

  it('treats a session expiring exactly now as expired', async () => {
    writeState({
      'cursorAuth/accessToken': `"${jwt({ sub: 'a', exp: Math.floor(NOW.getTime() / 1000) })}"`,
    });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().tokenExpired).toBe(true);
  });
});

describe('the plan', () => {
  const cases: [string, { id: string; label: string }][] = [
    ['free', { id: 'free', label: 'Free' }],
    ['free_trial', { id: 'free', label: 'Free' }],
    ['pro', { id: 'pro', label: 'Pro' }],
    ['pro+', { id: 'pro-plus', label: 'Pro+' }],
    ['ultra', { id: 'ultra', label: 'Ultra' }],
    ['business', { id: 'team', label: 'Team' }],
    ['enterprise', { id: 'enterprise', label: 'Enterprise' }],
    // A tier Cursor adds later still gets a readable label instead of no plan at all.
    ['galaxy', { id: 'galaxy', label: 'Galaxy' }],
  ];

  for (const [membership, expected] of cases) {
    it(`maps ${membership}`, async () => {
      writeState({
        'cursorAuth/accessToken': `"${validToken()}"`,
        'cursorAuth/stripeMembershipType': `"${membership}"`,
      });
      const { readCursorAccount } = await loadModule();

      expect(readCursorAccount().plan).toEqual(expected);
    });
  }

  it('reads the membership out of the applicationUser blob when the auth key is absent', async () => {
    writeState({
      'cursorAuth/accessToken': `"${validToken()}"`,
      [APP_USER_KEY]: JSON.stringify({ membershipType: 'ultra', dashboardUserId: 12345 }),
    });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().plan).toEqual({ id: 'ultra', label: 'Ultra' });
  });

  it('prefers the auth key over the blob', async () => {
    writeState({
      'cursorAuth/accessToken': `"${validToken()}"`,
      'cursorAuth/stripeMembershipType': '"pro"',
      [APP_USER_KEY]: JSON.stringify({ membershipType: 'free' }),
    });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().plan).toEqual({ id: 'pro', label: 'Pro' });
  });

  it('ignores a blob whose shape changed', async () => {
    writeState({
      'cursorAuth/accessToken': `"${validToken()}"`,
      [APP_USER_KEY]: 'not json',
    });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().plan).toBeNull();
  });

  it('ignores an empty membership string', async () => {
    writeState({
      'cursorAuth/accessToken': `"${validToken()}"`,
      'cursorAuth/stripeMembershipType': '""',
    });
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().plan).toBeNull();
  });
});

describe('nothing to read', () => {
  it('reports the installation missing when no state file exists', async () => {
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount()).toEqual({
      accessToken: null,
      userId: null,
      email: null,
      plan: null,
      signedOut: false,
      tokenExpired: false,
      missing: true,
    });
  });

  it('reports signed out when the database has no token row', async () => {
    writeState({ 'cursorAuth/cachedEmail': '"dev@example.com"' });
    const { readCursorAccount } = await loadModule();

    const account = readCursorAccount();

    expect(account.signedOut).toBe(true);
    expect(account.missing).toBe(false);
    expect(account.email).toBe('dev@example.com');
  });

  it('reports signed out when the schema is not the one it expects', async () => {
    const path = statePath();
    const db = new DatabaseSync(path);
    // A future Cursor that renamed the table, or a different VS Code fork's file.
    db.exec(
      "CREATE TABLE SomethingElse (k TEXT, v TEXT); INSERT INTO SomethingElse VALUES ('a','b')",
    );
    db.close();
    const { readCursorAccount } = await loadModule();

    // The copy fallback hits the same missing table, and the caller has to end up with
    // "not signed in" rather than an exception out of a usage refresh.
    expect(readCursorAccount()).toMatchObject({ signedOut: true, missing: false, plan: null });
  });

  it('reports signed out when the file is not a database', async () => {
    writeFileSync(statePath(), 'this is not sqlite', 'utf-8');
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount()).toMatchObject({ signedOut: true, missing: false });
  });

  it('reports signed out when ItemTable has no value column', async () => {
    const path = statePath();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE ItemTable (key TEXT, val TEXT); INSERT INTO ItemTable VALUES ('a','b')");
    db.close();
    const { readCursorAccount } = await loadModule();

    expect(readCursorAccount().signedOut).toBe(true);
  });
});

describe('the read itself', () => {
  it('leaves the state file untouched', async () => {
    const path = writeState({ 'cursorAuth/accessToken': `"${validToken()}"` });
    const before = readFileSync(path);
    const { readCursorAccount } = await loadModule();

    readCursorAccount();

    // Cursor is normally running while this happens, so the open has to be read-only.
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('reads the Cursor folder under APPDATA on Windows', async () => {
    const appData = tempDir('runova-cursor-appdata2-');
    vi.stubEnv('CURSOR_CONFIG_DIR', '');
    vi.stubEnv('APPDATA', appData);
    writeState({ 'cursorAuth/cachedEmail': '"win@example.com"' }, join(appData, 'Cursor'));
    const { readCursorAccount } = await loadModule();

    await withPlatform('win32', () => {
      expect(readCursorAccount().email).toBe('win@example.com');
    });
  });

  it('reads XDG_CONFIG_HOME on Linux', async () => {
    const xdg = tempDir('runova-cursor-xdg2-');
    vi.stubEnv('CURSOR_CONFIG_DIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    writeState({ 'cursorAuth/cachedEmail': '"linux@example.com"' }, join(xdg, 'Cursor'));
    const { readCursorAccount } = await loadModule();

    await withPlatform('linux', () => {
      expect(readCursorAccount().email).toBe('linux@example.com');
    });
  });
});

describe('the one minute cache', () => {
  it('reads once for a screen full of widgets', async () => {
    writeState({ 'cursorAuth/cachedEmail': '"first@example.com"' });
    const { getCursorAccount } = await loadModule();

    expect(getCursorAccount().email).toBe('first@example.com');
    writeState({ 'cursorAuth/cachedEmail': '"second@example.com"' });

    // Several widgets plus the Usage page refresh on independent timers, and the read copies a
    // few megabytes when it has to fall back, so a burst has to be one read.
    expect(getCursorAccount().email).toBe('first@example.com');
  });

  it('re-reads once the minute is up', async () => {
    writeState({ 'cursorAuth/cachedEmail': '"first@example.com"' });
    const { getCursorAccount } = await loadModule();
    expect(getCursorAccount().email).toBe('first@example.com');

    writeState({ 'cursorAuth/cachedEmail': '"second@example.com"' });
    vi.setSystemTime(new Date(NOW.getTime() + 60_001));

    expect(getCursorAccount().email).toBe('second@example.com');
  });

  it('re-reads straight away after an explicit refresh', async () => {
    writeState({ 'cursorAuth/cachedEmail': '"first@example.com"' });
    const { getCursorAccount, clearCursorAccountCache } = await loadModule();
    expect(getCursorAccount().email).toBe('first@example.com');

    writeState({ 'cursorAuth/cachedEmail': '"second@example.com"' });
    clearCursorAccountCache();

    expect(getCursorAccount().email).toBe('second@example.com');
  });
});
