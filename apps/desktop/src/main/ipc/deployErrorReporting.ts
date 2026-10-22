import type { IpcMainInvokeEvent } from 'electron';
import {
  checkEnvironment,
  checkServerName,
  ERROR_REPORTING_LEVELS,
  type ErrorReportingLevel,
  parseSentryDsn,
} from '../../shared/deploy/errorReportingValidation';
import type {
  DeployErrorReportingRemoveInput,
  DeployErrorReportingSaveInput,
} from '../../shared/deployErrorReportingTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployErrorReporting } from '../deploy/errorReporting/service';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';

/**
 * Error reporting channels (E29): how it stands, setting it up, removing it and a test event. Main
 * window only, every argument checked here; the core checks them again and decides who may change
 * them. The DSN is checked for its shape and never repeated in a message: the key stays in the form.
 */

export interface DeployErrorReportingHandlerDeps {
  ipc: DeployIpcRegistry;
  errorReporting: Pick<DeployErrorReporting, 'status' | 'save' | 'remove' | 'test'>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

function level(value: unknown): ErrorReportingLevel {
  const known = ERROR_REPORTING_LEVELS.find((item) => item.value === value);
  if (!known) throw new Error('Pick Warnings and errors, or Errors only.');
  return known.value;
}

/** Empty or missing means "keep the DSN the core already has". */
function optionalDsn(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('The DSN must be text.');
  const dsn = value.trim();
  if (dsn.length === 0) return undefined;
  const parsed = parseSentryDsn(dsn);
  if (!parsed.ok) throw new Error(parsed.reason);
  return dsn;
}

export function saveInput(value: unknown): DeployErrorReportingSaveInput {
  const input = object(value, 'the error reporting settings');
  const proof = stepUpInput(value);
  if (typeof input.enabled !== 'boolean') {
    throw new Error('Say whether error reporting is on or paused.');
  }
  if (typeof input.environment !== 'string') throw new Error('Environment must be text.');
  const environment = checkEnvironment(input.environment);
  if (!environment.ok) throw new Error(environment.reason);
  if (typeof input.serverName !== 'string') throw new Error('Server name must be text.');
  const serverName = checkServerName(input.serverName);
  if (!serverName.ok) throw new Error(serverName.reason);
  const dsn = optionalDsn(input.dsn);
  return {
    ...proof,
    ...(dsn ? { dsn } : {}),
    enabled: input.enabled,
    environment: environment.value,
    serverName: serverName.value,
    level: level(input.level),
  };
}

function removeInput(value: unknown): DeployErrorReportingRemoveInput {
  return stepUpInput(value);
}

export function registerDeployErrorReportingHandlers(deps: DeployErrorReportingHandlerDeps): void {
  const { ipc, errorReporting } = deps;
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deployErrorReporting.status, (id) => errorReporting.status(serverId(id)));
  handle(IPC.deployErrorReporting.save, (value) => errorReporting.save(saveInput(value)));
  handle(IPC.deployErrorReporting.remove, (value) => errorReporting.remove(removeInput(value)));
  handle(IPC.deployErrorReporting.test, (id) => errorReporting.test(serverId(id)));
}
