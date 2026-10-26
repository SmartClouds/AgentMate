import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ErrorConnectionSummary,
  ErrorIssueDetail,
  ErrorIssuePage,
  ErrorIssuePrompt,
  ErrorIssueSummary,
  ErrorProjectLink,
  ErrorTokenCheck,
  RemoteProject,
} from '../../shared/errorTrackingTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { FAKE_TOKEN, type FakeSentry, startFakeSentry } from '../../test/main/fakeSentry';
import { tempDir } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The Errors tab's channels (E24). Every argument is checked here before anything reads it, only
 * the main window may call them, and a token goes in through three channels and never comes back
 * out of any. The calls run over the app's net.fetch (Node's fetch in the electron mock) against
 * a Sentry on loopback.
 */

const userData = useTempUserData();

// The first import pulls in all of @runova/core, which can take longer than a hook is allowed
// on a busy machine. Paying for it once up front keeps the per-test re-imports quick.
beforeAll(async () => {
  await import('./errorTracking');
}, 120_000);

// onChanged is main to renderer, checked through the windows' sent messages instead.
expectChannelsCovered(IPC.errorTracking, [IPC.errorTracking.onChanged]);

let fake: FakeSentry;

beforeEach(async () => {
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
  ]);
  fake = await startFakeSentry();
  const electron = await import('../../test/main/electronMock');
  electron.net.fetch.mockImplementation((url: string, init: RequestInit) => fetch(url, init));
  await loadIpc(
    () => import('./errorTracking'),
    (module) => module.registerErrorTrackingHandlers(),
  );
  return () => fake.close();
});

function expectNoToken(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain('tokenEnvelope');
  expect(text).not.toContain('ciphertext');
}

const tokenInput = () => ({ provider: 'sentry', host: fake.url, token: FAKE_TOKEN });

async function connect(): Promise<ErrorConnectionSummary> {
  return invoke<ErrorConnectionSummary>(IPC.errorTracking.addConnection, {
    ...tokenInput(),
    orgSlug: 'acme',
  });
}

async function connectAndLink() {
  const connection = await connect();
  const link: ErrorProjectLink = {
    projectId: 'p1',
    connectionId: connection.id,
    remoteProjectId: '102',
    remoteSlug: 'storefront-api',
    remoteName: 'storefront-api',
  };
  await invoke(IPC.errorTracking.setLinks, 'p1', [link]);
  return { connection, link };
}

describe('connections', () => {
  it('checks a token without saving it', async () => {
    const check = await invoke<ErrorTokenCheck>(IPC.errorTracking.checkToken, tokenInput());
    expect(check.organizations.map((org) => org.slug)).toEqual(['acme', 'side-project']);
    expectNoToken(check);
    expect(() => readFileSync(userData.dataFile('error-tracking.json'))).toThrow();
  });

  it('saves a connection and never hands the token back', async () => {
    const window = new FakeBrowserWindow();
    const connection = await connect();
    expect(connection).toMatchObject({ orgSlug: 'acme', locked: false, canWrite: true });
    expectNoToken(connection);
    expectNoToken(await invoke(IPC.errorTracking.listConnections));
    expect(readFileSync(userData.dataFile('error-tracking.json'), 'utf-8')).not.toContain(
      FAKE_TOKEN,
    );
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([
      [{ reason: 'connections' }],
    ]);
  });

  it('replaces a token and removes a connection', async () => {
    const connection = await connect();
    const replaced = await invoke<ErrorConnectionSummary>(
      IPC.errorTracking.replaceToken,
      connection.id,
      FAKE_TOKEN,
    );
    expectNoToken(replaced);
    await invoke(IPC.errorTracking.removeConnection, connection.id);
    expect(await invoke(IPC.errorTracking.listConnections)).toEqual([]);
  });

  it('refuses input of the wrong shape before using it', async () => {
    await expect(
      invoke(IPC.errorTracking.checkToken, { ...tokenInput(), provider: 'rollbar' }),
    ).rejects.toThrow(/not valid \(provider\)/);
    await expect(
      invoke(IPC.errorTracking.checkToken, { ...tokenInput(), token: '' }),
    ).rejects.toThrow(/not valid \(token\)/);
    await expect(invoke(IPC.errorTracking.addConnection, tokenInput())).rejects.toThrow(/orgSlug/);
    await expect(invoke(IPC.errorTracking.removeConnection, '')).rejects.toThrow(/not valid/);
    await expect(invoke(IPC.errorTracking.replaceToken, 'c1', 42)).rejects.toThrow(/not valid/);
    await expect(invoke(IPC.errorTracking.remoteProjects, { id: 1 })).rejects.toThrow(/not valid/);
    await expect(invoke(IPC.errorTracking.environments, { projectId: 7 })).rejects.toThrow(
      /not valid/,
    );
    await expect(invoke(IPC.errorTracking.listLinks, 'p1')).rejects.toThrow(/not valid/);
    await expect(invoke(IPC.errorTracking.setLinks, 'p1', [{ projectId: 'p1' }])).rejects.toThrow(
      /not valid/,
    );
    await expect(
      invoke(IPC.errorTracking.listIssues, { status: 'open', period: '24h', sort: 'lastSeen' }),
    ).rejects.toThrow(/not valid \(status\)/);
    await expect(
      invoke(IPC.errorTracking.getIssue, { connectionId: 'c1', issueId: '../../x' }),
    ).rejects.toThrow(/not valid \(issueId\)/);
    await expect(
      invoke(IPC.errorTracking.setIssueStatus, {
        connectionId: 'c1',
        issueId: '1',
        status: 'ignored',
        ignoreMinutes: -5,
      }),
    ).rejects.toThrow(/not valid \(ignoreMinutes\)/);
    await expect(invoke(IPC.errorTracking.fixPrompt, null)).rejects.toThrow(/not valid/);
  });

  it('keeps the token out of a refusal message', async () => {
    const error = await invoke(IPC.errorTracking.checkToken, {
      ...tokenInput(),
      token: `${FAKE_TOKEN}x`.repeat(500),
    }).catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
  });
});

