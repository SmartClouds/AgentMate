import type { IpcMainInvokeEvent } from 'electron';
import type { StackAction } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployStackCreateInput,
  DeployStackPreviewInput,
  DeployStackRevisionInput,
  DeployStackSourceInput,
} from '../../shared/deployStacksTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployStacks } from '../deploy/stacks/service';
import { type DeployIpcRegistry, object, serverId } from './deploy';

/**
 * The Apps' invoke channels (E07). Like the rest of Deploy they answer only the main window and
 * check every argument here; the core checks them all again. Env values never travel on these
 * channels in either direction: the main process reads the environment itself.
 */

export interface DeployStacksHandlerDeps {
  ipc: DeployIpcRegistry;
  stacks: DeployStacks;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids as the app's own records make them (projects, environments). */
const RECORD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SERVICE_NAME = /^[a-zA-Z0-9._-]{1,128}$/;
const ACTIONS: ReadonlySet<string> = new Set<StackAction>(['start', 'stop', 'restart', 'down']);
/** The core's own caps: 500 acknowledged findings, ids well under 300 characters. */
const MAX_RISKS = 500;
const MAX_RISK_ID = 300;
const MAX_SERVICES = 200;
/** Far more files than an environment ever holds. */
const MAX_ENV_FILES = 100;
const MAX_PATH = 1024;
const MAX_NAME = 63;

function stackId(value: unknown): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error('That is not an app.');
  return value;
}

function recordId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !RECORD_ID.test(value)) throw new Error(`That is not ${what}.`);
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('A revision is a whole number from 1.');
  }
  return value as number;
}

function strings(value: unknown, what: string, max: number, valid: (item: string) => boolean) {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`Send ${what} as a list of at most ${max}.`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !valid(item))
      throw new Error(`One of the ${what} is not valid.`);
  }
  return value as string[];
}

const riskIds = (value: unknown) =>
  strings(value, 'risk ids', MAX_RISKS, (item) => item.length > 0 && item.length <= MAX_RISK_ID);

const serviceNames = (value: unknown) =>
  strings(value, 'services', MAX_SERVICES, (item) => SERVICE_NAME.test(item));

function source(input: Record<string, unknown>): DeployStackSourceInput {
  const { composePath, environmentId, envFileIds } = input;
  if (
    typeof composePath !== 'string' ||
    composePath.length === 0 ||
    composePath.length > MAX_PATH
  ) {
    throw new Error('Pick a compose file.');
  }
  const environment =
    environmentId === null || environmentId === undefined
      ? null
      : recordId(environmentId, 'an environment');
  // Picked files only mean something with an environment; left out, every file applies.
  const files =
    environment === null || envFileIds === null || envFileIds === undefined
      ? null
      : [...new Set(strings(envFileIds, 'env files', MAX_ENV_FILES, (id) => RECORD_ID.test(id)))];
  return {
    projectId: recordId(input.projectId, 'a project'),
    composePath,
    environmentId: environment,
    ...(files ? { envFileIds: files } : {}),
  };
}

function previewInput(value: unknown): DeployStackPreviewInput {
  const input = object(value, 'a preview request');
  return {
    ...source(input),
    ...(input.proxiedServices === undefined || input.proxiedServices === null
      ? {}
      : { proxiedServices: serviceNames(input.proxiedServices) }),
    ...(input.selinuxEnforcing === true ? { selinuxEnforcing: true } : {}),
  };
}

function createInput(value: unknown): DeployStackCreateInput {
  const input = object(value, 'a new app');
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > MAX_NAME) {
    throw new Error(`Give the app a name of at most ${MAX_NAME} characters.`);
  }
  return {
    ...source(input),
    serverId: serverId(input.serverId),
    name: input.name,
    proxiedServices: serviceNames(input.proxiedServices),
    acknowledgedRisks: riskIds(input.acknowledgedRisks),
  };
}

function revisionInput(value: unknown): DeployStackRevisionInput {
  const input = object(value, 'a new revision');
  return {
    ...source(input),
    serverId: serverId(input.serverId),
    stackId: stackId(input.stackId),
    proxiedServices: serviceNames(input.proxiedServices),
    acknowledgedRisks: riskIds(input.acknowledgedRisks),
  };
}

function ref(value: unknown): { serverId: string; stackId: string } {
  const input = object(value, 'an app');
  return { serverId: serverId(input.serverId), stackId: stackId(input.stackId) };
}

function revisionRef(value: unknown): { serverId: string; stackId: string; revision: number } {
  const input = object(value, 'a revision');
  return { ...ref(input), revision: revision(input.revision) };
}

export function registerDeployStacksHandlers(deps: DeployStacksHandlerDeps): void {
  const { ipc, stacks } = deps;
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deployStacks.discover, (id) => stacks.discover(recordId(id, 'a project')));
  handle(IPC.deployStacks.preview, (value) => stacks.preview(previewInput(value)));
  handle(IPC.deployStacks.list, (id) => stacks.list(serverId(id)));
  handle(IPC.deployStacks.get, (value) => {
    const { serverId: server, stackId: stack } = ref(value);
    return stacks.get(server, stack);
  });
  handle(IPC.deployStacks.files, (value) => {
    const input = revisionRef(value);
    return stacks.files(input.serverId, input.stackId, input.revision);
  });
  handle(IPC.deployStacks.create, (value) => stacks.create(createInput(value)));
  handle(IPC.deployStacks.upload, (value) => stacks.upload(revisionInput(value)));
  handle(IPC.deployStacks.acknowledge, (value) => {
    const input = revisionRef(value);
    const ids = riskIds(object(value, 'an acknowledgment').riskIds);
    return stacks.acknowledge(input.serverId, input.stackId, input.revision, ids);
  });
  handle(IPC.deployStacks.deploy, (value) => {
    const input = revisionRef(value);
    return stacks.deploy(input.serverId, input.stackId, input.revision);
  });
  handle(IPC.deployStacks.rollback, (value) => {
    const input = revisionRef(value);
    return stacks.rollback(input.serverId, input.stackId, input.revision);
  });
  handle(IPC.deployStacks.action, (value) => {
    const input = ref(value);
    const { action } = object(value, 'an action');
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      throw new Error('An app can be started, stopped, restarted or taken down.');
    }
    return stacks.action(input.serverId, input.stackId, action as StackAction);
  });
  handle(IPC.deployStacks.delete, (value) => {
    const input = ref(value);
    const { removeVolumes } = object(value, 'a deletion');
    if (typeof removeVolumes !== 'boolean') {
      throw new Error("Say whether the app's volumes go too.");
    }
    return stacks.delete(input.serverId, input.stackId, removeVolumes);
  });
  handle(IPC.deployStacks.makePrivate, (value) => {
    const input = ref(value);
    const services = serviceNames(object(value, 'the services to make private').services);
    if (services.length === 0) throw new Error('Name a service to make private.');
    return stacks.makePrivate({ ...input, services });
  });
}
