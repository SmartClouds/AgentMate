import type {
  ErrorReportingRequest,
  ErrorReportingTestResult,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import {
  checkEnvironment,
  checkServerName,
  parseSentryDsn,
} from '../../../shared/deploy/errorReportingValidation';
import type {
  DeployErrorReportingProof,
  DeployErrorReportingRemoveInput,
  DeployErrorReportingSaveInput,
  DeployErrorReportingSaveResult,
  DeployErrorReportingStatus,
} from '../../../shared/deployErrorReportingTypes';
import { type CoreCallDeps, callCore } from '../coreCalls';

/**
 * Error reporting on a server (E29): the core sends its warnings and errors to a Sentry project as
 * OpenTelemetry logs, and these calls read how that stands, set it up, remove it and send a test
 * event. Setting up and removing send the core's logs to a third party, so they are an Owner's call
 * with a step-up; the call makes the step-up on the way when it is handed the password or a code.
 * The DSN only goes in. The core seals it and never returns it, so nothing here can hand one back.
 */

/** Who may step up for the calls that change the setup. */
const OWNER_ROLES: ReadonlySet<string> = new Set(['owner']);

/** What a core without this feature answers to an unknown hub method. */
const MISSING_METHOD = /Method does not exist/i;

async function stepUp(hub: ICoreHub, proof: DeployErrorReportingProof): Promise<void> {
  if (proof.password || proof.totpCode) {
    await hub.stepUp({
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
    });
  }
}

export class DeployErrorReporting {
  constructor(private readonly deps: CoreCallDeps) {}

  status(serverId: string): Promise<DeployErrorReportingStatus> {
    return this.call(serverId, (hub) => hub.getErrorReporting());
  }

  async save(input: DeployErrorReportingSaveInput): Promise<DeployErrorReportingSaveResult> {
    const request = this.request(input);
    const result = await this.call(
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.saveErrorReporting(request);
      },
      OWNER_ROLES,
    );
    return { problems: result.problems, status: result.status ?? null };
  }

  remove(input: DeployErrorReportingRemoveInput): Promise<DeployErrorReportingStatus> {
    return this.call(
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.removeErrorReporting();
      },
      OWNER_ROLES,
    );
  }

  test(serverId: string): Promise<ErrorReportingTestResult> {
    return this.call(serverId, (hub) => hub.sendErrorReportingTest());
  }

  /** The request the core takes, after the same checks the form made. The core checks again. */
  private request(input: DeployErrorReportingSaveInput): ErrorReportingRequest {
    const dsn = input.dsn?.trim();
    if (dsn) {
      const parsed = parseSentryDsn(dsn);
      if (!parsed.ok) throw new Error(parsed.reason);
    }
    const environment = checkEnvironment(input.environment);
    if (!environment.ok) throw new Error(environment.reason);
    const serverName = checkServerName(input.serverName);
    if (!serverName.ok) throw new Error(serverName.reason);
    return {
      ...(dsn ? { dsn } : {}),
      enabled: input.enabled,
      environment: environment.value,
      serverName: serverName.value,
      minLevel: input.level,
    };
  }

  private async call<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    stepUpFor?: ReadonlySet<string>,
  ): Promise<T> {
    try {
      return await callCore(this.deps, serverId, work, stepUpFor ? { stepUpFor } : {});
    } catch (error) {
      if (error instanceof Error && MISSING_METHOD.test(error.message)) {
        throw new Error(
          'This server runs an older core without error reporting. Update the core from the Overview, then try again.',
        );
      }
      throw error;
    }
  }
}
