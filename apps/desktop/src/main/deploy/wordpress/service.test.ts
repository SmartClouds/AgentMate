import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WP_CONNECTOR_VERSION,
  WP_ROUTES,
  type WpItemRef,
  wpConnectorReleaseUrl,
} from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type { DeployWordPressProgressEvent } from '../../../shared/deployWordPressTypes';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { VaultLockedError } from '../../ssh/vaultErrors';
import type { WpClient } from './client';
import { WpRemoteError } from './client';
import { cleanInfo, cleanItem, conflictMessage, WordPressService, wpMessagePath } from './service';
import { WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { testConnectorBundle } from './testing/connectorBundle';
import { FakeConnector, pairingSecretOf } from './testing/fakeConnector';
import { createFetchTransport } from './transport';

/**
 * The WordPress service against the fake connector over HTTP, with the real store on disk and a
 * stand-in vault: connecting, settings, info, items, history, audit, rollbacks, one operation
 * per site, cancels, a locked vault, and a deploy left behind by a crash.
 */

const THEME: WpItemRef = { kind: 'theme', slug: 'shop' };
const nodeTransport = createFetchTransport(globalThis.fetch as never);

let fake: FakeConnector;
let dir: string;
let locked: boolean;
let events: DeployWordPressProgressEvent[];

beforeEach(async () => {
  fake = await new FakeConnector().start();
  fake.addItem(THEME, { 'style.css': 'body{}', 'functions.php': '<?php' }, { active: true });
  dir = mkdtempSync(join(tmpdir(), 'agentmate-wp-service-'));
  locked = false;
  events = [];
});
afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function make(overrides: Partial<ConstructorParameters<typeof WordPressService>[0]> = {}) {
  const state = new WordPressState(wordPressStateFilePort(join(dir, 'deploy-wordpress.json')));
  const bases = new WordPressBases(join(dir, 'bases'));
  const service = new WordPressService({
    state,
    bases,
    transport: nodeTransport,
    seal: async (plain) => {
      if (locked) throw new VaultLockedError();
      return {
        mode: 'passphrase',
        iv: 'i',
        authTag: 't',
        ciphertext: Buffer.from(plain).toString('base64'),
      };
    },
    unseal: async (envelope: SecretEnvelope) => {
      if (locked) throw new VaultLockedError();
      if (envelope.ciphertext === 'broken') throw new Error('bad tag');
      return Buffer.from(envelope.ciphertext, 'base64').toString('utf-8');
    },
    isLocked: (envelope) => locked && envelope?.mode === 'passphrase',
    progress: (event) => events.push(event),
    hostname: () => 'test-laptop',
    saveConnectorZip: async () => ({ saved: true, path: '/tmp/agentmate-connector.zip' }),
    readConnectorBundle: async () => testConnectorBundle(),
    sleep: async () => undefined,
    ...overrides,
  });
  return { service, state, bases };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

/** A whole deploy of one file, straight through the client, as the deploy run would make it. */
async function deployOnFake(client: WpClient, path: string, content: string): Promise<string> {
  const bytes = Buffer.from(content);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const current = fake.file(THEME, path);
  const expected = current === null ? null : createHash('sha256').update(current).digest('hex');
  const begin = await client.call(WP_ROUTES.deployBegin, {
    label: 'Test',
    items: [THEME],
    ops: [{ op: 'put', item: THEME, path, sha256: sha, size: bytes.length, expected }],
  });
  const deployId = begin.data.deployId as string;
  await client.call(
    WP_ROUTES.deployUpload,
    { deployId, chunks: [{ op: 0, offset: 0, final: true }] },
    { blobs: [bytes] },
  );
  await client.call(WP_ROUTES.deployCommit, { deployId });
  await client.call(WP_ROUTES.deployVerify, { deployId });
  await client.call(WP_ROUTES.deployFinalize, { deployId });
  return deployId;
}

async function clientOf(service: WordPressService, siteId: string): Promise<WpClient> {
  const internals = service as unknown as {
    requireSite: (id: string) => Promise<never>;
    clientFor: (site: unknown) => Promise<WpClient>;
  };
  return internals.clientFor(await internals.requireSite(siteId));
}

describe('connect', () => {
  it('pairs, stores the key sealed, and hands back no secret', async () => {
    const { service } = make();
    const key = fake.createKey({ label: 'Office' });
    const site = await service.connect({ connectionKey: key });

    expect(site).toMatchObject({
      label: 'Fake Shop',
      siteName: 'Fake Shop',
      siteUrl: fake.siteUrl,
      scope: 'write',
      transport: 'local-http',
      allowPlainHttp: false,
      hasHttpAuth: false,
      pluginVersion: WP_CONNECTOR_VERSION,
      protocol: 1,
    });
    expect(site.lastSeenAt).toBe(site.connectedAt);
    expect(Object.keys(site)).not.toContain('privateKey');
    expect(await service.listSites()).toEqual([site]);

    const file = readFileSync(join(dir, 'deploy-wordpress.json'), 'utf-8');
    expect(file).not.toContain('PRIVATE KEY');
    expect(file).not.toContain(pairingSecretOf(key));
    expect(file).not.toContain(key);
    expect(fake.connections.get(JSON.parse(file).sites[0].connectionId)?.deviceName).toBe(
      'test-laptop',
    );
  });

  it('does not spend the key while the vault is locked', async () => {
    const { service } = make();
    locked = true;
    const key = fake.createKey();
    expect(wordPressErrorCode(await failure(service.connect({ connectionKey: key })))).toBe(
      'vaultLocked',
    );
    expect(fake.requests).toEqual([]);
    locked = false;
    await service.connect({ connectionKey: key, label: 'Mine' });
    expect((await service.listSites())[0].label).toBe('Mine');
  });

  it('keeps the same site id when the same site is connected again, and retires the old link', async () => {
    const { service, state } = make();
    const first = await service.connect({ connectionKey: fake.createKey(), label: 'Shop' });
    const oldConnection = (await state.site(first.id))?.connectionId as string;
    const second = await service.connect({ connectionKey: fake.createKey({ scope: 'read' }) });
    expect(second.id).toBe(first.id);
    expect(second.label).toBe('Shop');
    expect(second.scope).toBe('read');
    expect(await service.listSites()).toHaveLength(1);
    expect(fake.connections.get(oldConnection)?.revoked).toBe(true);
  });

  it('keeps a staging clone apart from the site it copies, though they share a key', async () => {
    const staging = await new FakeConnector().start();
    try {
      const { service, state } = make();
      const live = await service.connect({ connectionKey: fake.createKey(), label: 'Live' });
      const copy = await service.connect({ connectionKey: staging.createKey(), label: 'Staging' });
      expect(staging.sitePublicKey).toBe(fake.sitePublicKey);
      expect(copy.id).not.toBe(live.id);
      expect((await service.listSites()).map((site) => site.label).sort()).toEqual([
        'Live',
        'Staging',
      ]);
      expect((await state.site(live.id))?.restUrl).toBe(fake.restUrl);
      // Connecting the live site again still lands on its own record.
      const again = await service.connect({ connectionKey: fake.createKey() });
      expect(again.id).toBe(live.id);
      expect(again.label).toBe('Live');
      expect((await state.site(copy.id))?.restUrl).toBe(staging.restUrl);
    } finally {
      await staging.stop();
    }
  });

  it('signs in with HTTP Basic when the site wants it', async () => {
    const { service, state } = make();
    fake.switches.basicAuth = { username: 'stage', password: 'pw' };
    const missing = await failure(service.connect({ connectionKey: fake.createKey() }));
    expect(wordPressErrorCode(missing)).toBe('httpAuthRequired');

    const site = await service.connect({
      connectionKey: fake.createKey(),
      httpAuth: { username: 'stage', password: 'pw' },
    });
    expect(site.hasHttpAuth).toBe(true);
    expect((await state.site(site.id))?.httpAuth?.password.mode).toBe('passphrase');
    expect((await service.siteInfo(site.id)).siteName).toBe('Fake Shop');
  });
});

describe('site calls', () => {
  it('reads site info and keeps what it learned', async () => {
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const info = await service.siteInfo(site.id);
    expect(info.siteName).toBe('Fake Shop');
    expect(info.checkedAt).toBeGreaterThan(0);
    expect(info.guard.rescueUrl).toBe(fake.rescueUrl);
    const stored = await state.site(site.id);
    expect(stored?.endpoint).toBe('rest');
    expect(stored?.rescueUrl).toBe(fake.rescueUrl);
  });

  it('lists items, cleaned, and drops ones that cannot be synced', async () => {
    fake.addItem(
      { kind: 'plugin', slug: 'hello.php' },
      { 'hello.php': '<?php' },
      {
        isFile: true,
        name: 'Hello\u202e\nDolly',
      },
    );
    fake.addItem({ kind: 'plugin', slug: '.claude' }, {});
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const items = await service.listItems(site.id);
    expect(items.map((item) => item.slug).sort()).toEqual(['hello.php', 'shop']);
    expect(items.find((item) => item.slug === 'hello.php')?.name).toBe('Hello Dolly');
  });

  it('reads the deploy history and the audit log', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const client = await clientOf(service, site.id);
    const deployId = await deployOnFake(client, 'style.css', 'body{color:red}');
    const history = await service.history(site.id);
    expect(history[0]).toMatchObject({ deployId, state: 'done', canRollback: true, puts: 1 });

    const audit = await service.audit({ siteId: site.id, limit: 50 });
    expect(audit.map((entry) => entry.event)).toContain('paired');
    const older = await service.audit({ siteId: site.id, limit: 50, before: 2 });
    expect(older.every((entry) => entry.id < 2)).toBe(true);
  });

  it('refuses sites it does not know, a locked vault, and plain HTTP it was not allowed', async () => {
    const { service, state } = make();
    expect(wordPressErrorCode(await failure(service.siteInfo('nope')))).toBe('siteUnknown');
    const site = await service.connect({ connectionKey: fake.createKey() });

    locked = true;
    expect(wordPressErrorCode(await failure(service.siteInfo(site.id)))).toBe('vaultLocked');
    locked = false;

    await state.updateSite(site.id, (current) => ({
      ...current,
      siteUrl: 'http://shop.example',
    }));
    expect(wordPressErrorCode(await failure(service.listItems(site.id)))).toBe('plainHttpRefused');

    await state.updateSite(site.id, (current) => ({
      ...current,
      siteUrl: fake.siteUrl,
      privateKey: { mode: 'safeStorage', ciphertext: 'broken' },
    }));
    expect(wordPressErrorCode(await failure(service.listItems(site.id)))).toBe('internal');
  });

  it('remembers a clock fix even when the call fails', async () => {
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    fake.switches.clockSkew = 3000;
    await service.siteInfo(site.id);
    expect((await state.site(site.id))?.clockOffset).toBeGreaterThan(2990);
  });
});

describe('settings and disconnect', () => {
  it('changes the name, plain HTTP and the HTTP sign-in', async () => {
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const renamed = await service.updateSettings({ siteId: site.id, label: 'Live shop' });
    expect(renamed.label).toBe('Live shop');
    const withAuth = await service.updateSettings({
      siteId: site.id,
      allowPlainHttp: true,
      httpAuth: { username: 'u', password: 'p' },
    });
    expect(withAuth).toMatchObject({ allowPlainHttp: true, hasHttpAuth: true, label: 'Live shop' });
    expect(JSON.stringify(await state.site(site.id))).not.toContain('"p"');
    const kept = await service.updateSettings({ siteId: site.id });
    expect(kept.hasHttpAuth).toBe(true);
    const cleared = await service.updateSettings({ siteId: site.id, httpAuth: null });
    expect(cleared.hasHttpAuth).toBe(false);
    expect(wordPressErrorCode(await failure(service.updateSettings({ siteId: 'gone' })))).toBe(
      'siteUnknown',
    );

    await state.removeSite(site.id);
    // The site goes away between the check and the change.
    const racing = Object.create(state) as WordPressState;
    racing.site = async () => ({ id: site.id }) as never;
    const raced = make({ state: racing });
    expect(
      wordPressErrorCode(await failure(raced.service.updateSettings({ siteId: site.id }))),
    ).toBe('siteUnknown');
  });

  it('revokes on the site when asked, and forgets the site either way', async () => {
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const connectionId = (await state.site(site.id))?.connectionId as string;
    await service.disconnect({ siteId: site.id, revokeOnSite: true });
    expect(fake.connections.get(connectionId)?.revoked).toBe(true);
    expect(await service.listSites()).toEqual([]);

    const again = await service.connect({ connectionKey: fake.createKey() });
    await fake.stop();
    await service.disconnect({ siteId: again.id, revokeOnSite: true });
    expect(await service.listSites()).toEqual([]);
    expect(
      wordPressErrorCode(
        await failure(service.disconnect({ siteId: again.id, revokeOnSite: false })),
      ),
    ).toBe('siteUnknown');
  });

  it('will not drop a site it cannot revoke while the vault is locked', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    locked = true;
    expect(
      wordPressErrorCode(
        await failure(service.disconnect({ siteId: site.id, revokeOnSite: true })),
      ),
    ).toBe('vaultLocked');
    expect(await service.listSites()).toHaveLength(1);
    await service.disconnect({ siteId: site.id, revokeOnSite: false });
    expect(await service.listSites()).toEqual([]);
  });
});

