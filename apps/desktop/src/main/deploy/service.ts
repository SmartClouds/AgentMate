import { hostname } from 'node:os';
import QRCode from 'qrcode';
import type { SecretEnvelope, SshAuthMethod, StoredSshServer } from '../../shared/apiTypes';
import { coreErrorCode, coreErrorMessage } from '../../shared/coreErrors';
import type {
  AccountInfo,
  HealthResponse,
  RecoveryCodes,
  SignedInUser,
  StepUpResponse,
} from '../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import type {
  DeployRestoreInput,
  DeployRestoreProgress,
  DeployRestoreResult,
} from '../../shared/deployHardeningTypes';
import type { DeployRedeemCodeInput } from '../../shared/deploySecurityTypes';
import type {
  DeployAccess,
  DeployAccountInput,
  DeployConnection,
  DeployCoreRecord,
  DeployEnrollInput,
  DeployHealth,
  DeployInstallInput,
  DeployInstallResult,
  DeployPreflight,
  DeployServer,
  DeploySetupProgress,
  DeploySetupProgressEvent,
  DeploySignInInput,
  DeployStepUpInput,
  DeployTotpSetup,
  DeployTransport,
  DeployUninstallInput,
} from '../../shared/deployTypes';
import { TunnelRefusedError } from '../ssh/connection';
import { openRootShell } from '../ssh/sudo';
import { VaultLockedError } from '../ssh/vaultErrors';
import { type CoreRest, CoreSessions } from './auth/coreSessions';
import { createDeviceKey } from './auth/deviceKey';
import { redeemEnrollmentCode } from './auth/enrollmentCode';
import { coreGroupAccess, coreGroupProblem } from './bootstrap/coreGroup';
import { enrollOverSsh } from './bootstrap/enrollment';
import { type InstallerConnection, installCore, uninstallCore } from './bootstrap/installer';
import { runPreflight } from './bootstrap/preflight';
import type { ReleaseSource } from './bootstrap/releaseSource';
import { type RestoredCore, restoreCore } from './bootstrap/restore';
import { CoreHttpClient } from './connection/coreHttp';
import { coreHub, createCoreHubConnection } from './connection/coreHub';
import { hubMessage } from './connection/hubErrors';
import { HubStartError, type LiveHubSession, startLiveHub } from './connection/liveHub';
import {
  bridgeTransport,
  type CoreTransport,
  devTcpTransport,
  streamLocalTransport,
} from './connection/transport';
import { clientCertificate } from './directTls/clientCertificate';
import { directTlsTransport, PinMismatchError, type TlsConnect } from './directTls/transport';
import { CoreLinks } from './live/coreLinks';
import { LinkBlockedError } from './live/linkFailures';
import type { DeployState } from './state';

/**
 * The Deploy section's main-process side: saved servers with the core each one runs, a preflight,
 * one install or removal at a time per server, and health checks through whichever channel the
 * install found works. This computer enrolls on a core over SSH (with the install or later), signs
 * in with its device key, and manages its account through the hub. Development builds can add the
 * DevHost, reached over loopback TCP, which enrolls a device by itself since it has no SSH.
 */

export const DEV_SERVER_ID = 'devhost';

type SavedServer = Pick<
  StoredSshServer,
  'id' | 'nickname' | 'host' | 'port' | 'username' | 'authMethod'
> & { secretEnvelope?: unknown };

export interface DeployLease {
  connection: InstallerConnection;
  release: () => void;
}

/** A started hub connection and a way to stop it. */
export interface CoreHubSession {
  hub: ICoreHub;
  stop: () => Promise<void>;
}

export interface DeployServiceDeps {
  /** The Remote section's saved SSH servers. */
  servers: () => Promise<SavedServer[]>;
  pool: {
    acquire: (serverId: string) => Promise<DeployLease>;
    /** Drops the server's connection, so the next acquire logs in again. */
    reset: (serverId: string) => void;
    /** A new SSH connection of its own, closed on release (confirming a firewall change). */
    openSeparate?: (serverId: string) => Promise<DeployLease>;
  };
  state: DeployState;
  releases: ReleaseSource;
  /** The core version this build installs, or null when it has none to offer. */
  availableVersion: () => Promise<string | null>;
  /** What to tell the user when `availableVersion` has nothing, such as how to build one. */
  unavailableReason?: string;
  /** The DevHost's loopback port in a development build, null everywhere else. */
  devCorePort: number | null;
  progress: (event: DeploySetupProgressEvent) => void;
  /** Asks a core for its health; tests pass a fake. */
  healthOf?: (transport: CoreTransport) => Promise<HealthResponse>;
  /** Seals a device's private key with the Servers vault, and opens it again. */
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  /** How this computer is named on a core; the host name. */
  deviceName?: () => string;
  /** The core's REST API over a transport; tests pass a fake. */
  rest?: (transport: CoreTransport) => CoreRest;
  /** A started hub connection over a transport; tests pass a fake. */
  hub?: (transport: CoreTransport, accessToken: () => Promise<string>) => Promise<CoreHubSession>;
  /** A lasting hub connection (live/coreLink.ts) with a fixed token; tests pass a fake. */
  liveHub?: (
    transport: CoreTransport,
    token: string,
    expiresAt: number | null,
  ) => Promise<LiveHubSession>;
  /** Hears every change of a server's lasting connection, for the renderer. */
  connectionChanged?: (connection: DeployConnection) => void;
  /** Called when the servers with a core and this computer on it may have changed. */
  serversChanged?: () => void;
  /** Opens a TLS socket for direct TLS; tests pass a fake. */
  tlsConnect?: TlsConnect;
  now?: () => number;
}

