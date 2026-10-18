import type { SshAuthMethod } from '@shared/apiTypes';
import type {
  FileSite,
  FileSiteConnectionInput,
  FileSiteInput,
  FileSiteProtocol,
} from '@shared/deployFilesTypes';
import { DEFAULT_PORT } from './messages';

/**
 * The add and edit site form's model (E23), kept free of React so every rule is tested on its
 * own: defaults, which details belong to which protocol, what is valid, and what goes to main.
 *
 * Trust the user gave (a host key, a certificate pin, the certificate's own name) belongs to one
 * host and port. It is kept with the host and port it was given for and only sent while the form
 * still names them, so typing a different host never carries an old trust along, and typing the
 * old one back brings it back.
 */

export type SiteSource = 'saved' | 'custom';

export interface SiteDraft {
  protocol: FileSiteProtocol;
  /** SFTP only: a server saved in Remote, or a login of the site's own. */
  source: SiteSource;
  sshServerId: string;
  host: string;
  port: string;
  /** The user typed a port, so a protocol switch leaves it alone (unless it is the default). */
  portTouched: boolean;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath: string;
  /** Typed in this dialog only; a stored one never comes back from main. */
  secret: string;
  hostKeyFingerprint: string | null;
  tlsPin: string | null;
  tlsServername: string | null;
  /** `host:port` the three trust fields above were given for. */
  trustedFor: string | null;
  remoteRoot: string;
  localFolder: string;
  projectIds: string[];
  deployOnSave: boolean;
  quietSeconds: string;
  label: string;
  /** Not edited here (the site view has them); carried so an edit keeps them. */
  ignorePatterns: string[];
}

export type SiteDraftField =
  | 'sshServerId'
  | 'host'
  | 'port'
  | 'username'
  | 'privateKeyPath'
  | 'secret'
  | 'localFolder'
  | 'remoteRoot'
  | 'quietSeconds'
  | 'label';

export type SiteDraftErrors = Partial<Record<SiteDraftField, string>>;

/** The order the fields appear in the form, for focusing the first one that is wrong. */
export const FIELD_ORDER: readonly SiteDraftField[] = [
  'sshServerId',
  'host',
  'port',
  'username',
  'privateKeyPath',
  'secret',
  'localFolder',
  'remoteRoot',
  'quietSeconds',
  'label',
];

const CONNECTION_FIELDS: readonly SiteDraftField[] = [
  'sshServerId',
  'host',
  'port',
  'username',
  'privateKeyPath',
  'secret',
];

export const DEFAULT_QUIET_SECONDS = 5;
export const MIN_QUIET_SECONDS = 2;
export const MAX_QUIET_SECONDS = 120;
const MAX_LABEL = 100;

export function emptyDraft(): SiteDraft {
  return {
    protocol: 'sftp',
    source: 'custom',
    sshServerId: '',
    host: '',
    port: String(DEFAULT_PORT.sftp),
    portTouched: false,
    username: '',
    authMethod: 'password',
    privateKeyPath: '',
    secret: '',
    hostKeyFingerprint: null,
    tlsPin: null,
    tlsServername: null,
    trustedFor: null,
    remoteRoot: '',
    localFolder: '',
    projectIds: [],
    deployOnSave: false,
    quietSeconds: String(DEFAULT_QUIET_SECONDS),
    label: '',
    ignorePatterns: [],
  };
}

function pinKey(host: string, port: string): string {
  return `${host.trim().toLowerCase()}:${port.trim()}`;
}

export function draftFromSite(site: FileSite): SiteDraft {
  const base: SiteDraft = {
    ...emptyDraft(),
    protocol: site.protocol,
    port: String(DEFAULT_PORT[site.protocol]),
    remoteRoot: site.remoteRoot,
    localFolder: site.localFolder,
    projectIds: [...site.projectIds],
    deployOnSave: site.deployOnSave,
    quietSeconds: String(site.quietSeconds),
    label: site.label,
    ignorePatterns: [...site.ignorePatterns],
  };
  const connection = site.connection;
  if (connection.kind === 'saved') {
    return { ...base, source: 'saved', sshServerId: connection.sshServerId };
  }
  const port = String(connection.port);
  return {
    ...base,
    source: 'custom',
    host: connection.host,
    port,
    portTouched: connection.port !== DEFAULT_PORT[site.protocol],
    username: connection.username,
    authMethod: connection.authMethod,
    privateKeyPath: connection.privateKeyPath ?? '',
    hostKeyFingerprint: connection.hostKeyFingerprint,
    tlsPin: connection.tlsPin,
    tlsServername: connection.tlsServername,
    trustedFor: pinKey(connection.host, port),
  };
}