describe('rollback and operations', () => {
  it('rolls a deploy back and reports its steps', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const deployId = await deployOnFake(await clientOf(service, site.id), 'style.css', 'new');
    expect(fake.file(THEME, 'style.css')).toBe('new');

    const result = await service.rollback({
      operationId: 'op-rollback-1',
      siteId: site.id,
      deployId,
    });
    expect(result).toMatchObject({
      deployId,
      state: 'rolledBack',
      reason: 'requested',
      uploaded: 1,
    });
    expect(fake.file(THEME, 'style.css')).toBe('body{}');
    expect(events.map((event) => event.phase)).toEqual(['connecting', 'rollback', 'done']);
    expect(events.every((event) => event.kind === 'rollback' && event.projectId === null)).toBe(
      true,
    );
  });

  it('rolls back through rescue.php when the site is failing', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const deployId = await deployOnFake(await clientOf(service, site.id), 'style.css', 'broken');
    fake.switches.siteFatal = true;
    const result = await service.rollback({
      operationId: 'op-rollback-2',
      siteId: site.id,
      deployId,
    });
    expect(result.state).toBe('rolledBack');
    expect(fake.requests.at(-1)?.endpoint).toBe('rescue');
  });

  it('explains a rollback refused over files changed since, one line per file', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const deployId = await deployOnFake(await clientOf(service, site.id), 'style.css', 'new');
    fake.setFile(THEME, 'style.css', 'edited in wp-admin');
    // The fake reports no details; a site that does gets them listed.
    const plain = await failure(
      service.rollback({ operationId: 'op-rollback-3', siteId: site.id, deployId }),
    );
    expect(wordPressErrorCode(plain)).toBe('conflict');
    expect(events.at(-1)).toMatchObject({ phase: 'failed', kind: 'rollback' });
    expect(events.at(-1)?.error).toContain('[wp:conflict]');

    const forced = await service.rollback({
      operationId: 'op-rollback-4',
      siteId: site.id,
      deployId,
      force: true,
    });
    expect(forced.state).toBe('rolledBack');
  });

  it('runs one operation per site, and cancels by operation id', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const deployId = await deployOnFake(await clientOf(service, site.id), 'style.css', 'new');
    fake.switches.delayMs = 400;
    const first = service.rollback({ operationId: 'op-slow-0001', siteId: site.id, deployId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      wordPressErrorCode(
        await failure(service.rollback({ operationId: 'op-other-001', siteId: site.id, deployId })),
      ),
    ).toBe('operationBusy');
    expect(
      wordPressErrorCode(
        await failure(service.rollback({ operationId: 'op-slow-0001', siteId: 'x', deployId })),
      ),
    ).toBe('operationBusy');
    expect(
      wordPressErrorCode(
        await failure(service.disconnect({ siteId: site.id, revokeOnSite: false })),
      ),
    ).toBe('operationBusy');
    await service.cancel('op-slow-0001');
    await service.cancel('op-unknown-01');
    expect(wordPressErrorCode(await failure(first))).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ operationId: 'op-slow-0001', phase: 'failed' });
  });

  it('passes the connector zip through', async () => {
    const { service } = make();
    expect(await service.saveConnectorZip()).toEqual({
      saved: true,
      path: '/tmp/agentmate-connector.zip',
    });
  });
});