describe('links and remote data', () => {
  it('lists remote projects, links one and reads its environments', async () => {
    const { connection, link } = await connectAndLink();
    const projects = await invoke<RemoteProject[]>(IPC.errorTracking.remoteProjects, connection.id);
    expect(projects.map((project) => project.slug)).toContain('storefront-api');
    expect(await invoke(IPC.errorTracking.listLinks, { projectId: 'p1' })).toEqual([link]);
    expect(await invoke(IPC.errorTracking.listLinks)).toEqual([link]);
    expect(await invoke(IPC.errorTracking.environments, { projectId: 'p1' })).toEqual([
      'production',
      'staging',
    ]);
    expect(await invoke(IPC.errorTracking.environments)).toEqual(['production', 'staging']);
  });
});

describe('issues', () => {
  it('lists, opens, resolves and prompts', async () => {
    const { connection } = await connectAndLink();
    const page = await invoke<ErrorIssuePage>(IPC.errorTracking.listIssues, {
      projectId: 'p1',
      status: 'unresolved',
      period: '14d',
      sort: 'lastSeen',
      environment: null,
      search: '',
      cursor: null,
      refresh: true,
    });
    expect(page.issues.map((issue) => issue.id)).toEqual(['4501']);
    expectNoToken(page);

    const ref = { connectionId: connection.id, issueId: '4501' };
    const detail = await invoke<ErrorIssueDetail>(IPC.errorTracking.getIssue, ref);
    expect(detail.event?.exceptions.length).toBeGreaterThan(0);

    const resolved = await invoke<ErrorIssueSummary>(IPC.errorTracking.setIssueStatus, {
      ...ref,
      status: 'resolved',
    });
    expect(resolved.status).toBe('resolved');
    expect(fake.requestsTo('/api/0/organizations/acme/issues/4501/', 'PUT')).toHaveLength(1);

    const prompt = await invoke<ErrorIssuePrompt>(IPC.errorTracking.fixPrompt, ref);
    expect(prompt.prompt).toContain('Shop');
    expectNoToken(prompt);
  });
});

describe('who may call', () => {
  it('answers only the main window', async () => {
    await loadIpc(
      () => import('./errorTracking'),
      (module) => module.registerErrorTrackingHandlers({ guard: () => false }),
    );
    await expect(invoke(IPC.errorTracking.listConnections)).rejects.toThrow(/main window/);
  });
});

describe('the vault', () => {
  it('moves the token with a passkey change and says so when it opens again', async () => {
    await connect();
    const vault = await import('../ssh/vault');
    expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
    const saved = JSON.parse(readFileSync(userData.dataFile('error-tracking.json'), 'utf-8'));
    expect(saved.connections[0].tokenEnvelope.mode).toBe('passphrase');

    vault.lockVault();
    const [locked] = await invoke<ErrorConnectionSummary[]>(IPC.errorTracking.listConnections);
    expect(locked.locked).toBe(true);
    const window = new FakeBrowserWindow();
    expect(await vault.unlockVault('a servers passkey')).toBe(true);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([
      [{ reason: 'connections' }],
    ]);
    await vault.setPasskey(null);
  });
});