/** How long a direct TLS port that did not answer is left alone before it is tried again. */
const DIRECT_DOWN_MS = 60_000;
/** How long a direct TLS port that answered is used without asking it for its health again. */
const DIRECT_UP_MS = 30_000;

async function startHub(
  transport: CoreTransport,
  accessToken: () => Promise<string>,
): Promise<CoreHubSession> {
  const connection = createCoreHubConnection(transport, accessToken);
  await connection.start();
  return { hub: coreHub(connection), stop: () => connection.stop() };
}

function summary(user: SignedInUser): NonNullable<DeployAccess['user']> {
  return { userName: user.userName, roles: user.roles, twoFactorEnabled: user.twoFactorEnabled };
}

const NO_CORE = 'This build of AgentMate has no server core to install.';
const NOT_INSTALLED = 'The server core is not installed on this server yet.';
const NOT_ENROLLED = 'This computer is not enrolled on this server core yet.';
/** What the core says to a step-up with a password that is not the account's. */
const WRONG_PASSWORD = /not right/i;

export class DeployService {
  /** Each server's lasting connection, for live streams and short calls (live/coreLinks.ts). */
  readonly links: CoreLinks;
  private readonly busy = new Set<string>();
  private readonly liveHubOf: NonNullable<DeployServiceDeps['liveHub']>;
  private readonly healthOf: (transport: CoreTransport) => Promise<HealthResponse>;
  private readonly rest: (transport: CoreTransport) => CoreRest;
  private readonly hubOf: (
    transport: CoreTransport,
    accessToken: () => Promise<string>,
  ) => Promise<CoreHubSession>;
  private readonly sessions: CoreSessions;
  private readonly now: () => number;
  /** Until when each server's direct TLS port counts as down, or as up, after the last try. */
  private readonly directDown = new Map<string, number>();
  private readonly directUp = new Map<string, number>();

  constructor(private readonly deps: DeployServiceDeps) {
    this.healthOf = deps.healthOf ?? ((transport) => new CoreHttpClient(transport).health());
    this.rest = deps.rest ?? ((transport) => new CoreHttpClient(transport));
    this.hubOf = deps.hub ?? startHub;
    this.now = deps.now ?? Date.now;
    this.sessions = new CoreSessions({
      state: deps.state,
      unseal: deps.unseal,
      withCore: (serverId, work) =>
        this.withTransport(serverId, (transport) => work(this.rest(transport))),
      now: this.now,
    });
    this.liveHubOf = deps.liveHub ?? startLiveHub;
    this.links = new CoreLinks({
      open: (serverId) => this.openLive(serverId),
      onState: deps.connectionChanged,
      now: this.now,
    });
  }

  /** A server's lasting connection right now. */
  connection(serverId: string): DeployConnection {
    return this.links.info(serverId);
  }

  /** Tries a server's connection again now, as after unlocking the vault or fixing SSH. */
  reconnect(serverId: string): DeployConnection {
    this.links.retry(serverId);
    return this.links.info(serverId);
  }

  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles(serverId: string): string[] | null {
    return this.sessions.user(serverId)?.roles ?? null;
  }

  async listServers(): Promise<DeployServer[]> {
    const [saved, cores, enrolled] = await Promise.all([
      this.deps.servers(),
      this.deps.state.all(),
      this.deps.state.enrolledServers(),
    ]);
    const servers: DeployServer[] = saved.map((server) => ({
      id: server.id,
      nickname: server.nickname,
      host: server.host,
      port: server.port,
      username: server.username,
      core: cores[server.id] ?? null,
      enrolled: enrolled.has(server.id),
    }));
    const devHost = this.devHost(enrolled.has(DEV_SERVER_ID));
    return devHost ? [devHost, ...servers] : servers;
  }

  async preflight(serverId: string): Promise<DeployPreflight> {
    this.refuseDevHost(serverId);
    const server = await this.saved(serverId);
    const [report, available] = await Promise.all([
      this.withLease(serverId, (lease) =>
        runPreflight(lease.connection, {
          remote: (rid) => this.deps.releases.remote?.(rid) ?? null,
        }),
      ),
      this.deps.availableVersion(),
    ]);
    return {
      os: report.os.name,
      supported: report.os.supported,
      architecture: report.architecture.machine,
      architectureSupported: report.architecture.rid !== null,
      systemd: report.systemd,
      sudo: report.sudo,
      loginUser: report.loginUser,
      hasSavedPassword: server.authMethod === 'password' && Boolean(server.secretEnvelope),
      transport: report.streamLocal === 'prohibited' ? 'bridge' : 'streamlocal',
      selinux: report.selinux,
      freeDiskMb: report.freeDiskMb,
      serverDownload: report.serverDownload !== null,
      installed: report.installed ? { version: report.installed.version } : null,
      available,
      problems: available
        ? report.problems
        : [...report.problems, this.deps.unavailableReason ?? NO_CORE],
    };
  }