/** A port still on the old protocol's default follows the new one; a chosen one stays. */
export function withProtocol(draft: SiteDraft, protocol: FileSiteProtocol): SiteDraft {
  const follows = !draft.portTouched || draft.port.trim() === String(DEFAULT_PORT[draft.protocol]);
  const sftp = protocol === 'sftp';
  const authMethod: SshAuthMethod = sftp ? draft.authMethod : 'password';
  return {
    ...draft,
    protocol,
    port: follows ? String(DEFAULT_PORT[protocol]) : draft.port,
    portTouched: follows ? false : draft.portTouched,
    source: sftp ? draft.source : 'custom',
    authMethod,
    // A key passphrase is no password, so it never carries over.
    secret: authMethod === draft.authMethod ? draft.secret : '',
  };
}

/** A typed password is no key passphrase (or the other way round), so switching drops it. */
export function withAuthMethod(draft: SiteDraft, authMethod: SshAuthMethod): SiteDraft {
  if (authMethod === draft.authMethod) return draft;
  return { ...draft, authMethod, secret: '' };
}

export function withPort(draft: SiteDraft, port: string): SiteDraft {
  return { ...draft, port, portTouched: true };
}

export function withHost(draft: SiteDraft, host: string): SiteDraft {
  return { ...draft, host };
}

/** Records trust for the host and port the form names now, dropping trust given elsewhere. */
export function withTrust(
  draft: SiteDraft,
  trust: Partial<Pick<SiteDraft, 'hostKeyFingerprint' | 'tlsPin' | 'tlsServername'>>,
): SiteDraft {
  const here = pinKey(draft.host, draft.port);
  const kept =
    draft.trustedFor === here
      ? draft
      : { ...draft, hostKeyFingerprint: null, tlsPin: null, tlsServername: null };
  return { ...kept, ...trust, trustedFor: here };
}

