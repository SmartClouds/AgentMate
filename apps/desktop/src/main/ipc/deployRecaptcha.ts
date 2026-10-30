import type { IpcMainInvokeEvent } from 'electron';
import type {
  RecaptchaChallenge,
  RecaptchaKeyInput,
  RecaptchaKeyRef,
  RecaptchaKeyType,
  RecaptchaKeyUpdate,
  RecaptchaProjectRef,
  RecaptchaSignInInput,
} from '../../shared/deployRecaptchaTypes';
import { IPC } from '../../shared/ipcChannels';
import { validateDomains } from '../../shared/recaptcha/domains';
import type { RecaptchaService } from '../deploy/recaptcha/service';

/**
 * The reCAPTCHA page's invoke channels (E40). Like the rest of Deploy they answer only the app's
 * main window, since browser tabs and webviews share the preload. Every argument is checked here,
 * domains with the same rules the page uses as the user types, before the service sees it.
 */

export interface DeployRecaptchaIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface DeployRecaptchaHandlerDeps {
  ipc: DeployRecaptchaIpcRegistry;
  service: RecaptchaService;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const ACCOUNT_ID = /^[A-Za-z0-9-]{1,128}$/;
/** Google project ids, including the old domain-scoped kind (`example.com:project`). */
const PROJECT_ID = /^([a-z0-9.-]{1,63}:)?[a-z][a-z0-9-]{4,29}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_CLIENT = 1024;
const MAX_NAME = 100;
const TYPES: ReadonlySet<string> = new Set<RecaptchaKeyType>(['score', 'checkbox', 'invisible']);
const CHALLENGES: ReadonlySet<string> = new Set<RecaptchaChallenge>([
  'usability',
  'balance',
  'security',
]);

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${what}.`);
  }
  return value as Record<string, unknown>;
}

function matching(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new Error(`That is not a valid ${what}.`);
  return value;
}

function accountId(value: unknown): string {
  return matching(value, ACCOUNT_ID, 'account id');
}

function projectRef(value: unknown): RecaptchaProjectRef {
  const ref = object(value, 'a project');
  return {
    accountId: accountId(ref.accountId),
    projectId: matching(ref.projectId, PROJECT_ID, 'Google Cloud project id'),
  };
}

function keyRef(value: unknown): RecaptchaKeyRef {
  return { ...projectRef(value), keyId: matching(object(value, 'a key').keyId, KEY_ID, 'key id') };
}

function clientText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > MAX_CLIENT || /[\r\n]/.test(value)) {
    throw new Error(`The ${what} must be one line of text.`);
  }
  return value.trim();
}

function signInInput(value: unknown): RecaptchaSignInInput {
  const input = object(value, 'a sign-in');
  if (input.mode === 'runova') return { mode: 'runova' };
  if (input.mode !== 'own') throw new Error('Choose how to sign in to Google.');
  const clientId = clientText(input.clientId, 'client ID');
  if (!clientId) throw new Error('Paste the client ID of your OAuth client.');
  const clientSecret =
    input.clientSecret === undefined ? '' : clientText(input.clientSecret, 'client secret');
  return clientSecret ? { mode: 'own', clientId, clientSecret } : { mode: 'own', clientId };
}

function keyType(value: unknown): RecaptchaKeyType {
  if (typeof value !== 'string' || !TYPES.has(value)) throw new Error('Choose a key type.');
  return value as RecaptchaKeyType;
}

function name(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error('Give the key a name.');
  if (text.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME} characters.`);
  return text;
}

function domains(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Expected a list of domains.');
  }
  const problem = validateDomains(value);
  if (problem) throw new Error(problem);
  return value;
}

function challenge(value: unknown): { challenge?: RecaptchaChallenge } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || !CHALLENGES.has(value)) {
    throw new Error('Choose how hard the challenges are.');
  }
  return { challenge: value as RecaptchaChallenge };
}

function keyInput(value: unknown): RecaptchaKeyInput {
  const input = object(value, 'a key');
  return {
    name: name(input.name),
    type: keyType(input.type),
    domains: domains(input.domains),
    ...challenge(input.challenge),
  };
}

function keyUpdate(value: unknown): RecaptchaKeyUpdate {
  const input = object(value, 'a key');
  return { name: name(input.name), domains: domains(input.domains), ...challenge(input.challenge) };
}

export function registerDeployRecaptchaHandlers({
  ipc,
  service,
  guard,
}: DeployRecaptchaHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('reCAPTCHA is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deployRecaptcha.status, () => service.status());
  handle(IPC.deployRecaptcha.signIn, (input) => service.signIn(signInInput(input)));
  handle(IPC.deployRecaptcha.cancelSignIn, () => service.cancelSignIn());
  handle(IPC.deployRecaptcha.removeAccount, (id) => service.removeAccount(accountId(id)));
  handle(IPC.deployRecaptcha.listProjects, (id) => service.projects(accountId(id)));
  handle(IPC.deployRecaptcha.createProject, (id) => service.createProject(accountId(id)));
  handle(IPC.deployRecaptcha.prepareProject, (ref) => service.prepareProject(projectRef(ref)));
  handle(IPC.deployRecaptcha.listKeys, (ref) => service.keys(projectRef(ref)));
  handle(IPC.deployRecaptcha.createKey, (ref, input) =>
    service.createKey(projectRef(ref), keyInput(input)),
  );
  handle(IPC.deployRecaptcha.updateKey, (ref, type, update) =>
    service.updateKey(keyRef(ref), keyType(type), keyUpdate(update)),
  );
  handle(IPC.deployRecaptcha.deleteKey, (ref) => service.deleteKey(keyRef(ref)));
  handle(IPC.deployRecaptcha.secret, (ref) => service.secret(keyRef(ref)));
  handle(IPC.deployRecaptcha.usage, (ref) => service.usage(projectRef(ref)));
}
