import { describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import { DeployRegistries, RegistryLockedError } from './service';
import { RegistryState } from './state';

const PACKAGES = 'ghp_packagesOnlyToken0123456789';
const BROAD = 'gho_ghCliBroadToken0123456789';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';

function github(scopes: string) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ login: 'octocat' }), {
        status: 200,
        headers: { 'x-oauth-scopes': scopes },
      }),
  );
}

function setup(options: { scopes?: string; locked?: boolean; ghToken?: string | null } = {}) {
  let file: unknown = null;
  const state = new RegistryState({
    read: async () => file,
    write: async (value) => {
      file = JSON.parse(JSON.stringify(value));
    },
  });
  const seal = vi.fn(
    async (plaintext: string): Promise<SecretEnvelope> => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(`sealed:${plaintext}`).toString('base64'),
    }),
  );
  const unseal = vi.fn(async (envelope: SecretEnvelope) =>
    Buffer.from(envelope.ciphertext, 'base64')
      .toString()
      .replace(/^sealed:/, ''),
  );
  const gh = vi.fn(async () => {
    if (options.ghToken === null) throw new Error('not logged in');
    return { stdout: `${options.ghToken ?? BROAD}\n` };
  });
  const registries = new DeployRegistries({
    state,
    seal,
    unseal,
    isLocked: () => options.locked ?? false,
    gh,
    fetch: github(options.scopes ?? 'read:packages'),
    now: () => 1_000,
  });
  return { registries, state, file: () => file, seal, unseal, gh };
}