  async install(input: DeployInstallInput): Promise<DeployInstallResult> {
    this.refuseDevHost(input.serverId);
    return this.exclusive(input.serverId, async () => {
      const installed = await this.runInstall(input);
      await this.deps.state.set(input.serverId, {
        version: installed.version,
        release: installed.release,
        transport: installed.transport,
        installedAt: this.now(),
        os: installed.os,
        architecture: installed.architecture,
      });
      // The core runs from here on, whatever happens to the account setup: that part can be
      // retried from the server's card without installing again.
      let enrollmentError: string | undefined;
      if (input.account) {
        try {
          await this.setUpAccess(input.serverId, input.sudoPassword, input.account);
        } catch (error) {
          enrollmentError = coreErrorMessage(error);
        }
      }
      // The core restarted under any connection that was open; start over on the new one.
      this.links.reset(input.serverId);
      this.deps.serversChanged?.();
      return {
        version: installed.version,
        release: installed.release,
        transport: installed.transport,
        previousVersion: installed.previousVersion,
        ...(enrollmentError === undefined ? {} : { enrollmentError }),
      };
    });
  }

  /**
   * The install itself. A failed one may have restarted the core under the lasting connection (a
   * rollback to the release before), so that connection starts over either way and the app
   * reconnects to whichever release runs now.
   */
  private async runInstall(input: DeployInstallInput) {
    try {
      return await installCore(
        {
          connect: (serverId, options) => {
            if (options?.fresh) this.deps.pool.reset(serverId);
            return this.deps.pool.acquire(serverId);
          },
          releases: this.deps.releases,
          health: (connection, kind) =>
            this.healthOf(
              kind === 'bridge' ? bridgeTransport(connection) : streamLocalTransport(connection),
            ),
        },
        {
          serverId: input.serverId,
          sudoPassword: input.sudoPassword,
          onProgress: (progress) => this.deps.progress({ serverId: input.serverId, progress }),
        },
      );
    } catch (error) {
      this.links.reset(input.serverId);
      throw error;
    }
  }

  /** Enrolls this computer over SSH as a user the core has; a new device key replaces an old one. */
  async enroll(input: DeployEnrollInput): Promise<DeployAccess> {
    this.refuseDevHost(input.serverId);
    await this.exclusive(input.serverId, () =>
      this.setUpAccess(input.serverId, input.sudoPassword, input.account),
    );
    this.links.reset(input.serverId);
    this.deps.serversChanged?.();
    return this.access(input.serverId);
  }

  /**
   * Enrolls this computer with an Owner's single-use code instead of over SSH as root, then signs
   * in: the way in for someone without sudo on the server. The key is made here and sealed like an
   * SSH enrollment's. A core another computer installed is looked up first, and only remembered
   * once its code was accepted.
   */
  async redeemEnrollmentCode(input: DeployRedeemCodeInput): Promise<DeployAccess> {
    return this.exclusive(input.serverId, async () => {
      const found =
        this.isDevHost(input.serverId) || (await this.deps.state.get(input.serverId))
          ? undefined
          : await this.adoptCore(input.serverId);
      const enrolled = await this.withTransport(
        input.serverId,
        (transport) =>
          redeemEnrollmentCode(this.rest(transport), {
            code: input.code,
            userName: input.userName,
            password: input.password,
            deviceName: (this.deps.deviceName ?? hostname)().slice(0, 100),
          }),
        found,
      );
      if (found) await this.deps.state.set(input.serverId, found);
      await this.deps.state.setDevice(input.serverId, {
        deviceId: enrolled.deviceId,
        userName: input.userName,
        privateKey: await this.deps.seal(enrolled.privateKeyPem),
      });
      this.sessions.forget(input.serverId);
      try {
        const user = await this.sessions.signIn(input.serverId, { password: input.password });
        return { state: 'signed-in', user: summary(user) };
      } catch (error) {
        // Enrolled all the same: the code from the authenticator app goes in at the sign-in.
        if (coreErrorCode(error) === 'totpRequired') return { state: 'needs-sign-in' };
        throw error;
      } finally {
        // A new device (and maybe a session) either way: the lasting connection starts over on
        // it, and the alert watcher learns of a core it can now follow, as after any sign-in.
        this.links.reset(input.serverId);
        this.deps.serversChanged?.();
      }
    });
  }

  /** Whether this computer can act on the core right now, renewing its session if it has to. */
  async access(serverId: string): Promise<DeployAccess> {
    if (this.isDevHost(serverId)) await this.ensureDevDevice();
    const device = await this.deps.state.device(serverId);
    if (!device) return { state: 'not-enrolled' };
    try {
      await this.sessions.accessToken(serverId);
    } catch (error) {
      switch (coreErrorCode(error)) {
        case 'sessionExpired':
        case 'sessionRevoked':
          return { state: 'needs-sign-in' };
        case 'lockedOut':
          return { state: 'needs-sign-in', message: coreErrorMessage(error) };
        case 'deviceRevoked':
        case 'deviceUnknown':
          return { state: 'needs-re-enroll' };
        case 'notEnrolled':
          return { state: 'not-enrolled' };
        default:
          return { state: 'unreachable', message: coreErrorMessage(error) };
      }
    }
    const user = this.sessions.user(serverId);
    return {
      state: 'signed-in',
      ...(user ? { user: summary(user) } : {}),
      ...(device.password ? { passwordSaved: true } : {}),
    };
  }

