import type {
  AgentType,
  Project,
  WpAuditEntry,
  WpDeployRecord,
  WpDeployState,
  WpHealthCheck,
  WpItem,
  WpItemRef,
  WpPlannedChange,
  WpRollbackReason,
  WpScope,
  WpSiteInfo,
} from '@agentmat/core';

/**
 * Plain data the WordPress side of Deploy (E19 to E21) passes between the main process and the
 * renderer. Nothing here carries a secret, except the inputs marked "in only": a connection key
 * or an HTTP password goes from the renderer into a call and is never sent back, logged or kept
 * anywhere but the sealed store in the main process.
 *
 * Times: fields that come from the plugin (`Wp*` types) are Unix seconds, as on the wire. Times
 * the app records itself (`connectedAt`, `lastSeenAt`, `checkedAt`, a plan's `expiresAt`) are
 * milliseconds, like `Date.now()` and the rest of the app.
 */

/** A WordPress site connected through the AgentMate Connector plugin. */
export interface DeployWordPressSite {
  id: string;
  /** The user's name for it; the site's own name until they change it. */
  label: string;
  siteUrl: string;
  siteName: string;
  scope: WpScope;
  /** How calls travel: HTTPS, plain HTTP to this computer, or plain HTTP the user allowed. */
  transport: 'https' | 'local-http' | 'plain-http';
  allowPlainHttp: boolean;
  /** HTTP Basic sign-in for a staging site is saved (the password itself never comes back). */
  hasHttpAuth: boolean;
  pluginVersion: string;
  protocol: number;
  /** Milliseconds. */
  connectedAt: number;
  /** Milliseconds; the last reply that checked out. */
  lastSeenAt: number | null;
}

export interface DeployWordPressHttpAuth {
  username: string;
  /** In only. */
  password: string;
}

export interface DeployWordPressConnectInput {
  /** In only: the `amwp1.` key from wp-admin. Good once, for 15 minutes. */
  connectionKey: string;
  label?: string;
  /** Needed when the key's URLs are plain HTTP to another computer. */
  allowPlainHttp?: boolean;
  httpAuth?: DeployWordPressHttpAuth;
}

export interface DeployWordPressDisconnectInput {
  siteId: string;
  /** Also revoke this computer's connection on the site, when the site can be reached. */
  revokeOnSite: boolean;
}

export interface DeployWordPressSettingsInput {
  siteId: string;
  label?: string;
  allowPlainHttp?: boolean;
  /** Null removes the saved sign-in. */
  httpAuth?: DeployWordPressHttpAuth | null;
}

/** `checkedAt` is milliseconds; the WpSiteInfo fields stay in seconds. */
export type DeployWordPressSiteInfo = WpSiteInfo & { checkedAt: number };

export type DeployWordPressLeftOutReason =
  /** Agent settings, skills or AgentMate's own files (the hard deny list's agent entries). */
  | 'agentFiles'
  /** The rest of the hard deny list: version control, secrets, PHP config, OS clutter. */
  | 'hardDenied'
  /** An ignore rule (default list, `.distignore`, `.agentmateignore`). */
  | 'ignored'
  | 'symlink'
  | 'tooLarge'
  | 'caseCollision'
  | 'notUtf8'
  | 'pathRejected';

export interface DeployWordPressLeftOut {
  item: WpItemRef;
  path: string;
  reason: DeployWordPressLeftOutReason;
}

export type DeployWordPressWarning =
  | 'deletesActivePluginMainFile'
  | 'touchesActiveThemeCore'
  | 'createsItem'
  | 'noRescueGuard'
  | 'healthCheckUnavailable'
  | 'plainHttp'
  | 'readOnlyScope'
  | 'lineEndingsOnly';

/** A pull or deploy worked out and waiting for the user to look at it. Kept 15 minutes. */
export interface DeployWordPressPlan {
  planId: string;
  projectId: string;
  siteId: string;
  direction: 'deploy' | 'pull';
  changes: WpPlannedChange[];
  conflicts: WpPlannedChange[];
  leftOut: DeployWordPressLeftOut[];
  warnings: DeployWordPressWarning[];
  uploadBytes: number;
  downloadBytes: number;
  /** Milliseconds. */
  expiresAt: number;
}

export interface DeployWordPressPlanInput {
  projectId: string;
  /** Only these of the project's items; all of them when left out. */
  items?: WpItemRef[];
}

export interface DeployWordPressRunInput {
  planId: string;
  /** Picked by the renderer, so progress events can be matched before the call returns. */
  operationId: string;
  /** Deploy: go ahead over conflicts and forceable warnings. */
  force: boolean;
  /** Pull only: what to do with each conflicting path, keyed by `wpItemKey(item) + '/' + path`. */
  resolutions?: Record<string, 'keepLocal' | 'takeRemote'>;
}

export interface DeployWordPressDeployResult {
  deployId: string;
  state: WpDeployState;
  reason?: WpRollbackReason;
  health: WpHealthCheck[];
  uploaded: number;
  deleted: number;
  durationMs: number;
}

