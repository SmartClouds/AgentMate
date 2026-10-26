import { randomUUID } from 'node:crypto';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type { RegistryAuth } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  DOCKER_HUB,
  GITHUB_REGISTRY,
  normalizeRegistry,
  registryCredentialProblem,
} from '../../../shared/deploy/registries';
import type {
  DeployGithubCliInput,
  DeployGithubCliStatus,
  DeployGithubTokenCheck,
  DeployGithubTokenInput,
  DeployRegistryCredential,
  DeployRegistryCredentialInput,
  DeployRegistryPlan,
} from '../../../shared/deployRegistryTypes';
import { checkGithubToken, type GhRunner, type GithubFetch, readGhToken } from './github';
import type { RegistryState, StoredRegistryCredential } from './state';

/**
 * Registry sign-ins on this computer (E08 T1, T2, T5) and what each deploy sends. The default
 * for GitHub is a classic token with only read:packages; anything broader, the GitHub CLI's
 * own sign-in included, is saved only after the person accepted a warning that names the extra
 * scopes, since a server that is broken into would hold them for the length of a deploy.
 */

export interface DeployRegistriesDeps {
  state: RegistryState;
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  isLocked: (envelope: SecretEnvelope) => boolean;
  gh: GhRunner;
  fetch?: GithubFetch;
  now?: () => number;
}

export class RegistryLockedError extends Error {}

function broaderWarning(scopes: readonly string[]): string {
  return `This token can do more than pull packages (${scopes.join(', ')}). Accept the warning to save it anyway, or create a token with just read:packages.`;
}