describe('DeployRegistries', () => {
  it('saves a packages-only GitHub token sealed, and never shows it', async () => {
    const { registries, file } = setup();

    const saved = await registries.saveGithubToken({ token: PACKAGES, acceptBroaderScopes: false });

    expect(saved).toMatchObject({
      kind: 'github',
      source: 'packagesToken',
      registry: 'ghcr.io',
      username: 'octocat',
      scopes: ['read:packages'],
      broaderScopes: [],
      checkedAt: 1_000,
      locked: false,
    });
    expect(JSON.stringify(await registries.list())).not.toContain(PACKAGES);
    expect(JSON.stringify(file())).not.toContain(PACKAGES);
    expect(JSON.stringify(saved)).not.toContain('envelope');
  });

  it('refuses a broader token until the warning is accepted', async () => {
    const { registries } = setup({ scopes: 'repo, workflow, read:packages' });

    await expect(
      registries.saveGithubToken({ token: BROAD, acceptBroaderScopes: false }),
    ).rejects.toThrow(/repo, workflow/);
    expect(await registries.list()).toEqual([]);

    const saved = await registries.saveGithubToken({ token: BROAD, acceptBroaderScopes: true });
    expect(saved.broaderScopes).toEqual(['repo', 'workflow']);
  });

  it('refuses a token that cannot read packages, with the fix', async () => {
    const { registries } = setup({ scopes: 'repo' });

    await expect(
      registries.saveGithubToken({ token: BROAD, acceptBroaderScopes: true }),
    ).rejects.toThrow(/read:packages/);
  });

  it('checks a token without saving it', async () => {
    const { registries } = setup({ scopes: 'read:packages, repo' });

    expect(await registries.checkGithubToken(PACKAGES)).toMatchObject({
      canPull: true,
      broaderScopes: ['repo'],
    });
    expect(await registries.list()).toEqual([]);
  });

  it('uses the gh sign-in only with the warning accepted', async () => {
    const { registries, gh } = setup({ scopes: 'gist, read:org, repo, workflow, read:packages' });

    const status = await registries.githubCliStatus();
    expect(status).toMatchObject({ available: true, canPull: true });
    expect(status.broaderScopes).toEqual(['gist', 'read:org', 'repo', 'workflow']);
    await expect(registries.saveGithubCli({ acceptBroaderScopes: false })).rejects.toThrow(/repo/);

    const saved = await registries.saveGithubCli({ acceptBroaderScopes: true });
    expect(saved.source).toBe('ghCli');
    expect(gh).toHaveBeenCalledWith(['auth', 'token', '--hostname', 'github.com']);
  });

  it('says when gh is not there', async () => {
    const { registries } = setup({ ghToken: null });

    expect(await registries.githubCliStatus()).toMatchObject({ available: false });
    await expect(registries.saveGithubCli({ acceptBroaderScopes: true })).rejects.toThrow(
      /gh auth login/,
    );
  });

  it('saves Docker Hub and custom registries, one sign-in per registry', async () => {
    const { registries } = setup();

    await registries.saveCredential({
      kind: 'dockerhub',
      username: 'hubber',
      secret: 'dckr_pat_one',
    });
    await registries.saveCredential({
      kind: 'custom',
      registry: 'https://Registry.Example.com:5000/',
      username: 'ci',
      secret: 'first-password',
    });
    await registries.saveCredential({
      kind: 'custom',
      registry: 'registry.example.com:5000',
      username: 'ci2',
      secret: 'second-password',
    });

    const list = await registries.list();
    expect(list.map((item) => [item.registry, item.username, item.kind])).toEqual([
      ['docker.io', 'hubber', 'dockerhub'],
      ['registry.example.com:5000', 'ci2', 'custom'],
    ]);
  });

  it('refuses what the core would refuse', async () => {
    const { registries } = setup();

    await expect(
      registries.saveCredential({
        kind: 'custom',
        registry: 'not a host',
        username: 'u',
        secret: 'pass',
      }),
    ).rejects.toThrow(/registry host/);
    await expect(
      registries.saveCredential({
        kind: 'custom',
        registry: 'r.example',
        username: 'a:b',
        secret: 'pass',
      }),
    ).rejects.toThrow(/colon/);
    await expect(
      registries.saveCredential({
        kind: 'custom',
        registry: 'ghcr.io',
        username: 'u',
        secret: 'pass',
      }),
    ).rejects.toThrow(/GitHub card/);
  });

  it('unseals only the sign-ins for the registries a deploy pulls from', async () => {
    const { registries, unseal } = setup();
    await registries.saveGithubToken({ token: PACKAGES, acceptBroaderScopes: false });
    await registries.saveCredential({
      kind: 'dockerhub',
      username: 'hubber',
      secret: 'dckr_pat_hub',
    });

    const auths = await registries.authsFor('srv', STACK, ['ghcr.io', 'quay.io']);

    expect(auths).toEqual([{ registry: 'ghcr.io', username: 'octocat', secret: PACKAGES }]);
    expect(unseal).toHaveBeenCalledTimes(1);
  });

  it('with no registry named, unseals every sign-in for the server to pick from', async () => {
    const { registries, unseal } = setup();
    await registries.saveGithubToken({ token: PACKAGES, acceptBroaderScopes: false });
    await registries.saveCredential({
      kind: 'dockerhub',
      username: 'hubber',
      secret: 'dckr_pat_hub',
    });

    const auths = await registries.authsFor('srv', STACK, null);
    const plan = await registries.plan('srv', STACK, ['docker.io'], [], true);

    expect([...auths].sort((a, b) => a.registry.localeCompare(b.registry))).toEqual([
      { registry: 'docker.io', username: 'hubber', secret: 'dckr_pat_hub' },
      { registry: 'ghcr.io', username: 'octocat', secret: PACKAGES },
    ]);
    expect(unseal).toHaveBeenCalledTimes(2);
    expect(plan.unresolved).toBe(true);
    await registries.setSendSignIns('srv', STACK, false);
    expect(await registries.authsFor('srv', STACK, null)).toEqual([]);
  });

  it('an app whose choice is not to send them gets none, and the plan says so', async () => {
    const { registries } = setup();
    const saved = await registries.saveGithubToken({ token: PACKAGES, acceptBroaderScopes: false });

    const before = await registries.plan('srv', STACK, ['ghcr.io', 'docker.io'], ['docker.io']);
    await registries.setSendSignIns('srv', STACK, false);
    const after = await registries.plan('srv', STACK, ['ghcr.io'], []);

    expect(before).toEqual({
      sendSignIns: true,
      entries: [
        { registry: 'docker.io', credentialId: null, storedOnServer: true },
        { registry: 'ghcr.io', credentialId: saved.id, storedOnServer: false },
      ],
    });
    expect(after.sendSignIns).toBe(false);
    expect(after.entries[0].credentialId).toBeNull();
    expect(await registries.authsFor('srv', STACK, ['ghcr.io'])).toEqual([]);
  });

  it('a locked passkey stops a deploy that needs the sign-in', async () => {
    const { registries } = setup({ locked: true });
    await registries.saveGithubToken({ token: PACKAGES, acceptBroaderScopes: false });

    expect((await registries.list())[0].locked).toBe(true);
    await expect(registries.authsFor('srv', STACK, ['ghcr.io'])).rejects.toBeInstanceOf(
      RegistryLockedError,
    );
    expect(await registries.authsFor('srv', STACK, ['docker.io'])).toEqual([]);
  });

  it('hands one sign-in over for storing on a server, and forgets removed ones', async () => {
    const { registries } = setup();
    const saved = await registries.saveGithubToken({ token: PACKAGES, acceptBroaderScopes: false });

    expect(await registries.secretOf(saved.id)).toEqual({
      registry: 'ghcr.io',
      username: 'octocat',
      secret: PACKAGES,
    });
    await registries.remove(saved.id);
    await expect(registries.secretOf(saved.id)).rejects.toThrow(/no longer saved/);
  });
});