export interface DeployWordPressPullResult {
  downloaded: number;
  deletedLocal: number;
  /** Project-relative paths of copies kept under `.agentmate/wordpress/conflicts/`. */
  conflictCopies: string[];
  leftOut: DeployWordPressLeftOut[];
}

export interface DeployWordPressCreateProjectInput {
  operationId: string;
  siteId: string;
  items: WpItemRef[];
  /** Absolute; the item folders inside it must be missing or empty. */
  folderPath: string;
  name: string;
  description?: string;
  agentType: AgentType;
  tags?: string[];
}

export interface DeployWordPressItemsInput {
  operationId: string;
  projectId: string;
  /**
   * Moves the link to this site, for a project whose site was disconnected and connected again
   * (which gives it a new id). The items must exist on that site; the last sync is kept only
   * when it is the same site (same site key), otherwise the next pull starts fresh.
   */
  siteId?: string;
  /** The project's new item list; newly added items are pulled. */
  items: WpItemRef[];
  /**
   * The items among `items` that the site does not have yet: a theme or plugin made in this
   * project. Their folders must already hold files. They are linked without a pull, and the
   * first deploy creates them on the site.
   */
  newItems?: WpItemRef[];
}

/**
 * The files and folders a project leaves out of its pulls and deploys, as gitignore-like lines
 * relative to each item's root: under `*` for every item, or `theme:slug` for one. Replaces the
 * saved list as a whole.
 */
export interface DeployWordPressIgnoreInput {
  projectId: string;
  ignore: Record<string, string[]>;
}

/** Makes an existing project, not yet linked to any site, a WordPress project. */
export interface DeployWordPressLinkProjectInput {
  operationId: string;
  projectId: string;
  siteId: string;
  items: WpItemRef[];
  /** As in DeployWordPressItemsInput: items among `items` the site does not have yet. */
  newItems?: WpItemRef[];
}

/** A theme or plugin folder (or single-file plugin) found in a project's wp-content. */
export interface DeployWordPressLocalItem extends WpItemRef {
  /** A single `.php` file rather than a folder. */
  isFile: boolean;
  /** The project already syncs it. */
  linked: boolean;
}

export interface DeployWordPressLinkProjectResult {
  project: Project;
  /**
   * Items whose folders already held files. They are linked but not pulled, so nothing in them
   * is overwritten; a pull compares them with the site file by file.
   */
  notPulled: WpItemRef[];
}

export interface DeployWordPressRollbackInput {
  operationId: string;
  siteId: string;
  deployId: string;
  force?: boolean;
}

export interface DeployWordPressAuditQuery {
  siteId: string;
  limit: number;
  /** An audit entry id: only older entries. */
  before?: number;
}

export interface DeployWordPressRemoteFileInput {
  projectId: string;
  item: WpItemRef;
  path: string;
}

/** A site file for the diff view: text when it is small and UTF-8, otherwise just its facts. */
export interface DeployWordPressRemoteFile {
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  /** Null when the site does not have the file. */
  sha256: string | null;
}

export interface DeployWordPressLocalChanges {
  projectId: string;
  added: number;
  modified: number;
  deleted: number;
  /** Milliseconds. */
  checkedAt: number;
}

export type DeployWordPressPhase =
  | 'connecting'
  | 'manifest'
  | 'hashing'
  | 'download'
  | 'write'
  | 'upload'
  | 'validate'
  | 'apply'
  | 'verify'
  | 'finalize'
  | 'rollback'
  | 'done'
  | 'failed';

export type DeployWordPressOperationKind =
  | 'pull'
  | 'deploy'
  | 'rollback'
  | 'createProject'
  | 'items';

export interface DeployWordPressProgressEvent {
  operationId: string;
  siteId: string;
  projectId: string | null;
  kind: DeployWordPressOperationKind;
  phase: DeployWordPressPhase;
  done: number;
  total: number;
  bytes?: number;
  message?: string;
  /** Set with phase `failed`: the error message, its `[wp:code]` tag included. */
  error?: string;
}

export type DeployWordPressSaveZipResult = { saved: false } | { saved: true; path: string };

/** What updating the connector on a site from this app did. */
export interface DeployWordPressUpdateConnectorResult {
  /**
   * `updated`: the site runs the bundled version now. `rolledBack`: the site failed its health
   * check with it, so the old files are back. `current`: the site already had this version or a
   * newer one, and nothing was sent.
   */
  outcome: 'updated' | 'rolledBack' | 'current';
  /** The version the site ran before the update. */
  fromVersion: string;
  /** The version that comes with this app. */
  version: string;
  /** The site's health checks after the swap; empty when nothing was sent. */
  checks: WpHealthCheck[];
  /**
   * Where the new files came from: `site` when the site downloaded the GitHub release itself,
   * `app` when this app sent them. Absent when nothing was sent.
   */
  source?: 'site' | 'app';
  /** Why the site could not download the release itself, when the app sent the files instead. */
  downloadProblem?: string;
}

/** Re-exported so renderer code can import everything WordPress from one place. */
export type { Project, WpAuditEntry, WpDeployRecord, WpItem, WpItemRef };