describe('updateConnector', () => {
  const updateCalls = () =>
    fake.requests.filter((request) => request.route === WP_ROUTES.connectorUpdate);

  it('sends the bundled files and confirms the new version afterwards', async () => {
    fake.pluginVersion = '1.0.0';
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const result = await service.updateConnector(site.id);

    expect(result).toMatchObject({
      outcome: 'updated',
      fromVersion: '1.0.0',
      version: WP_CONNECTOR_VERSION,
    });
    expect(result.checks.map((check) => check.name)).toEqual(['home', 'ajaxPing']);
    expect(result.source).toBe('app');
    expect(result.downloadProblem).toBeUndefined();
    expect(fake.pluginVersion).toBe(WP_CONNECTOR_VERSION);
    expect(fake.updates).toEqual([
      {
        version: WP_CONNECTOR_VERSION,
        files: ['agentmate-connector.php', 'readme.txt', 'src/Plugin.php'],
        state: 'updated',
        source: 'upload',
      },
    ]);
    // A development build names no release, so the site is never asked to download.
    expect(fake.downloads).toEqual([]);
    expect(fake.audit[0]?.event).toBe('connectorUpdated');
    // The version the app remembers comes from the site's own answer afterwards.
    expect((await state.site(site.id))?.pluginVersion).toBe(WP_CONNECTOR_VERSION);
  });

  it('sends nothing when the site already has this version or a newer one', async () => {
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    expect(await service.updateConnector(site.id)).toEqual({
      outcome: 'current',
      fromVersion: WP_CONNECTOR_VERSION,
      version: WP_CONNECTOR_VERSION,
      checks: [],
    });
    fake.pluginVersion = '99.0.0';
    expect((await service.updateConnector(site.id)).outcome).toBe('current');
    expect(updateCalls()).toHaveLength(0);
  });

  it('never calls the route of a connector that cannot update itself', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.selfUpdate = false;
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('connectorOutdated');
    expect(error.message).toContain('Upload the plugin once in wp-admin');
    expect(error.message).toContain('updates can be done from here');
    expect(updateCalls()).toHaveLength(0);
  });

  it('says why a connector that has the route cannot swap its folder', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.notReplaceable = true;
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('updateRefused');
    expect(error.message).toMatch(/can't be replaced from here/);
    expect(updateCalls()).toHaveLength(0);
  });

  it('keeps the site\x27s own sentence when its PHP or WordPress is too old', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.refuseUpdate = {
      code: 'updateRefused',
      message: 'AgentMate Connector 9.0.0 needs PHP 99.0 or newer, and this site runs 7.4.33.',
      details: { reason: 'requirements' },
    };
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('updateRefused');
    expect(error.message).toContain('needs PHP 99.0 or newer, and this site runs 7.4.33');
  });

  it('reports an update the site undid because it failed its health check', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.updateHealthFails = true;
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const result = await service.updateConnector(site.id);

    expect(result.outcome).toBe('rolledBack');
    expect(result.checks.find((check) => check.name === 'home')).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(fake.pluginVersion).toBe('1.0.0');
    expect(fake.audit[0]?.event).toBe('connectorRolledBack');
    expect((await state.site(site.id))?.pluginVersion).toBe('1.0.0');
  });

  it('refuses before sending when the files do not fit the site', async () => {
    fake.pluginVersion = '1.0.0';
    fake.limits.maxRequestBytes = 70 * 1024;
    const bigBundle = testConnectorBundle();
    // Random bytes do not compress, so the request really is this big on the wire.
    const noise = randomBytes(400_000);
    bigBundle.files.push({
      path: 'src/Noise.php',
      size: noise.length,
      sha256: createHash('sha256').update(noise).digest('hex'),
      bytes: noise,
    });
    const { service } = make({ readConnectorBundle: async () => bigBundle });
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('updateRefused');
    expect(error.message).toContain('takes requests of about 70 KB at most');
    expect(error.message).toContain('upload it in wp-admin instead');
    expect(updateCalls()).toHaveLength(0);
  });

  it('needs a write key', async () => {
    fake.pluginVersion = '1.0.0';
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey({ scope: 'read' }) });

    expect(wordPressErrorCode(await failure(service.updateConnector(site.id)))).toBe('readOnly');
    expect(fake.pluginVersion).toBe('1.0.0');
  });

  it('passes the site busy through when a deploy is still open', async () => {
    fake.pluginVersion = '1.0.0';
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const client = await clientOf(service, site.id);
    const begin = await client.call(WP_ROUTES.deployBegin, {
      label: 'Open',
      items: [THEME],
      ops: [
        {
          op: 'put',
          item: THEME,
          path: 'style.css',
          sha256: createHash('sha256').update('x').digest('hex'),
          size: 1,
          expected: 'any',
        },
      ],
    });

    const busy = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(busy)).toBe('busy');
    await client.call(WP_ROUTES.deployAbort, { deployId: begin.data.deployId as string });
    expect((await service.updateConnector(site.id)).outcome).toBe('updated');
  });

  it.each([
    ['downgrade', /newer than the one that comes with this app/],
    ['badPackage', /did not accept the connector files/],
    ['notReplaceable', /can't be replaced from here/],
  ])('says in its own words why the site refused (%s)', async (reason, words) => {
    fake.pluginVersion = '1.0.0';
    fake.switches.refuseUpdate = {
      code: 'updateRefused',
      message: 'raw site wording',
      details: { reason },
    };
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('updateRefused');
    expect(error.message).toMatch(words);
    expect(error.message).not.toContain('raw site wording');
    expect(fake.pluginVersion).toBe('1.0.0');
  });

  it('turns a syntax error in the new files into a refusal that names the file', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.refuseUpdate = {
      code: 'syntaxError',
      message: 'Parse error',
      details: { path: 'src/Plugin.php', line: 12, message: 'unexpected token' },
    };
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('updateRefused');
    expect(error.message).toContain('a syntax error in src/Plugin.php, line 12');
    expect(error.message).toContain('so nothing was changed');
  });

  it('explains a request the site or its web server found too large', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.refuseUpdate = { code: 'tooLarge', message: 'Too big' };
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const error = await failure(service.updateConnector(site.id));

    expect(wordPressErrorCode(error)).toBe('updateRefused');
    expect(error.message).toMatch(/takes requests of about 8192 KB at most/);
  });

  it('keeps pulls and deploys off the site while it works, and one update at a time', async () => {
    fake.pluginVersion = '1.0.0';
    fake.switches.delayMs = 150;
    const { service } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });

    const first = service.updateConnector(site.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await failure(service.updateConnector(site.id));
    const pull = await failure(
      service.rollback({ operationId: 'op-during-update', siteId: site.id, deployId: 'dep-1' }),
    );

    expect(wordPressErrorCode(second)).toBe('operationBusy');
    expect(wordPressErrorCode(pull)).toBe('operationBusy');
    expect((await first).outcome).toBe('updated');
    expect(updateCalls()).toHaveLength(1);
  });

  it('recovers when the reply never arrives but the swap worked', async () => {
    fake.pluginVersion = '1.0.0';
    // The site applies the update, then the answer is lost on the way back.
    const lossy: typeof nodeTransport = async (request) => {
      const response = await nodeTransport(request);
      if (request.url.includes('connector/update') || request.url.includes('connector%2Fupdate')) {
        throw new WpRemoteError('timeout', 'The site took too long to answer.');
      }
      return response;
    };
    const { service } = make({ transport: lossy });
    const site = await service.connect({ connectionKey: fake.createKey() });

    const result = await service.updateConnector(site.id);

    expect(result).toMatchObject({ outcome: 'updated', fromVersion: '1.0.0', checks: [] });
    expect(fake.pluginVersion).toBe(WP_CONNECTOR_VERSION);
  });

  it('keeps the original timeout when the swap did not happen', async () => {
    fake.pluginVersion = '1.0.0';
    const lossy: typeof nodeTransport = async (request) => {
      if (request.url.includes('connector/update') || request.url.includes('connector%2Fupdate')) {
        throw new WpRemoteError('timeout', 'The site took too long to answer.');
      }
      return nodeTransport(request);
    };
    const { service } = make({ transport: lossy });
    const site = await service.connect({ connectionKey: fake.createKey() });

    expect(wordPressErrorCode(await failure(service.updateConnector(site.id)))).toBe('timeout');
    expect(fake.pluginVersion).toBe('1.0.0');
  });

  describe('when the site can download the release itself', () => {
    const releaseUrl = wpConnectorReleaseUrl(WP_CONNECTOR_VERSION);
    const released = () => ({ ...testConnectorBundle(), downloadUrl: releaseUrl });

    it('asks the site to download it and sends no files', async () => {
      fake.pluginVersion = '1.0.0';
      const { service, state } = make({ readConnectorBundle: async () => released() });
      const site = await service.connect({ connectionKey: fake.createKey() });

      const result = await service.updateConnector(site.id);

      expect(result).toMatchObject({ outcome: 'updated', fromVersion: '1.0.0', source: 'site' });
      expect(result.downloadProblem).toBeUndefined();
      expect(fake.downloads).toEqual([releaseUrl]);
      expect(fake.updates).toEqual([
        {
          version: WP_CONNECTOR_VERSION,
          files: ['agentmate-connector.php', 'readme.txt', 'src/Plugin.php'],
          state: 'updated',
          source: 'download',
          url: releaseUrl,
        },
      ]);
      expect(updateCalls()).toHaveLength(1);
      expect((await state.site(site.id))?.pluginVersion).toBe(WP_CONNECTOR_VERSION);
    });

    it('sends the files itself when the site could not download them, and says why', async () => {
      fake.pluginVersion = '1.0.0';
      fake.switches.downloadFails =
        'The site could not download the connector from GitHub (cURL error 28: Operation timed out).';
      const { service } = make({ readConnectorBundle: async () => released() });
      const site = await service.connect({ connectionKey: fake.createKey() });

      const result = await service.updateConnector(site.id);

      expect(result).toMatchObject({ outcome: 'updated', source: 'app' });
      expect(result.downloadProblem).toBe(
        'The site could not download the connector from GitHub (cURL error 28: Operation timed out).',
      );
      expect(fake.downloads).toEqual([releaseUrl]);
      expect(fake.updates.map((update) => update.source)).toEqual(['upload']);
      expect(updateCalls()).toHaveLength(2);
      expect(fake.pluginVersion).toBe(WP_CONNECTOR_VERSION);
    });

    it('sends the files when the download request never got an answer and nothing changed', async () => {
      fake.pluginVersion = '1.0.0';
      let calls = 0;
      const lossy: typeof nodeTransport = async (request) => {
        const update =
          request.url.includes('connector/update') || request.url.includes('connector%2Fupdate');
        if (update && ++calls === 1) {
          throw new WpRemoteError('timeout', 'The site took too long to answer.');
        }
        return nodeTransport(request);
      };
      const { service } = make({ transport: lossy, readConnectorBundle: async () => released() });
      const site = await service.connect({ connectionKey: fake.createKey() });

      const result = await service.updateConnector(site.id);

      expect(result).toMatchObject({ outcome: 'updated', source: 'app' });
      expect(result.downloadProblem).toContain('took too long');
      expect(fake.updates.map((update) => update.source)).toEqual(['upload']);
    });

    it('does not send the files again for a refusal they would meet too', async () => {
      fake.pluginVersion = '1.0.0';
      fake.switches.refuseUpdate = {
        code: 'updateRefused',
        message: 'AgentMate Connector 9.0.0 needs PHP 99.0 or newer, and this site runs 7.4.33.',
        details: { reason: 'requirements' },
      };
      const { service } = make({ readConnectorBundle: async () => released() });
      const site = await service.connect({ connectionKey: fake.createKey() });

      const error = await failure(service.updateConnector(site.id));

      expect(wordPressErrorCode(error)).toBe('updateRefused');
      expect(error.message).toContain('needs PHP 99.0 or newer');
      expect(updateCalls()).toHaveLength(1);
    });

    it('reports an update the site undid without sending the same files again', async () => {
      fake.pluginVersion = '1.0.0';
      fake.switches.updateHealthFails = true;
      const { service } = make({ readConnectorBundle: async () => released() });
      const site = await service.connect({ connectionKey: fake.createKey() });

      const result = await service.updateConnector(site.id);

      expect(result).toMatchObject({ outcome: 'rolledBack', source: 'site' });
      expect(updateCalls()).toHaveLength(1);
      expect(fake.pluginVersion).toBe('1.0.0');
    });

    it('sends the files straight away to a connector that cannot download', async () => {
      fake.pluginVersion = '1.0.0';
      fake.switches.updateDownload = false;
      const { service } = make({ readConnectorBundle: async () => released() });
      const site = await service.connect({ connectionKey: fake.createKey() });

      const result = await service.updateConnector(site.id);

      expect(result).toMatchObject({ outcome: 'updated', source: 'app' });
      expect(result.downloadProblem).toBeUndefined();
      expect(fake.downloads).toEqual([]);
      expect(updateCalls()).toHaveLength(1);
    });
  });
});