export class DeployRegistries {
  constructor(private readonly deps: DeployRegistriesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async list(): Promise<DeployRegistryCredential[]> {
    const credentials = await this.deps.state.credentials();
    return credentials
      .map(({ envelope, ...rest }) => ({ ...rest, locked: this.deps.isLocked(envelope) }))
      .sort((a, b) => a.registry.localeCompare(b.registry));
  }

  /** What GitHub says the token can do. Nothing is saved. */
  checkGithubToken(token: string): Promise<DeployGithubTokenCheck> {
    return checkGithubToken(token, this.deps.fetch);
  }

  async saveGithubToken(input: DeployGithubTokenInput): Promise<DeployRegistryCredential> {
    const check = await checkGithubToken(input.token, this.deps.fetch);
    return this.saveGithub(input.token, 'packagesToken', check, input.acceptBroaderScopes);
  }

  async githubCliStatus(): Promise<DeployGithubCliStatus> {
    const read = await readGhToken(this.deps.gh);
    if (read.token === null) {
      return {
        available: false,
        username: null,
        scopes: [],
        canPull: false,
        broaderScopes: [],
        problem: read.problem,
      };
    }
    return { available: true, ...(await checkGithubToken(read.token, this.deps.fetch, 'ghCli')) };
  }

  async saveGithubCli(input: DeployGithubCliInput): Promise<DeployRegistryCredential> {
    const read = await readGhToken(this.deps.gh);
    if (read.token === null) throw new Error(read.problem);
    const check = await checkGithubToken(read.token, this.deps.fetch, 'ghCli');
    return this.saveGithub(read.token, 'ghCli', check, input.acceptBroaderScopes);
  }

  async saveCredential(input: DeployRegistryCredentialInput): Promise<DeployRegistryCredential> {
    const registry =
      input.kind === 'dockerhub' ? DOCKER_HUB : normalizeRegistry(input.registry ?? '');
    if (!registry) throw new Error('Enter the registry host, such as registry.example.com:5000.');
    if (input.kind === 'custom' && registry === GITHUB_REGISTRY) {
      throw new Error('For ghcr.io, use the GitHub card: it checks the token for read:packages.');
    }
    const problem = registryCredentialProblem(input.username, input.secret);
    if (problem) throw new Error(problem);
    return this.store({
      kind: input.kind === 'dockerhub' || registry === DOCKER_HUB ? 'dockerhub' : 'custom',
      source: 'password',
      registry,
      username: input.username,
      secret: input.secret,
      scopes: null,
      broaderScopes: [],
      checkedAt: null,
    });
  }

  remove(id: string): Promise<void> {
    return this.deps.state.remove(id);
  }

  setSendSignIns(serverId: string, stackId: string, sendSignIns: boolean): Promise<void> {
    return this.deps.state.setSendSignIns(serverId, stackId, sendSignIns);
  }

  /** For each registry an app pulls from, the sign-in from this computer that goes along. */
  async plan(
    serverId: string,
    stackId: string | null,
    pulledFrom: readonly string[],
    storedOnServer: readonly string[],
  ): Promise<DeployRegistryPlan> {
    const sendSignIns = stackId ? await this.deps.state.sendSignIns(serverId, stackId) : true;
    const credentials = await this.deps.state.credentials();
    const registries = [...new Set(pulledFrom)].sort();
    return {
      sendSignIns,
      entries: registries.map((registry) => ({
        registry,
        credentialId: sendSignIns
          ? (credentials.find((item) => item.registry === registry)?.id ?? null)
          : null,
        storedOnServer: storedOnServer.includes(registry),
      })),
    };
  }

  /**
   * The sign-ins a deploy of this app sends, unsealed, for the registries it pulls from. None
   * when the app's choice is not to send them. A locked passkey stops the deploy with the reason
   * rather than letting the pull fail later on the server.
   */
  async authsFor(
    serverId: string,
    stackId: string,
    registries: readonly string[],
  ): Promise<RegistryAuth[]> {
    if (!(await this.deps.state.sendSignIns(serverId, stackId))) return [];
    return this.authsForRegistries(registries);
  }

  async authsForRegistries(registries: readonly string[]): Promise<RegistryAuth[]> {
    const wanted = new Set(registries);
    const credentials = (await this.deps.state.credentials()).filter((item) =>
      wanted.has(item.registry),
    );
    const auths: RegistryAuth[] = [];
    for (const credential of credentials) {
      if (this.deps.isLocked(credential.envelope)) {
        throw new RegistryLockedError(
          `Unlock the Servers passkey so the sign-in for ${credential.registry} can go with this deploy.`,
        );
      }
      auths.push({
        registry: credential.registry,
        username: credential.username,
        secret: await this.deps.unseal(credential.envelope),
      });
    }
    return auths;
  }

  /** The sign-in this computer holds for one registry, unsealed, for copying it to a server. */
  async secretOf(id: string): Promise<{ registry: string; username: string; secret: string }> {
    const credential = (await this.deps.state.credentials()).find((item) => item.id === id);
    if (!credential) throw new Error('That sign-in is no longer saved on this computer.');
    const [auth] = await this.authsForRegistries([credential.registry]);
    return auth;
  }

  private saveGithub(
    token: string,
    source: 'packagesToken' | 'ghCli',
    check: DeployGithubTokenCheck,
    acceptBroaderScopes: boolean,
  ): Promise<DeployRegistryCredential> {
    if (!check.canPull) throw new Error(check.problem ?? 'This token cannot read packages.');
    if (check.broaderScopes.length > 0 && !acceptBroaderScopes) {
      throw new Error(broaderWarning(check.broaderScopes));
    }
    return this.store({
      kind: 'github',
      source,
      registry: GITHUB_REGISTRY,
      // GHCR takes any user name with a classic token; the token's owner reads best in the logs.
      username: check.username ?? 'runova',
      secret: token,
      scopes: check.scopes,
      broaderScopes: check.broaderScopes,
      checkedAt: this.now(),
    });
  }

  private async store(
    input: Omit<StoredRegistryCredential, 'id' | 'envelope' | 'savedAt'> & { secret: string },
  ): Promise<DeployRegistryCredential> {
    const { secret, ...rest } = input;
    const credential: StoredRegistryCredential = {
      ...rest,
      id: randomUUID(),
      envelope: await this.deps.seal(secret),
      savedAt: this.now(),
    };
    await this.deps.state.save(credential);
    const { envelope, ...shown } = credential;
    return { ...shown, locked: this.deps.isLocked(envelope) };
  }
}
