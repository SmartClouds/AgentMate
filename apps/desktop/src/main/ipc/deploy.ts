import type { IpcMainInvokeEvent } from 'electron';
import type {
  DeployAccountInput,
  DeployEnrollInput,
  DeployInstallInput,
  DeploySignInInput,
  DeployStepUpInput,
  DeployUninstallInput,
} from '../../shared/deployTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployService } from '../deploy/service';

/**
 * The Deploy section's invoke channels. They answer only the app's main window: browser tabs,
 * webviews and widgets share the preload, and none of them may reach a server's root shell or its
 * core. Every argument is checked here before the service sees it.
 */

export interface DeployIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface DeployHandlerDeps {
  ipc: DeployIpcRegistry;
  service: DeployService;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PASSWORD = 1024;
const MAX_CODE = 16;
const MAX_RECOVERY_CODE = 64;
const MAX_USER_NAME = 64;

export function serverId(value: unknown): string {
  if (typeof value !== 'string' || !SERVER_ID.test(value)) {
    throw new Error('That is not a saved server.');
  }
  return value;
}

export function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`The ${what} must be text.`);
  }
  return value;
}

export function optionalText(value: unknown, max: number, what: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : text(value, max, what);
}

function sudoPassword(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_PASSWORD) {
    throw new Error('The sudo password must be text.');
  }
  return value;
}

export function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`Expected ${what}.`);
  return value as Record<string, unknown>;
}

function account(value: unknown): DeployAccountInput {
  const input = object(value, 'an account');
  return {
    userName: text(input.userName, MAX_USER_NAME, 'user name'),
    password: text(input.password, MAX_PASSWORD, 'password'),
  };
}

function installInput(value: unknown): DeployInstallInput {
  const input = object(value, 'install options');
  return {
    serverId: serverId(input.serverId),
    sudoPassword: sudoPassword(input.sudoPassword),
    ...(input.account === undefined ? {} : { account: account(input.account) }),
  };
}

function uninstallInput(value: unknown): DeployUninstallInput {
  const input = object(value, 'removal options');
  if (typeof input.keepData !== 'boolean') throw new Error('Say whether to keep the data.');
  return {
    serverId: serverId(input.serverId),
    sudoPassword: sudoPassword(input.sudoPassword),
    keepData: input.keepData,
  };
}

function enrollInput(value: unknown): DeployEnrollInput {
  const input = object(value, 'enrollment options');
  if (input.account === undefined) throw new Error('Enrolling needs an account.');
  return {
    serverId: serverId(input.serverId),
    sudoPassword: sudoPassword(input.sudoPassword),
    account: account(input.account),
  };
}

function signInInput(value: unknown): DeploySignInInput {
  const input = object(value, 'sign-in details');
  const totpCode = optionalText(input.totpCode, MAX_CODE, 'authenticator code');
  const recoveryCode = optionalText(input.recoveryCode, MAX_RECOVERY_CODE, 'recovery code');
  return {
    serverId: serverId(input.serverId),
    password: text(input.password, MAX_PASSWORD, 'password'),
    ...(totpCode ? { totpCode } : {}),
    ...(recoveryCode ? { recoveryCode } : {}),
  };
}

export function stepUpInput(value: unknown): DeployStepUpInput {
  const input = object(value, 'step-up details');
  const password = optionalText(input.password, MAX_PASSWORD, 'password');
  const totpCode = optionalText(input.totpCode, MAX_CODE, 'authenticator code');
  return {
    serverId: serverId(input.serverId),
    ...(password ? { password } : {}),
    ...(totpCode ? { totpCode } : {}),
  };
}

export function registerDeployHandlers({ ipc, service, guard }: DeployHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deploy.listServers, () => service.listServers());
  handle(IPC.deploy.preflight, (id) => service.preflight(serverId(id)));
  handle(IPC.deploy.install, (input) => service.install(installInput(input)));
  handle(IPC.deploy.uninstall, (input) => service.uninstall(uninstallInput(input)));
  handle(IPC.deploy.updateCore, (input) => service.updateCore(stepUpInput(input)));
  handle(IPC.deploy.coreRelease, () => service.coreRelease());
  handle(IPC.deploy.health, (id) => service.health(serverId(id)));
  handle(IPC.deploy.access, (id) => service.access(serverId(id)));
  handle(IPC.deploy.enroll, (input) => service.enroll(enrollInput(input)));
  handle(IPC.deploy.signIn, (input) => service.signIn(signInInput(input)));
  handle(IPC.deploy.signOut, (id) => service.signOut(serverId(id)));
  handle(IPC.deploy.account, (id) => service.account(serverId(id)));
  handle(IPC.deploy.stepUp, (input) => service.stepUp(stepUpInput(input)));
  handle(IPC.deploy.stepUpSaved, (id) => service.stepUpWithSavedPassword(serverId(id)));
  handle(IPC.deploy.rememberPassword, (input) => service.rememberPassword(stepUpInput(input)));
  handle(IPC.deploy.forgetPassword, (id) => service.forgetPassword(serverId(id)));
  handle(IPC.deploy.beginTotp, (id) => service.beginTotp(serverId(id)));
  handle(IPC.deploy.confirmTotp, (id, code) =>
    service.confirmTotp(serverId(id), text(code, MAX_CODE, 'authenticator code')),
  );
  handle(IPC.deploy.disableTotp, (id, code) =>
    service.disableTotp(serverId(id), text(code, MAX_CODE, 'authenticator code')),
  );
  handle(IPC.deploy.connection, (id) => service.connection(serverId(id)));
  handle(IPC.deploy.reconnect, (id) => service.reconnect(serverId(id)));
}