describe('a deploy left behind', () => {
  async function leftBehind(finish: 'done' | 'open' | 'applied' | 'gone') {
    const { service, state, bases } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    const client = await clientOf(service, site.id);
    let deployId = 'dep-missing';
    if (finish !== 'gone') {
      const bytes = Buffer.from('half');
      const begin = await client.call(WP_ROUTES.deployBegin, {
        label: 'Crash',
        items: [THEME],
        ops: [
          {
            op: 'put',
            item: THEME,
            path: 'style.css',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            expected: 'any',
          },
        ],
      });
      deployId = begin.data.deployId as string;
      if (finish !== 'open') {
        await client.call(
          WP_ROUTES.deployUpload,
          { deployId, chunks: [{ op: 0, offset: 0, final: true }] },
          { blobs: [bytes] },
        );
        await client.call(WP_ROUTES.deployCommit, { deployId });
        if (finish === 'done') await client.call(WP_ROUTES.deployFinalize, { deployId });
      }
    }
    const base = {
      version: 1 as const,
      siteId: site.id,
      sitePublicKey: fake.sitePublicKey,
      siteOrigin: new URL(fake.restUrl).origin,
      updatedAt: 1,
      items: {},
    };
    await bases.writePending('p1', base);
    await state.setInflight({
      siteId: site.id,
      deployId,
      projectId: 'p1',
      operationId: 'op-crashed-1',
      startedAt: 1,
    });
    await service.listItems(site.id);
    return { state, bases, siteId: site.id, deployId };
  }

  it('makes the pending base the base when the deploy finished', async () => {
    const { state, bases, siteId } = await leftBehind('done');
    expect(await state.inflight(siteId)).toBeNull();
    expect(await bases.read('p1')).not.toBeNull();
    expect(await bases.readPending('p1')).toBeNull();
  });

  it('aborts one still open and rolls back one applied', async () => {
    const open = await leftBehind('open');
    expect(fake.deploys.find((deploy) => deploy.id === open.deployId)?.state).toBe('aborted');
    expect(await open.bases.read('p1')).toBeNull();
    expect(await open.bases.readPending('p1')).toBeNull();
    expect(await open.state.inflight(open.siteId)).toBeNull();
  });

  it('rolls back an applied deploy and forgets an unknown one', async () => {
    const applied = await leftBehind('applied');
    expect(fake.deploys.find((deploy) => deploy.id === applied.deployId)?.state).toBe('rolledBack');
    expect(fake.file(THEME, 'style.css')).toBe('body{}');
    const gone = await leftBehind('gone');
    expect(await gone.state.inflight(gone.siteId)).toBeNull();
  });

  it('leaves it for next time when the check fails', async () => {
    const { service, state } = make();
    const site = await service.connect({ connectionKey: fake.createKey() });
    await state.setInflight({
      siteId: site.id,
      deployId: 'dep-1',
      projectId: null,
      operationId: 'op-crashed-2',
      startedAt: 1,
    });
    fake.switches.rateLimitNext = 8;
    await failure(service.listItems(site.id));
    expect(await state.inflight(site.id)).not.toBeNull();
  });
});