function folderName(path: string): string {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

/** The name a site gets when none is typed: its host, its saved server, or its folder. */
export function defaultLabel(draft: SiteDraft, savedServerName?: string | null): string {
  const fromServer =
    draft.source === 'saved' && draft.protocol === 'sftp'
      ? (savedServerName ?? '')
      : draft.host.trim();
  return fromServer || folderName(draft.localFolder.trim()) || 'New site';
}

function quietSecondsOf(draft: SiteDraft): number {
  const value = Number.parseInt(draft.quietSeconds, 10);
  if (!Number.isFinite(value)) return DEFAULT_QUIET_SECONDS;
  return Math.min(MAX_QUIET_SECONDS, Math.max(MIN_QUIET_SECONDS, value));
}

function connectionOf(draft: SiteDraft): FileSiteConnectionInput {
  if (draft.protocol === 'sftp' && draft.source === 'saved') {
    return { kind: 'saved', sshServerId: draft.sshServerId };
  }
  const trusted = draft.trustedFor === pinKey(draft.host, draft.port);
  const sftp = draft.protocol === 'sftp';
  const ftps = draft.protocol === 'ftps';
  const authMethod: SshAuthMethod = sftp ? draft.authMethod : 'password';
  return {
    kind: 'custom',
    host: draft.host.trim(),
    port: Number.parseInt(draft.port, 10),
    username: draft.username.trim(),
    authMethod,
    privateKeyPath: authMethod === 'privateKey' ? draft.privateKeyPath.trim() : null,
    hostKeyFingerprint: sftp && trusted ? draft.hostKeyFingerprint : null,
    tlsPin: ftps && trusted ? draft.tlsPin : null,
    tlsServername: ftps && trusted ? draft.tlsServername : null,
    ...(draft.secret ? { secret: draft.secret } : {}),
  };
}

/** What goes to main. A secret is sent only when one was typed, so an edit keeps the stored one. */
export function draftToInput(draft: SiteDraft, savedServerName?: string | null): FileSiteInput {
  return {
    label: draft.label.trim() || defaultLabel(draft, savedServerName),
    protocol: draft.protocol,
    connection: connectionOf(draft),
    remoteRoot: draft.remoteRoot.trim(),
    localFolder: draft.localFolder.trim(),
    projectIds: [...draft.projectIds],
    deployOnSave: draft.deployOnSave,
    quietSeconds: quietSecondsOf(draft),
    ignorePatterns: [...draft.ignorePatterns],
  };
}

/** Whether leaving the secret empty keeps the one main has: same kind of login, same meaning. */
export function keepsStoredSecret(draft: SiteDraft, site: FileSite | null): boolean {
  if (!site || site.connection.kind !== 'custom' || !site.connection.hasSecret) return false;
  if (draft.protocol === 'sftp' && draft.source === 'saved') return false;
  const authMethod = draft.protocol === 'sftp' ? draft.authMethod : 'password';
  return authMethod === site.connection.authMethod;
}

const ABSOLUTE_LOCAL = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function validateDraft(
  draft: SiteDraft,
  { storedSecret }: { storedSecret: boolean },
): SiteDraftErrors {
  const errors: SiteDraftErrors = {};
  if (draft.protocol === 'sftp' && draft.source === 'saved') {
    if (!draft.sshServerId) errors.sshServerId = 'Pick a server saved in Remote.';
  } else {
    const host = draft.host.trim();
    if (!host) errors.host = 'Enter the host name of the server.';
    else if (SCHEME.test(host)) {
      errors.host = 'Leave out the ftp:// or sftp:// part, just the name, like files.example.com.';
    } else if (/[\s/\\]/.test(host)) errors.host = 'A host name has no spaces or slashes.';

    const port = draft.port.trim();
    const portNumber = Number(port);
    if (!/^\d+$/.test(port) || portNumber < 1 || portNumber > 65535) {
      errors.port = 'Use a port from 1 to 65535.';
    }
    if (!draft.username.trim()) errors.username = 'Enter the username.';

    const authMethod = draft.protocol === 'sftp' ? draft.authMethod : 'password';
    if (authMethod === 'privateKey') {
      if (!draft.privateKeyPath.trim()) errors.privateKeyPath = 'Choose the private key file.';
    } else if (!draft.secret && !storedSecret) {
      errors.secret = 'Enter the password.';
    }
  }

  const remoteRoot = draft.remoteRoot.trim();
  if (!remoteRoot) errors.remoteRoot = 'Enter the folder on the server.';
  else if (!remoteRoot.startsWith('/')) {
    errors.remoteRoot = 'Start the folder with /, like /public_html.';
  }

  const localFolder = draft.localFolder.trim();
  if (!localFolder) errors.localFolder = 'Choose the folder to deploy.';
  else if (!ABSOLUTE_LOCAL.test(localFolder)) {
    errors.localFolder = 'Use the full path of the folder.';
  }

  if (draft.deployOnSave) {
    const quiet = draft.quietSeconds.trim();
    const seconds = Number(quiet);
    if (!/^\d+$/.test(quiet) || seconds < MIN_QUIET_SECONDS || seconds > MAX_QUIET_SECONDS) {
      errors.quietSeconds = `Use ${MIN_QUIET_SECONDS} to ${MAX_QUIET_SECONDS} seconds.`;
    }
  }

  if (draft.label.trim().length > MAX_LABEL) {
    errors.label = `Keep the name to ${MAX_LABEL} characters.`;
  }
  return errors;
}

/**
 * The errors that stop a connection test (the login and the server folder) or a browse (the
 * login alone). The deploy folder, name and options don't matter to the server.
 */
export function testBlockers(errors: SiteDraftErrors, mode: 'test' | 'browse'): SiteDraftErrors {
  const fields: readonly SiteDraftField[] =
    mode === 'test' ? [...CONNECTION_FIELDS, 'remoteRoot'] : CONNECTION_FIELDS;
  const found: SiteDraftErrors = {};
  for (const field of fields) {
    if (errors[field]) found[field] = errors[field];
  }
  return found;
}

export function firstError(errors: SiteDraftErrors): SiteDraftField | null {
  return FIELD_ORDER.find((field) => errors[field]) ?? null;
}

/** Changes whenever a test's answer could: anything about the login, or the server folder. */
export function connectionKey(draft: SiteDraft): string {
  return JSON.stringify([draft.protocol, connectionOf(draft), draft.remoteRoot.trim()]);
}

/** Names the connection for the browse cache. Never carries the secret. */
export function browseTarget(draft: SiteDraft, siteId: string | null): string {
  const { secret: _secret, ...connection } = connectionOf(draft) as FileSiteConnectionInput & {
    secret?: string;
  };
  return `${siteId ?? 'new'}|${draft.protocol}|${JSON.stringify(connection)}`;
}
