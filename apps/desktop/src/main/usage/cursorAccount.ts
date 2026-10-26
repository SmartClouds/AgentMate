import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubscriptionPlan } from '@runova/core';
import Database from 'better-sqlite3';

// Cursor account detection, the same shape as `claudeAccount.ts`: read the
// credential the app already stored at login, then use it to ask the vendor for
// the authoritative quota. Nothing is ever asked of the user.
//
// The difference from Claude Code is where the credential lives. Cursor is a VS
// Code fork, so its state sits in the Electron `globalStorage` SQLite DB rather
// than a JSON file:
//
//   ItemTable['cursorAuth/accessToken']   the session JWT
//   ItemTable['cursorAuth/cachedEmail']   signed-in address
//   ItemTable['glass.lastSignedInAuthId'] the account id ('auth0|user_01…')
//   ItemTable[...applicationUser]         a settings blob carrying membershipType
//
// The id the dashboard wants is the JWT's own `sub` claim, so that is read
// first and the stored key is only a fallback: the two can't drift that way.
// Note it is NOT `applicationUser.dashboardUserId`, which is a different,
// numeric id that the dashboard endpoints reject.
//
// Cursor genuinely has no local usage ledger. Its chat records carry a
// `tokenCount` field that is always {0,0}, so unlike Claude Code there is no
// offline fallback to estimate from. Signed out or offline means no card data.

const APP_USER_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

/** Every place the Cursor app might keep its global storage, best first. */
function statePaths(): string[] {
  const paths: string[] = [];
  const override = process.env.CURSOR_CONFIG_DIR;
  if (override) paths.push(join(override, 'User', 'globalStorage', 'state.vscdb'));

  const home = homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    paths.push(join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'darwin') {
    paths.push(
      join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      ),
    );
  } else {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
    paths.push(join(configHome, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }
  return paths;
}

/**
 * Read the wanted keys out of the state DB.
 *
 * Cursor is normally running while we do this, holding the DB in WAL mode. A
 * read-only open usually succeeds anyway, but it can lose a race against a
 * checkpoint, so a failure retries against a private copy (WAL sidecars
 * included, without them the copy reads as an older snapshot).
 */
function readKeys(file: string, keys: string[]): Map<string, string> {
  const out = new Map<string, string>();

  const query = (path: string): void => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const stmt = db.prepare('SELECT key, value FROM ItemTable WHERE key = ?');
      for (const key of keys) {
        const row = stmt.get(key) as { value?: unknown } | undefined;
        if (row?.value != null) out.set(key, String(row.value));
      }
    } finally {
      db.close();
    }
  };

  try {
    query(file);
    return out;
  } catch {
    // fall through to the copy
  }

  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'runova-cursor-'));
    const copy = join(dir, 'state.vscdb');
    copyFileSync(file, copy);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(file + ext)) copyFileSync(file + ext, copy + ext);
    }
    query(copy);
  } catch {
    // unreadable, caller treats this as "not signed in"
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return out;
}

/** Strip the quotes Cursor stores around some scalar values. */
function unquote(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed || null;
}

/**
 * Read the `sub` and `exp` claims out of the session JWT. The signature is not
 * checked: this is our own stored credential and only the server's opinion of
 * it matters; we just need to address the right account and skip a stale token.
 */
function decodeClaims(token: string): { sub: string | null; expiresAt: number | null } {
  const parts = token.split('.');
  if (parts.length !== 3) return { sub: null, expiresAt: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : null,
      expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : null,
    };
  } catch {
    return { sub: null, expiresAt: null };
  }
}

function resolvePlan(membershipType: string | null): SubscriptionPlan | null {
  const type = membershipType?.trim().toLowerCase();
  if (!type) return null;
  if (type === 'free' || type === 'free_trial') return { id: 'free', label: 'Free' };
  if (type === 'pro') return { id: 'pro', label: 'Pro' };
  if (type === 'pro_plus' || type === 'pro+') return { id: 'pro-plus', label: 'Pro+' };
  if (type === 'ultra') return { id: 'ultra', label: 'Ultra' };
  if (type === 'team' || type === 'business') return { id: 'team', label: 'Team' };
  if (type === 'enterprise') return { id: 'enterprise', label: 'Enterprise' };
  return { id: type, label: type.charAt(0).toUpperCase() + type.slice(1) };
}

export interface CursorAccount {
  /** Session JWT for the dashboard fetch. Never leaves the main process. */
  accessToken: string | null;
  /** Account id ('auth0|user_01…'). The cookie pairs it with the token. */
  userId: string | null;
  email: string | null;
  plan: SubscriptionPlan | null;
  /** True when Cursor is installed but nobody is signed in. */
  signedOut: boolean;
  /** True when the stored session has expired and Cursor needs a re-login. */
  tokenExpired: boolean;
  /** True when no Cursor installation was found at all. */
  missing: boolean;
}

const EMPTY: CursorAccount = {
  accessToken: null,
  userId: null,
  email: null,
  plan: null,
  signedOut: false,
  tokenExpired: false,
  missing: true,
};

/** Read the local Cursor session. Never throws. */
export function readCursorAccount(): CursorAccount {
  const file = statePaths().find((p) => existsSync(p));
  if (!file) return EMPTY;

  const values = readKeys(file, [
    'cursorAuth/accessToken',
    'cursorAuth/cachedEmail',
    'cursorAuth/stripeMembershipType',
    'glass.lastSignedInAuthId',
    APP_USER_KEY,
  ]);

  const accessToken = unquote(values.get('cursorAuth/accessToken'));
  const email = unquote(values.get('cursorAuth/cachedEmail'));

  let membership = unquote(values.get('cursorAuth/stripeMembershipType'));
  const rawAppUser = values.get(APP_USER_KEY);
  if (!membership && rawAppUser) {
    try {
      const parsed = JSON.parse(rawAppUser) as Record<string, unknown>;
      if (typeof parsed.membershipType === 'string') membership = parsed.membershipType;
    } catch {
      /* blob shape changed, the auth key above still carries the plan */
    }
  }

  const claims = accessToken ? decodeClaims(accessToken) : { sub: null, expiresAt: null };
  const userId = claims.sub ?? unquote(values.get('glass.lastSignedInAuthId'));
  const expired = claims.expiresAt != null && claims.expiresAt <= Date.now();

  return {
    // An expired session would only earn a 401, so drop it and let the card ask
    // for a re-login instead of firing a request that cannot succeed.
    accessToken: expired ? null : accessToken,
    userId,
    email,
    plan: resolvePlan(membership),
    signedOut: !accessToken,
    tokenExpired: expired,
    missing: false,
  };
}

// The account read touches disk (and sometimes copies a few MB), while several
// widgets plus the Usage page refresh on independent timers. Hold the result
// briefly so a screen full of widgets is still one read.
const ACCOUNT_TTL_MS = 60_000;
let accountCache: { at: number; account: CursorAccount } | null = null;

export function getCursorAccount(): CursorAccount {
  if (accountCache && Date.now() - accountCache.at < ACCOUNT_TTL_MS) return accountCache.account;
  const account = readCursorAccount();
  accountCache = { at: Date.now(), account };
  return account;
}

/** Drop the cached session so an explicit Refresh re-reads it. */
export function clearCursorAccountCache(): void {
  accountCache = null;
}
