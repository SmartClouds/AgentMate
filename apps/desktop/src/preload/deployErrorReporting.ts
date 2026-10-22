import { ipcRenderer } from 'electron';
import type {
  DeployErrorReportingRemoveInput,
  DeployErrorReportingSaveInput,
  DeployErrorReportingSaveResult,
  DeployErrorReportingStatus,
  DeployErrorReportingTestResult,
} from '../shared/deployErrorReportingTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * Error reporting (E29), for the server's Security section. The DSN only goes in; nothing here
 * returns one. Changing or removing it needs an Owner and may need a step-up
 * (`[core:stepUpRequired]`): pass the password or a code, as Direct TLS does.
 */
export function createDeployErrorReporting() {
  return {
    status: (serverId: string): Promise<DeployErrorReportingStatus> =>
      ipcRenderer.invoke(IPC.deployErrorReporting.status, serverId),
    save: (input: DeployErrorReportingSaveInput): Promise<DeployErrorReportingSaveResult> =>
      ipcRenderer.invoke(IPC.deployErrorReporting.save, input),
    remove: (input: DeployErrorReportingRemoveInput): Promise<DeployErrorReportingStatus> =>
      ipcRenderer.invoke(IPC.deployErrorReporting.remove, input),
    test: (serverId: string): Promise<DeployErrorReportingTestResult> =>
      ipcRenderer.invoke(IPC.deployErrorReporting.test, serverId),
  };
}
