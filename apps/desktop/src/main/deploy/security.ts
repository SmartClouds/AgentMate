import type {
  AuditEventInfo,
  AuditPage,
  AuditVerificationInfo,
  DeviceInfo,
  EnrollmentCodeInfo,
  SessionInfo,
  UserInfo,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployAuditExportFormat,
  DeployAuditExportInput,
  DeployAuditExportResult,
  DeployAuditFilter,
  DeployAuditQueryInput,
  DeployCreateUserInput,
  DeployEnrollmentCodeInput,
  DeployResetPasswordInput,
  DeploySetDisabledInput,
  DeploySetRoleInput,
  DeployUserTarget,
} from '../../shared/deploySecurityTypes';
import { auditCsv, auditJson } from './auditExport';

/**
 * The Security area of a server's core: users and roles (an Owner's), devices and sessions,
 * enrollment codes and the audit trail. Every call is one short hub connection signed in with this
 * computer's session, and the core decides what the caller may do; the app only leaves out what
 * a role could never use. Passwords go straight through to the core and are not kept. After
 * anything that may have ended this computer's own session or changed its role, the next access
 * check renews with the core instead of trusting what this run remembers.
 */

/** The most events one export holds: the newest, when more match. */
export const MAX_EXPORT_EVENTS = 50_000;
/** The core's largest page. */
const EXPORT_PAGE = 200;

export interface DeploySecurityDeps {
  /** A short-lived hub connection with this computer's session (DeployService.withHub). */
  withHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
  /** Drops this run's access token, so the next access check asks the core again. */
  forgetTokens: (serverId: string) => void;
  /** The server's name as the user knows it, for the export's file name. */
  serverName: (serverId: string) => Promise<string>;
  /** The save dialog; null when it was cancelled. */
  pickExportPath: (
    format: DeployAuditExportFormat,
    suggestedName: string,
  ) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  now?: () => number;
}

/** The same object without its undefined fields, so the core sees only what was asked for. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

/** A file name part from anything a user may call a server. */
function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

export class DeploySecurity {
  private readonly now: () => number;

  constructor(private readonly deps: DeploySecurityDeps) {
    this.now = deps.now ?? Date.now;
  }

  listUsers(serverId: string): Promise<UserInfo[]> {
    return this.deps.withHub(serverId, (hub) => hub.listUsers());
  }

  createUser(input: DeployCreateUserInput): Promise<UserInfo> {
    return this.deps.withHub(input.serverId, (hub) =>
      hub.createUser({ userName: input.userName, password: input.password, role: input.role }),
    );
  }

  async setUserRole(input: DeploySetRoleInput): Promise<UserInfo> {
    const user = await this.deps.withHub(input.serverId, (hub) =>
      hub.setUserRole(input.userId, input.role),
    );
    // It may have been the signed-in user's own role.
    this.deps.forgetTokens(input.serverId);
    return user;
  }

  setUserDisabled(input: DeploySetDisabledInput): Promise<UserInfo> {
    return this.deps.withHub(input.serverId, (hub) =>
      hub.setUserDisabled(input.userId, input.disabled),
    );
  }

  resetUserPassword(input: DeployResetPasswordInput): Promise<void> {
    return this.deps.withHub(input.serverId, (hub) =>
      hub.resetUserPassword({ userId: input.userId, password: input.password }),
    );
  }

  deleteUser(input: DeployUserTarget): Promise<void> {
    return this.deps.withHub(input.serverId, (hub) => hub.deleteUser(input.userId));
  }

  createEnrollmentCode(input: DeployEnrollmentCodeInput): Promise<EnrollmentCodeInfo> {
    const { serverId, ...request } = input;
    return this.deps.withHub(serverId, (hub) => hub.createEnrollmentCode(defined(request)));
  }

  listDevices(serverId: string): Promise<DeviceInfo[]> {
    return this.deps.withHub(serverId, (hub) => hub.listDevices());
  }

  async revokeDevice(serverId: string, deviceId: string): Promise<void> {
    await this.deps.withHub(serverId, (hub) => hub.revokeDevice(deviceId));
    this.deps.forgetTokens(serverId);
  }

  listSessions(serverId: string): Promise<SessionInfo[]> {
    return this.deps.withHub(serverId, (hub) => hub.listSessions());
  }

  async revokeSession(serverId: string, sessionId: string): Promise<void> {
    await this.deps.withHub(serverId, (hub) => hub.revokeSession(sessionId));
    this.deps.forgetTokens(serverId);
  }

  revokeOtherSessions(serverId: string): Promise<number> {
    return this.deps.withHub(serverId, (hub) => hub.revokeOtherSessions());
  }

  queryAudit(input: DeployAuditQueryInput): Promise<AuditPage> {
    const { serverId, ...query } = input;
    return this.deps.withHub(serverId, (hub) => hub.queryAudit(defined(query)));
  }

  verifyAudit(serverId: string): Promise<AuditVerificationInfo> {
    return this.deps.withHub(serverId, (hub) => hub.verifyAudit());
  }

  /**
   * Every event that matches, newest first, into a file the user picks. The dialog comes first,
   * so a cancelled export costs the core nothing; the pages then come over one connection.
   */
  async exportAudit(input: DeployAuditExportInput): Promise<DeployAuditExportResult> {
    const exportedAt = this.now();
    const server = await this.deps.serverName(input.serverId);
    const stamp = new Date(exportedAt).toISOString().slice(0, 10);
    const path = await this.deps.pickExportPath(
      input.format,
      `runova-audit-${fileSafe(server)}-${stamp}.${input.format}`,
    );
    if (!path) return { saved: false };

    const filter = defined(input.filter);
    const { events, truncated } = await this.deps.withHub(input.serverId, (hub) =>
      this.collect(hub, filter),
    );
    await this.deps.writeFile(
      path,
      input.format === 'csv'
        ? auditCsv(events)
        : auditJson(events, { server, exportedAtUnixMs: exportedAt, filter, truncated }),
    );
    return { saved: true, path, count: events.length, truncated };
  }

  private async collect(
    hub: ICoreHub,
    filter: Partial<DeployAuditFilter>,
  ): Promise<{ events: AuditEventInfo[]; truncated: boolean }> {
    const events: AuditEventInfo[] = [];
    let beforeId: number | undefined;
    while (events.length < MAX_EXPORT_EVENTS) {
      const page = await hub.queryAudit({
        ...filter,
        limit: EXPORT_PAGE,
        ...(beforeId === undefined ? {} : { beforeId }),
      });
      events.push(...page.events);
      if (page.nextBeforeId === undefined || page.events.length === 0) {
        return { events, truncated: false };
      }
      beforeId = page.nextBeforeId;
    }
    return { events: events.slice(0, MAX_EXPORT_EVENTS), truncated: true };
  }
}