  async signIn(input: DeploySignInInput): Promise<DeployAccess> {
    const user = await this.sessions.signIn(input.serverId, {
      password: input.password,
      ...(input.totpCode ? { totpCode: input.totpCode } : {}),
      ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}),
    });
    this.links.reset(input.serverId);
    return { state: 'signed-in', user: summary(user) };
  }

  /** Ends the session on the core (when it can be reached) and here. The device stays enrolled. */
  async signOut(serverId: string): Promise<void> {
    try {
      await this.withHub(serverId, (hub) => hub.signOut());
    } catch {
      // Unreachable or already over: the session is dropped here either way.
    }
    this.sessions.forget(serverId);
    const device = await this.deps.state.device(serverId);
    if (device?.sessionId || device?.password) {
      // Signing out takes the remembered password with it.
      const { sessionId: _ended, password: _saved, ...rest } = device;
      await this.deps.state.setDevice(serverId, rest);
    }
    // With no session left, the next connection waits for a sign-in instead of retrying.
    this.links.reset(serverId);
  }

  /** Drops this run's access tokens for a server, as when the vault locks. */
  forgetTokens(serverId: string): void {
    this.sessions.forget(serverId);
  }

  account(serverId: string): Promise<AccountInfo> {
    return this.withHub(serverId, (hub) => hub.getAccount());
  }

  stepUp(input: DeployStepUpInput): Promise<StepUpResponse> {
    return this.withHub(input.serverId, (hub) =>
      hub.stepUp({
        ...(input.password ? { password: input.password } : {}),
        ...(input.totpCode ? { totpCode: input.totpCode } : {}),
      }),
    );
  }

  /**
   * Steps up with the password this computer was asked to remember, so the user is not asked for
   * it again. Null when none is saved, the vault is locked, or the core turned it down; a
   * password the core says is wrong is forgotten, so it is not tried again and again.
   */
  async stepUpWithSavedPassword(serverId: string): Promise<StepUpResponse | null> {
    const saved = (await this.deps.state.device(serverId))?.password;
    if (!saved) return null;
    let password: string;
    try {
      password = await this.deps.unseal(saved);
    } catch {
      return null;
    }
    try {
      return await this.withHub(serverId, (hub) => hub.stepUp({ password }));
    } catch (error) {
      if (WRONG_PASSWORD.test(coreErrorMessage(error))) {
        await this.deps.state.setPassword(serverId, null);
      }
      return null;
    }
  }

  /** Remembers the password, sealed, once the core has confirmed it is the right one. */
  async rememberPassword(input: DeployStepUpInput): Promise<void> {
    if (!input.password) throw new Error('Enter your password to have it remembered.');
    if (!(await this.deps.state.device(input.serverId))) throw new Error(NOT_ENROLLED);
    await this.stepUp({ serverId: input.serverId, password: input.password });
    await this.deps.state.setPassword(input.serverId, await this.deps.seal(input.password));
  }

  forgetPassword(serverId: string): Promise<void> {
    return this.deps.state.setPassword(serverId, null);
  }

  async beginTotp(serverId: string): Promise<DeployTotpSetup> {
    const setup = await this.withHub(serverId, (hub) => hub.beginTotpSetup());
    const qrDataUrl = await QRCode.toDataURL(setup.authenticatorUri, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
    });
    return { sharedKey: setup.sharedKey, authenticatorUri: setup.authenticatorUri, qrDataUrl };
  }

  async confirmTotp(serverId: string, code: string): Promise<RecoveryCodes> {
    const codes = await this.withHub(serverId, (hub) => hub.confirmTotp(code));
    this.sessions.patchUser(serverId, { twoFactorEnabled: true });
    return codes;
  }

  async disableTotp(serverId: string, code: string): Promise<void> {
    await this.withHub(serverId, (hub) => hub.disableTotp(code));
    this.sessions.patchUser(serverId, { twoFactorEnabled: false });
  }

  async uninstall(input: DeployUninstallInput): Promise<void> {
    this.refuseDevHost(input.serverId);
    return this.exclusive(input.serverId, async () => {
      await uninstallCore(
        { connect: (serverId) => this.deps.pool.acquire(serverId) },
        {
          serverId: input.serverId,
          sudoPassword: input.sudoPassword,
          keepData: input.keepData,
          onProgress: (progress) => this.deps.progress({ serverId: input.serverId, progress }),
        },
      );
      await this.deps.state.remove(input.serverId);
      this.sessions.forget(input.serverId);
      this.links.reset(input.serverId);
      this.deps.serversChanged?.();
    });
  }

  /** The core release this build installs, or null when it has none (E15's checklist compares). */
  availableCoreVersion(): Promise<string | null> {
    return this.deps.availableVersion();
  }

  /** How the app signs in to the server over SSH; null for the DevHost, which has no SSH. */
  async loginMethod(serverId: string): Promise<SshAuthMethod | null> {
    if (this.isDevHost(serverId)) return null;
    return (await this.saved(serverId)).authMethod;
  }

  /**
   * Restores a backup onto the server's core over SSH as root (E15), then enrolls this computer
   * as the backup's Owner and signs in. Works on a core nobody can sign in to, and on a new server
   * once the core is installed there. The core restarts, so the lasting connection starts over.
   */
  async restore(
    request: Omit<DeployRestoreInput, 'fileToken'> & { file: string; fileOnServer?: boolean },
    onProgress: (progress: DeployRestoreProgress) => void,
  ): Promise<DeployRestoreResult> {
    this.refuseDevHost(request.serverId);
    return this.exclusive(request.serverId, async () => {
      const record = await this.deps.state.get(request.serverId);
      if (!record) throw new Error(NOT_INSTALLED);
      let restored: RestoredCore;
      try {
        restored = await restoreCore(
          {
            connect: (serverId) => this.deps.pool.acquire(serverId),
            health: (connection) =>
              this.healthOf(
                record.transport === 'bridge'
                  ? bridgeTransport(connection)
                  : streamLocalTransport(connection),
              ),
          },
          {
            ...request,
            deviceName: (this.deps.deviceName ?? hostname)().slice(0, 100),
            onProgress,
          },
        );
      } finally {
        this.links.reset(request.serverId);
      }
      await this.deps.state.setDevice(request.serverId, {
        deviceId: restored.enrollment.deviceId,
        userName: restored.enrollment.userName,
        privateKey: await this.deps.seal(restored.enrollment.privateKeyPem),
      });
      this.sessions.forget(request.serverId);
      const title = 'Sign in';
      onProgress({ phase: 'sign-in', title, status: 'running' });
      let signInError: string | undefined;
      try {
        await this.sessions.signIn(request.serverId, { password: request.password });
        onProgress({ phase: 'sign-in', title, status: 'done' });
      } catch (error) {
        if (coreErrorCode(error) === 'totpRequired') {
          onProgress({
            phase: 'sign-in',
            title,
            status: 'done',
            detail:
              'Enter a code from your authenticator app on the server card to finish signing in.',
          });
        } else {
          signInError = coreErrorMessage(error);
          onProgress({ phase: 'sign-in', title, status: 'failed', detail: signInError });
        }
      }
      this.links.reset(request.serverId);
      this.deps.serversChanged?.();
      return {
        backupCoreVersion: restored.backup.coreVersion,
        backupHostName: restored.backup.hostName,
        backupCreatedAtUnixMs: restored.backup.createdAtUnixMs,
        previousStateFolder: restored.previousStateFolder,
        ...(signInError === undefined ? {} : { signInError }),
      };
    });
  }

  /**
   * The Deploy page asks this every 30 seconds per server, so it goes the way the link does:
   * through direct TLS when that is on and answering, which leaves the SSH login idle and the pool
   * closes it after a minute. Over SSH only when direct TLS is off or did not answer lately.
   */
  async health(serverId: string): Promise<DeployHealth> {
    let answer: HealthResponse;
    let transport: DeployTransport;
    const direct = await this.directHealth(serverId);
    if (direct) {
      answer = direct;
      transport = 'direct-tls';
    } else if (serverId === DEV_SERVER_ID && this.deps.devCorePort !== null) {
      answer = await this.healthOf(devTcpTransport(this.deps.devCorePort));
      transport = 'dev-tcp';
    } else {
      const record = await this.deps.state.get(serverId);
      if (!record) throw new Error('The server core is not installed on this server yet.');
      transport = record.transport;
      answer = await this.withLease(serverId, async (lease) => {
        if (record.transport === 'bridge') return this.healthOf(bridgeTransport(lease.connection));
        try {
          return await this.healthOf(streamLocalTransport(lease.connection));
        } catch (error) {
          // sshd stopped allowing the tunnel since the install; the bridge still gets in.
          if (!(error instanceof TunnelRefusedError)) throw error;
          const bridged = await this.healthOf(bridgeTransport(lease.connection));
          await this.deps.state.set(serverId, { ...record, transport: 'bridge' });
          transport = 'bridge';
          return bridged;
        }
      });
    }
    return {
      version: answer.version,
      apiVersion: answer.apiVersion,
      startedAtUnixMs: answer.startedAtUnixMs,
      checkedAt: this.now(),
      transport,
    };
  }

  /**
   * The core's health over direct TLS, or null when SSH should ask instead. Same rules as the
   * link: a pin mismatch is thrown, a port that does not answer is left alone for a while.
   */
  private async directHealth(serverId: string): Promise<HealthResponse | null> {
    const direct = await this.directRoute(serverId, { probe: false });
    if (!direct) return null;
    try {
      const answer = await this.healthOf(direct);
      this.directUp.set(serverId, this.now() + DIRECT_UP_MS);
      return answer;
    } catch (error) {
      if (error instanceof PinMismatchError) throw new Error(error.message);
      if (!this.worthSsh(error)) throw error;
      this.directDown.set(serverId, this.now() + DIRECT_DOWN_MS);
      return null;
    }
  }

  /**
   * Creates the owner (on a new core), enrolls a fresh device key over SSH as root, seals the
   * private half and signs in with it. Reports its steps the way an install does.
   */
  private async setUpAccess(
    serverId: string,
    sudoPassword: string | null,
    account: DeployAccountInput,
  ): Promise<void> {
    const emit = (progress: DeploySetupProgress) => this.deps.progress({ serverId, progress });
    const deviceName = (this.deps.deviceName ?? hostname)().slice(0, 100);
    const enrollment = await this.withLease(serverId, async (lease) => {
      const shell = await openRootShell(
        lease.connection,
        sudoPassword ?? lease.connection.endpoint.password ?? null,
      );
      return enrollOverSsh(shell, { ...account, deviceName }, emit);
    });
    await this.deps.state.setDevice(serverId, {
      deviceId: enrollment.deviceId,
      userName: enrollment.userName,
      privateKey: await this.deps.seal(enrollment.privateKeyPem),
    });
    this.sessions.forget(serverId);

    const title = 'Sign in';
    emit({ phase: 'sign-in', title, status: 'running' });
    try {
      await this.sessions.signIn(serverId, { password: account.password });
      emit({ phase: 'sign-in', title, status: 'done' });
    } catch (error) {
      if (coreErrorCode(error) === 'totpRequired') {
        emit({
          phase: 'sign-in',
          title,
          status: 'done',
          detail:
            'Enter a code from your authenticator app on the server card to finish signing in.',
        });
        return;
      }
      emit({ phase: 'sign-in', title, status: 'failed', detail: coreErrorMessage(error) });
      throw error;
    }
  }

  /** The DevHost has no SSH, so a development build enrolls with it through its loopback endpoint. */
  private async ensureDevDevice(): Promise<void> {
    const port = this.deps.devCorePort;
    if (port === null || (await this.deps.state.device(DEV_SERVER_ID))) return;
    const key = createDeviceKey();
    const enrolled = await this.rest(devTcpTransport(port)).post<{
      deviceId: string;
      userName: string;
    }>('/dev/enroll', {
      publicKey: key.publicKey,
      deviceName: (this.deps.deviceName ?? hostname)().slice(0, 100),
    });
    await this.deps.state.setDevice(DEV_SERVER_ID, {
      deviceId: enrolled.deviceId,
      userName: enrolled.userName,
      privateKey: await this.deps.seal(key.privateKeyPem),
    });
    this.deps.serversChanged?.();
  }

  /**
   * A core this computer did not install. The preflight (as the login user, no sudo) says whether
   * one runs there and whether sshd allows the tunnel, and the core's health settles the transport,
   * as after an install. Only root and the agentmate group may open the core's socket, so a login
   * outside it is told what to ask for instead of meeting a tunnel error.
   */
  private async adoptCore(serverId: string): Promise<DeployCoreRecord> {
    const report = await this.withLease(serverId, (lease) => runPreflight(lease.connection));
    const installed = report.installed;
    if (!installed) throw new Error('The server core is not installed on this server yet.');
    if (report.sudo !== 'root') {
      const access = await this.withLease(serverId, (lease) => coreGroupAccess(lease.connection));
      if (access === 'missing') throw new Error(coreGroupProblem(report.loginUser));
      // In the group since this login started: a fresh login picks it up.
      if (access === 'new-login') this.deps.pool.reset(serverId);
    }
    const reached = await this.withLease(serverId, async (lease) => {
      if (report.streamLocal !== 'prohibited') {
        try {
          const health = await this.healthOf(streamLocalTransport(lease.connection));
          return { health, transport: 'streamlocal' as const };
        } catch (error) {
          if (!(error instanceof TunnelRefusedError)) throw error;
        }
      }
      return {
        health: await this.healthOf(bridgeTransport(lease.connection)),
        transport: 'bridge' as const,
      };
    });
    return {
      version: reached.health.version,
      release: installed.release,
      transport: reached.transport,
      installedAt: this.now(),
      os: report.os.name,
      architecture: report.architecture.machine,
    };
  }

  /**
   * The transport the core is reached through, for the length of `work`: the remembered one, or
   * `known` for a core not remembered yet.
   */
  private async withTransport<T>(
    serverId: string,
    work: (transport: CoreTransport) => Promise<T>,
    known?: DeployCoreRecord,
    options: { sshOnly?: boolean } = {},
  ): Promise<T> {
    if (!known && !options.sshOnly) {
      const direct = await this.directRoute(serverId, { probe: true });
      if (direct) return work(direct);
    }
    if (this.isDevHost(serverId) && this.deps.devCorePort !== null) {
      return work(devTcpTransport(this.deps.devCorePort));
    }
    const record = known ?? (await this.deps.state.get(serverId));
    if (!record) throw new Error('The server core is not installed on this server yet.');
    return this.withLease(serverId, (lease) =>
      work(
        record.transport === 'bridge'
          ? bridgeTransport(lease.connection)
          : streamLocalTransport(lease.connection),
      ),
    );
  }

  /**
   * A hub call: on the server's lasting connection when it is up, otherwise on a short-lived one
   * signed in with this computer's session. The Security area (security.ts) makes its calls
   * through it too.
   */
  withHub<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    if (this.links.isOnline(serverId)) {
      return this.links.call(serverId, work).catch((error: unknown) => {
        throw new Error(hubMessage(error));
      });
    }
    return this.withTransport(serverId, async (transport) => {
      const session = await this.openHub(serverId, transport);
      try {
        return await work(session.hub);
      } catch (error) {
        throw new Error(hubMessage(error));
      } finally {
        await session.stop().catch(() => undefined);
      }
    });
  }

  /**
   * A hub call that only ever goes over SSH (on the DevHost, its loopback port): what the app
   * learns the direct TLS pin through, so a pin never comes from the connection it protects.
   */
  withSshHub<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    const link = this.links.info(serverId);
    const overSsh = link.transport !== undefined && link.transport !== 'direct-tls';
    if (this.links.isOnline(serverId) && overSsh) {
      return this.links.call(serverId, work).catch((error: unknown) => {
        throw new Error(hubMessage(error));
      });
    }
    return this.withTransport(
      serverId,
      async (transport) => {
        const session = await this.openHub(serverId, transport);
        try {
          return await work(session.hub);
        } catch (error) {
          throw new Error(hubMessage(error));
        } finally {
          await session.stop().catch(() => undefined);
        }
      },
      undefined,
      { sshOnly: true },
    );
  }

  /** The address direct TLS connects to: the saved server's host (loopback for the DevHost). */
  async directTlsHost(serverId: string): Promise<string> {
    return this.isDevHost(serverId) ? '127.0.0.1' : (await this.saved(serverId)).host;
  }

  /** Forgets whether direct TLS answered lately and opens the link again, after a change to it. */
  directTlsChanged(serverId: string): void {
    this.directDown.delete(serverId);
    this.directUp.delete(serverId);
    this.links.reset(serverId);
  }

  /**
   * Runs `work` with `$SSH_CONNECTION` as the server prints it on the pooled SSH connection, the
   * one the server's lasting link rides on, and holds that connection for as long as `work`
   * runs so the link's calls go over it. The DevHost has no SSH, so it gets undefined.
   */
  async onLinkConnection<T>(
    serverId: string,
    work: (sshConnection: string | undefined) => Promise<T>,
  ): Promise<T> {
    if (this.isDevHost(serverId)) return work(undefined);
    return this.withLease(serverId, async (lease) => {
      const printed = await lease.connection.exec('echo "$SSH_CONNECTION"');
      const value = printed.stdout.trim();
      return work(value.length > 0 ? value : undefined);
    });
  }

  /**
   * A hub call over a brand-new SSH connection and a new tunnel through it, both closed after:
   * what proves a new login still gets in after a firewall change. On the DevHost a new TCP
   * connection stands for a new SSH connection. `step` hears when the sign-in starts.
   */
  async withFreshHub<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    step: (step: 'signingIn') => void = () => undefined,
  ): Promise<T> {
    let signingIn = false;
    const run = async (transport: CoreTransport): Promise<T> => {
      // Said once, even when the tunnel is refused and the bridge is tried next.
      if (!signingIn) step('signingIn');
      signingIn = true;
      const session = await this.openHub(serverId, transport, { tunnelRefusal: 'throw' });
      try {
        return await work(session.hub);
      } finally {
        await session.stop().catch(() => undefined);
      }
    };
    if (this.isDevHost(serverId)) return run(devTcpTransport(this.deps.devCorePort as number));
    const record = await this.deps.state.get(serverId);
    if (!record) throw new Error('The server core is not installed on this server yet.');
    const pool = this.deps.pool;
    if (!pool.openSeparate) throw new Error('This build cannot open a second SSH connection.');
    // Called on the pool itself: the real one reads its own fields.
    const lease = await pool.openSeparate(serverId);
    try {
      if (record.transport === 'bridge') return await run(bridgeTransport(lease.connection));
      try {
        return await run(streamLocalTransport(lease.connection));
      } catch (error) {
        if (!(error instanceof TunnelRefusedError)) throw error;
        return await run(bridgeTransport(lease.connection));
      }
    } finally {
      lease.release();
    }
  }

  /**
   * A REST call signed in with this computer's session, for what is too large for a hub message:
   * the Apps' compose files and build contexts (E07).
   */
  async withCoreHttp<T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.sessions.accessToken(serverId);
    return this.withTransport(serverId, (transport) => work(new CoreHttpClient(transport), token));
  }

  /**
   * A refused connection usually means the token outlived its session or device (revoked on the
   * core), which SignalR does not say. Renewing once does: a revoked device or ended session then
   * fails with its code, so the Deploy page can offer the way back.
   */
  private async openHub(
    serverId: string,
    transport: CoreTransport,
    options: { tunnelRefusal?: 'throw' } = {},
  ): Promise<CoreHubSession> {
    const token = () => this.sessions.accessToken(serverId);
    try {
      return await this.hubOf(transport, token);
    } catch (refused) {
      // A caller that falls back to the bridge needs to see the tunnel refusal as it is.
      if (options.tunnelRefusal === 'throw' && refused instanceof TunnelRefusedError) throw refused;
      this.sessions.forget(serverId);
      await token();
      try {
        return await this.hubOf(transport, token);
      } catch {
        throw new Error(hubMessage(refused));
      }
    }
  }

  /**
   * One lasting hub connection for the server's link, over the transport the install settled on,
   * holding an SSH lease for as long as it is open. What cannot be fixed by trying again (no
   * saved server, no core, no device here) is said so the link waits instead.
   */
  private async openLive(serverId: string): Promise<LiveHubSession> {
    if (this.isDevHost(serverId)) {
      await this.ensureDevDevice();
      const direct = await this.startDirectLive(serverId);
      if (direct) return direct;
      return this.startLive(serverId, devTcpTransport(this.deps.devCorePort as number));
    }
    try {
      await this.saved(serverId);
    } catch (error) {
      throw new LinkBlockedError('offline', coreErrorMessage(error));
    }
    const record = await this.deps.state.get(serverId);
    if (!record) throw new LinkBlockedError('offline', NOT_INSTALLED);
    if (!(await this.deps.state.device(serverId))) {
      throw new LinkBlockedError('offline', NOT_ENROLLED);
    }
    const direct = await this.startDirectLive(serverId);
    if (direct) return direct;
    const lease = await this.deps.pool.acquire(serverId);
    try {
      const session = await this.startLiveOver(serverId, record, lease);
      void session.closed.then(() => lease.release());
      return session;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private async startLiveOver(
    serverId: string,
    record: DeployCoreRecord,
    lease: DeployLease,
  ): Promise<LiveHubSession> {
    if (record.transport === 'bridge') {
      return this.startLive(serverId, bridgeTransport(lease.connection));
    }
    try {
      return await this.startLive(serverId, streamLocalTransport(lease.connection));
    } catch (error) {
      // sshd may have stopped allowing the tunnel since the install, and the bridge still gets
      // in. Only for this connection, though: a core that is still starting after a reboot
      // refuses the tunnel too, so changing the record is left to the health check.
      if (!(error instanceof TunnelRefusedError)) throw error;
      return this.startLive(serverId, bridgeTransport(lease.connection));
    }
  }

  /**
   * The link over direct TLS, when it is on for this server and did not fail lately. A pin
   * mismatch stops the link outright; any other failure leaves the port alone for a while and the
   * link goes over SSH as before. Null when SSH is the way.
   */
  private async startDirectLive(serverId: string): Promise<LiveHubSession | null> {
    const direct = await this.directRoute(serverId, { probe: false });
    if (!direct) return null;
    try {
      const session = await this.startLive(serverId, direct);
      this.directUp.set(serverId, this.now() + DIRECT_UP_MS);
      return session;
    } catch (error) {
      if (error instanceof PinMismatchError) throw new LinkBlockedError('offline', error.message);
      if (!this.worthSsh(error)) throw error;
      this.directDown.set(serverId, this.now() + DIRECT_DOWN_MS);
      return null;
    }
  }

  /**
   * The direct TLS transport for a server, or null when SSH is the way: the mode is off on this
   * computer, the port failed lately, or (with `probe`) it does not answer its health now. A pin
   * mismatch is thrown, never turned into a quiet fallback.
   */
  private async directRoute(
    serverId: string,
    options: { probe: boolean },
  ): Promise<CoreTransport | null> {
    const pinned = await this.deps.state.directTls(serverId);
    if (!pinned?.enabled) return null;
    const now = this.now();
    if ((this.directDown.get(serverId) ?? 0) > now) return null;
    const device = await this.deps.state.device(serverId);
    if (!device) return null;
    const host = await this.directTlsHost(serverId);
    const transport = directTlsTransport(
      { host, port: pinned.port, pin: pinned.pin },
      async () => clientCertificate(await this.deps.unseal(device.privateKey)),
      this.deps.tlsConnect,
    );
    if (!options.probe || (this.directUp.get(serverId) ?? 0) > now) return transport;
    try {
      await this.healthOf(transport);
      this.directUp.set(serverId, this.now() + DIRECT_UP_MS);
      return transport;
    } catch (error) {
      if (error instanceof PinMismatchError) throw new Error(error.message);
      if (!this.worthSsh(error)) throw error;
      this.directDown.set(serverId, this.now() + DIRECT_DOWN_MS);
      return null;
    }
  }

  /** Whether SSH may get past a direct TLS failure: not a locked vault or a refusal with a code. */
  private worthSsh(error: unknown): boolean {
    if (error instanceof VaultLockedError || error instanceof LinkBlockedError) return false;
    return coreErrorCode(error) === null;
  }

  private async startLive(serverId: string, transport: CoreTransport): Promise<LiveHubSession> {
    const open = async () => {
      const token = await this.sessions.accessToken(serverId);
      const session = await this.liveHubOf(transport, token, this.sessions.expiresAt(serverId));
      session.transport ??= transport.kind;
      return session;
    };
    try {
      return await open();
    } catch (error) {
      // The core turned the token in hand away: its session or device was revoked there.
      // Renewing says which, with a code the link waits on.
      if (!(error instanceof HubStartError) || error.status !== 401) throw error;
      this.sessions.forget(serverId);
      return open();
    }
  }

  private isDevHost(serverId: string): boolean {
    return serverId === DEV_SERVER_ID && this.deps.devCorePort !== null;
  }

  private devHost(enrolled: boolean): DeployServer | null {
    const port = this.deps.devCorePort;
    if (port === null) return null;
    return {
      id: DEV_SERVER_ID,
      nickname: 'DevHost',
      host: '127.0.0.1',
      port,
      username: 'dev',
      enrolled,
      dev: true,
      core: {
        version: 'dev',
        release: '',
        transport: 'dev-tcp',
        installedAt: 0,
        os: 'DevHost',
        architecture: process.arch,
      },
    };
  }

  private refuseDevHost(serverId: string): void {
    if (serverId === DEV_SERVER_ID && this.deps.devCorePort !== null) {
      throw new Error(
        'The DevHost runs from your checkout, so there is nothing to install or remove.',
      );
    }
  }

  private async saved(serverId: string): Promise<SavedServer> {
    const server = (await this.deps.servers()).find((candidate) => candidate.id === serverId);
    if (!server) throw new Error('This saved server no longer exists.');
    return server;
  }

  private async withLease<T>(
    serverId: string,
    work: (lease: DeployLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.deps.pool.acquire(serverId);
    try {
      return await work(lease);
    } finally {
      lease.release();
    }
  }

  private async exclusive<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(serverId)) {
      throw new Error(
        'The server core on this server is already being changed. Wait for that to finish.',
      );
    }
    this.busy.add(serverId);
    try {
      return await work();
    } finally {
      this.busy.delete(serverId);
    }
  }
}