describe('wpMessagePath', () => {
  it('names files the way the project folder holds them', () => {
    expect(wpMessagePath(THEME, 'inc/a.php')).toBe('wp-content/themes/shop/inc/a.php');
    expect(wpMessagePath({ kind: 'plugin', slug: 'hello.php' }, 'hello.php')).toBe(
      'wp-content/plugins/hello.php',
    );
  });
});

describe('cleaning what a site says', () => {
  it('keeps only items it can sync, as plain text', () => {
    expect(cleanItem(null as never)).toBeNull();
    expect(cleanItem({ kind: 'widget', slug: 'x' } as never)).toBeNull();
    expect(cleanItem({ kind: 'theme', slug: '../x' } as never)).toBeNull();
    expect(
      cleanItem({
        kind: 'theme',
        slug: 'child',
        name: '',
        version: 7,
        isFile: 'yes',
        parentTheme: 'parent',
        mainFile: '',
      } as never),
    ).toEqual({
      kind: 'theme',
      slug: 'child',
      name: 'child',
      version: '',
      isFile: false,
      active: false,
      networkActive: false,
      writable: false,
      protected: false,
      parentTheme: 'parent',
    });
    expect(
      cleanItem({ kind: 'plugin', slug: 'p', mainFile: 'p/p.php', parentTheme: '../x' } as never),
    ).toMatchObject({ mainFile: 'p/p.php' });
  });

  it('fills in site info that is missing or odd', () => {
    const info = cleanInfo({ siteName: `A${String.fromCharCode(0x202e)}B` } as never);
    expect(info.siteName).toBe('A B');
    expect(info.activeTheme).toEqual({ stylesheet: '', template: '' });
    expect(info.guard).toEqual({ installed: false, rescueUrl: null });
    expect(info.connection.label).toBe('');
    // A real boolean is kept; no field (an old connector) and an odd value both stay unknown.
    expect(info.selfUpdate).toBeUndefined();
    expect(cleanInfo({ selfUpdate: true } as never).selfUpdate).toBe(true);
    expect(cleanInfo({ selfUpdate: false } as never).selfUpdate).toBe(false);
    expect(cleanInfo({ selfUpdate: 'yes' } as never).selfUpdate).toBeUndefined();
  });

  it('lists the files behind a rollback conflict', () => {
    const error = new WpRemoteError(
      'conflict',
      'Changed.',
      {
        conflicts: [
          { item: THEME, path: 'style.css' },
          { item: { kind: 'plugin', slug: 'hello.php' }, path: 'hello.php' },
          { item: { kind: 'widget', slug: 'x' }, path: 'a' },
          null,
        ],
      },
      409,
    );
    expect((conflictMessage(error) as Error).message).toBe(
      [
        '[wp:conflict] 2 files changed on the site since this deploy.',
        'wp-content/themes/shop/style.css: changed on the site since this deploy',
        'wp-content/plugins/hello.php: changed on the site since this deploy',
      ].join(String.fromCharCode(10)),
    );
    const one = new WpRemoteError('conflict', 'Changed.', {
      conflicts: [{ item: THEME, path: 'a.css' }],
    });
    expect((conflictMessage(one) as Error).message).toContain('1 file changed');
    const bare = new WpRemoteError('conflict', 'Changed.');
    expect(conflictMessage(bare)).toBe(bare);
    const other = new Error('x');
    expect(conflictMessage(other)).toBe(other);
  });
});
