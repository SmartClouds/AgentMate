import type {
  AlertInfo,
  JobInfo,
  JobLogLine,
  MetricsResolution,
  MetricsSample,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Plain data the Deploy section passes between the main process and the renderer. Nothing here
 * carries a secret: sudo passwords only travel from the renderer into an install call.
 */

/**
 * How the app reaches a server's core: a tunnel to its socket, its stdio bridge, the DevHost, or
 * the core's own HTTPS port (direct TLS, E16).
 */
export type DeployTransport = 'streamlocal' | 'bridge' | 'dev-tcp' | 'direct-tls';

/** What the app remembers about the core it installed on a server. */
/**
 * Where a server's core is installed: the layout from before the rename (release 1.63 and older)
 * or the Runova one. A core from 1.64 on moves a server from the first to the second.
 */
export type DeployCoreLayout = 'legacy' | 'runova';

export interface DeployCoreRecord {
  version: string;
  /** The release folder on the server. */
  release: string;
  /** Left out by records saved before the rename, which are all `legacy`. */
  layout?: DeployCoreLayout;
  transport: DeployTransport;
  installedAt: number;
  /** The server's own name for its OS, such as "Ubuntu 24.04.1 LTS", at install time. */
  os: string;
  /** What `uname -m` said, such as x86_64. */
  architecture: string;
}

/** A saved server from the Remote section, with its core if one is installed. */
export interface DeployServer {
  id: string;
  nickname: string;
  host: string;
  port: number;
  username: string;
  core: DeployCoreRecord | null;
  /** Whether this computer has a device on the core (not whether it is signed in right now). */
  enrolled: boolean;
  /** Only the DevHost, a development stand-in for a server; it cannot be installed or removed. */
  dev?: boolean;
}

export type DeploySudoMode = 'root' | 'passwordless' | 'password';

/** A read-only look at a server before an install. */
export interface DeployPreflight {
  os: string;
  supported: boolean;
  architecture: string;
  /** Whether there is a server core build for this processor. */
  architectureSupported: boolean;
  systemd: boolean;
  /** Null when sudo is missing on a non-root login (listed in `problems`). */
  sudo: DeploySudoMode | null;
  loginUser: string;
  /** Whether the saved login password can be tried for sudo. */
  hasSavedPassword: boolean;
  transport: 'streamlocal' | 'bridge';
  selinux: 'enforcing' | 'permissive' | 'disabled' | 'absent';
  freeDiskMb: number | null;
  /**
   * Whether the server can download the core from GitHub itself. When it cannot (no curl or wget,
   * no route to GitHub, or a development build), the app downloads it and uploads it over SSH.
   */
  serverDownload: boolean;
  installed: { version: string } | null;
  /** The core version this app installs; null when this build has none to offer. */
  available: string | null;
  /** What stands in the way of an install; empty when it can go ahead. */
  problems: string[];
}

export type DeploySetupPhase =
  | 'preflight'
  | 'fetch'
  | 'download'
  | 'upload'
  | 'verify'
  | 'group'
  | 'extract'
  | 'selinux'
  | 'unit'
  | 'switch'
  | 'start'
  | 'cleanup'
  | 'rollback'
  | 'health'
  | 'migrate'
  | 'owner'
  | 'enroll'
  | 'sign-in'
  | 'stop'
  | 'remove';

export interface DeploySetupProgress {
  phase: DeploySetupPhase;
  title: string;
  status: 'running' | 'done' | 'failed';
  /** Why a step failed, or what a finished step wants the user to know. */
  detail?: string;
  /** How much of the upload reached the server, 0 to 100. */
  percent?: number;
}

/** The core release this build installs, for the Deploy page to offer as an update. */
export interface DeployCoreRelease {
  version: string;
  /** Whether a server may download it from GitHub itself (packaged builds); otherwise it is uploaded. */
  serverDownload: boolean;
}

/**
 * How an update through the core itself ended (no SSH). `needs-ssh` is not a failure: this core
 * cannot replace itself (an older release, or one the app did not install), so the SSH installer
 * is the way, and the reason says why.
 */
export type DeployCoreUpdateResult =
  | {
      outcome: 'updated';
      version: string;
      previousVersion: string;
      /** Whether the server fetched the release itself or this app uploaded it. */
      via: 'server-download' | 'upload';
      /** The layout the core runs in afterwards. */
      layout?: DeployCoreLayout;
      /** The update worked, but moving the server to the Runova layout did not (and was put back). */
      migrationError?: string;
    }
  | { outcome: 'needs-ssh'; reason: string };

export interface DeploySetupProgressEvent {
  serverId: string;
  progress: DeploySetupProgress;
}

export interface DeployInstallResult {
  version: string;
  release: string;
  transport: 'streamlocal' | 'bridge';
  /** The version this install replaced, if any. */
  previousVersion: string | null;
  /** The layout the core ended up in. */
  layout?: DeployCoreLayout;
  /** The server stayed on the legacy layout because moving it failed (and was put back). */
  migrationError?: string;
  /** The core runs, but this computer's access could not be set up; it can be retried. */
  enrollmentError?: string;
}

/** A user on a core: the owner to create on a new one, or who to sign in as. */
export interface DeployAccountInput {
  userName: string;
  password: string;
}

export interface DeployInstallInput {
  serverId: string;
  /** Null tries the saved login password, when sudo asks for one. */
  sudoPassword: string | null;
  /** Sets up this computer's access right after the install; left out, it is done later. */
  account?: DeployAccountInput;
}

/** Enrolls this computer over SSH (again, after a revocation): its own device key for a user. */
export interface DeployEnrollInput {
  serverId: string;
  sudoPassword: string | null;
  account: DeployAccountInput;
}

export interface DeploySignInInput {
  serverId: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
}

export interface DeployStepUpInput {
  serverId: string;
  password?: string;
  totpCode?: string;
}

/**
 * Whether this computer can act on a server's core: signed in; enrolled but with no live session;
 * refused by the core as a device (revoked or unknown, so enroll again); never enrolled here; or
 * not reachable right now.
 */
export type DeployAccessState =
  | 'signed-in'
  | 'needs-sign-in'
  | 'needs-re-enroll'
  | 'not-enrolled'
  | 'unreachable';

export interface DeployAccess {
  state: DeployAccessState;
  user?: { userName: string; roles: string[]; twoFactorEnabled: boolean };
  /** For 'unreachable' and a locked account: what went wrong. */
  message?: string;
  /** This computer remembers the account password, and answers the core's confirmations with it. */
  passwordSaved?: boolean;
}

/** A new authenticator key, as text and as a QR code image (a data URL). */
export interface DeployTotpSetup {
  sharedKey: string;
  authenticatorUri: string;
  qrDataUrl: string;
}

export interface DeployUninstallInput {
  serverId: string;
  sudoPassword: string | null;
  keepData: boolean;
}

export interface DeployHealth {
  version: string;
  apiVersion: number;
  startedAtUnixMs: number;
  checkedAt: number;
  /** What the check went through: direct TLS when it answers, else the install's SSH channel. */
  transport?: DeployTransport;
  /** The layout the core runs in; cores from before the rename do not say, and are legacy. */
  layout?: DeployCoreLayout;
  /** Why the last move to the Runova layout was put back. */
  migrationError?: string;
  /** Why moving nginx to the new names was put back; it keeps its old names and works as before. */
  nginxMoveError?: string;
}

/**
 * A server's lasting connection to its core, as the Overview shows it: on its way up for the
 * first time; up; lost and being tried again; down while nothing needs it (or not reachable
 * yet, with `retryAt` when it is still being tried); or waiting for the user: a sign-in, a new
 * enrollment, or the Servers vault unlocked.
 */
export type DeployConnectionState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'needs-sign-in'
  | 'needs-re-enroll'
  | 'locked';

export interface DeployConnection {
  serverId: string;
  state: DeployConnectionState;
  /** When it entered this state (this computer's clock). */
  since: number;
  /** What went wrong last, when it is not online. */
  message?: string;
  /** When the next attempt is due, while it keeps trying. */
  retryAt?: number;
  /** What the connection rides on, while online (direct TLS or an SSH channel). */
  transport?: DeployTransport;
  /** Why it stopped for good: the direct TLS certificate is not the one pinned over SSH. */
  problem?: 'tls-pin-mismatch';
}

/** Live metrics for a server; `sinceUnixMs` asks for the samples after it first, to join history. */
export interface DeployMetricsWatchInput {
  serverId: string;
  /** 1000 to 60000; 2000 when left out. A server runs two intervals at most at a time. */
  intervalMs?: number;
  sinceUnixMs?: number;
}

/** A batch of live samples for one metrics subscription, oldest first. */
export interface DeployMetricsEvent {
  subscriptionId: string;
  serverId: string;
  samples: MetricsSample[];
}

/** One job's log after line `afterSeq` (0, or left out, for all of it). */
export interface DeployJobWatchInput {
  serverId: string;
  jobId: string;
  afterSeq?: number;
}

/**
 * New lines of a job's log (already redacted by the core), with the job when it changed. The
 * last event of a subscription carries `ended`: the job reached its final state (in `job`), or
 * the core refused to show the log (`ended.error`).
 */
export interface DeployJobEvent {
  subscriptionId: string;
  serverId: string;
  jobId: string;
  lines: JobLogLine[];
  job?: JobInfo;
  ended?: { error?: string };
}

/**
 * Alerts in revision order: every open one when the subscription starts, then each change
 * (a resolved alert carries `resolvedAtUnixMs`). Keep the highest revision per alert id.
 */
export interface DeployAlertsEvent {
  subscriptionId: string;
  serverId: string;
  alerts: AlertInfo[];
}

/** Stored metrics: the last 15 minutes live, 1-minute points for 48 hours, 15-minute for 30 days. */
export interface DeployMetricsHistoryInput {
  serverId: string;
  resolution: MetricsResolution;
  fromUnixMs?: number;
  toUnixMs?: number;
}

/** A page of a server's jobs, newest first; pass the last page's cursor for the next one. */
export interface DeployJobsQuery {
  serverId: string;
  activeOnly?: boolean;
  /** 1 to 200. */
  limit?: number;
  beforeCreatedAtUnixMs?: number;
}

/** A server's alerts, newest change first: the open ones, or resolved ones too. */
export interface DeployAlertsQuery {
  serverId: string;
  includeResolved?: boolean;
  /** 1 to 500. */
  limit?: number;
}
