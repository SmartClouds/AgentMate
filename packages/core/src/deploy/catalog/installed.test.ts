import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseComposeFile } from '../compose/parse.js';
import { LEGACY_CATALOG_EXTENSION_KEY } from '../deployLegacyNames.js';
import { findCatalogTemplate } from './index.js';
import {
  catalogAcknowledged,
  catalogInstallFacts,
  readCatalogInstall,
  renderCatalogUpdate,
} from './installed.js';
import { CATALOG_EXTENSION_KEY, renderCatalogApp } from './render.js';
import { generateCatalogSecrets } from './secrets.js';
import type { AnyCatalogTemplate } from './types.js';

/**
 * An installed app is known by the block its compose file carries: which template, version,
 * parameters and domain it was installed with. Everything after the install (the post-install
 * card, the update check, the next revision) reads it back from the stack's files.
 */

function template(id: string): AnyCatalogTemplate {
  const found = findCatalogTemplate(id);
  if (!found) throw new Error(`no template ${id}`);
  return found;
}

function install(id: string, input: Partial<Parameters<typeof renderCatalogApp>[1]> = {}) {
  const t = template(id);
  const secrets = input.secrets ?? generateCatalogSecrets(t.secrets);
  const result = renderCatalogApp(t, { ...input, secrets });
  if (!result.ok) throw new Error(result.reason);
  return { render: result.render, secrets };
}

describe('the catalog block in the compose file', () => {
  it('records the template, version, parameters and domain, with no secret in it', () => {
    const { render, secrets } = install('postgres', {
      version: '17',
      params: { port: 15433, database: 'shop' },
      domain: null,
    });
    const block = parse(render.compose)[CATALOG_EXTENSION_KEY];
    expect(block).toEqual({
      catalog: {
        template: 'postgres',
        version: '17',
        params: expect.objectContaining({ port: 15433, database: 'shop' }),
      },
    });
    for (const value of Object.values(secrets)) expect(render.compose).not.toContain(value);
  });

  it('is accepted by the compose parser and leaves the linter quiet', () => {
    const { render } = install('wordpress', { domain: 'blog.example.com' });
    const parsed = parseComposeFile(render.compose, { environment: render.env });
    expect(parsed.ok).toBe(true);
    expect(render.unacknowledged).toEqual([]);
  });
});

describe('readCatalogInstall', () => {
  it('reads back what was installed, with the images each role runs', () => {
    const { render } = install('wordpress', {
      params: { port: 18081 },
      domain: 'blog.example.com',
    });
    const read = readCatalogInstall(render.compose);
    if (!read.ok) throw new Error(read.reason);
    expect(read.install.template.id).toBe('wordpress');
    expect(read.install.version).toBe(render.version.id);
    expect(read.install.params).toEqual(render.params);
    expect(read.install.domain).toBe('blog.example.com');
    const pinned = render.version.images;
    expect(read.install.installed).toEqual({
      version: render.version.id,
      images: Object.fromEntries(
        Object.entries(pinned).map(([role, image]) => [
          role,
          { tag: image.tag, digest: image.digest },
        ]),
      ),
    });
  });

  it('reads an app installed before the rename, whose block has the old key', () => {
    const { render } = install('wordpress', {
      params: { port: 18081 },
      domain: 'blog.example.com',
    });
    const old = render.compose.replace(
      `${CATALOG_EXTENSION_KEY}:`,
      `${LEGACY_CATALOG_EXTENSION_KEY}:`,
    );
    expect(old).not.toBe(render.compose);
    const read = readCatalogInstall(old);
    if (!read.ok) throw new Error(read.reason);
    expect(read.install.template.id).toBe('wordpress');
    expect(read.install.domain).toBe('blog.example.com');
  });

  it('says plainly when a compose file is not from the App Store', () => {
    expect(readCatalogInstall('services:\n  web:\n    image: nginx\n')).toEqual({
      ok: false,
      reason: 'This app was not installed from the App Store.',
      notCatalog: true,
    });
  });

  it('refuses a block naming an unknown template or version', () => {
    const { render } = install('redis');
    const unknown = render.compose.replace('template: "redis"', 'template: "nope"');
    const read = readCatalogInstall(unknown);
    expect(read.ok).toBe(false);
    const retired = readCatalogInstall(render.compose.replace('version: "8.10"', 'version: "1"'));
    // A version no longer listed still reads, so the card can say the line was retired.
    if (!retired.ok) throw new Error(retired.reason);
    expect(retired.install.version).toBe('1');
  });

  it('refuses a damaged block, and a file that is not a mapping', () => {
    const { render } = install('redis');
    expect(readCatalogInstall(render.compose.replace('template: "redis"', 'template: 7')).ok).toBe(
      false,
    );
    expect(readCatalogInstall(render.compose.replace('port: 6379', 'port: "x"')).ok).toBe(false);
    expect(readCatalogInstall('- a\n- b\n')).toMatchObject({ ok: false, notCatalog: true });
    expect(readCatalogInstall('x-runova: 3\n')).toMatchObject({ ok: false, notCatalog: true });
  });

  it('leaves out an image it cannot read, so the update check offers it', () => {
    const { render } = install('redis');
    const read = readCatalogInstall(render.compose.replace(/image: "[^"]+"/, 'image: "redis"'));
    if (!read.ok) throw new Error(read.reason);
    expect(read.install.installed.images).toEqual({});
  });

  it('refuses text that is not YAML', () => {
    expect(readCatalogInstall('services: [').ok).toBe(false);
  });
});

describe('catalogInstallFacts', () => {
  it('masks every secret when the values are not known', () => {
    const { render, secrets } = install('redis', { params: { port: 16380 } });
    const read = readCatalogInstall(render.compose);
    if (!read.ok) throw new Error(read.reason);
    const facts = catalogInstallFacts(read.install, null);
    if (!facts.ok) throw new Error(facts.reason);
    const url = facts.facts.find((fact) => fact.id === 'url');
    expect(url?.masked).toBe('redis://:********@127.0.0.1:16380/0');
    expect(url?.value).toBe(url?.masked);
    for (const value of Object.values(secrets)) {
      expect(JSON.stringify(facts.facts)).not.toContain(value);
    }
  });

  it('fills the real values in once they are revealed', () => {
    const { render, secrets } = install('redis');
    const read = readCatalogInstall(render.compose);
    if (!read.ok) throw new Error(read.reason);
    const facts = catalogInstallFacts(read.install, secrets);
    if (!facts.ok) throw new Error(facts.reason);
    expect(facts.facts.find((fact) => fact.id === 'password')?.value).toBe(secrets.REDIS_PASSWORD);
    expect(facts.web).toBeNull();
    expect(facts.ports[0]).toMatchObject({ hostIp: '127.0.0.1', target: 6379 });
  });
});

describe('renderCatalogUpdate', () => {
  it('renders the newer line with the same parameters and no env to send', () => {
    const { render } = install('postgres', { version: '17', params: { port: 15434 } });
    const read = readCatalogInstall(render.compose);
    if (!read.ok) throw new Error(read.reason);
    const update = renderCatalogUpdate(read.install, '18');
    if (!update.ok) throw new Error(update.reason);
    expect(update.compose).toContain('"18"');
    expect(update.compose).toContain('127.0.0.1:15434:5432');
    expect(update.envKeys).toEqual(Object.keys(render.env));
    expect(update.unacknowledged).toEqual([]);
    const reread = readCatalogInstall(update.compose);
    if (!reread.ok) throw new Error(reread.reason);
    expect(reread.install.version).toBe('18');
  });

  it('says why facts cannot be rendered for a retired version', () => {
    const { render } = install('redis');
    const read = readCatalogInstall(render.compose.replace('version: "8.10"', 'version: "1"'));
    if (!read.ok) throw new Error(read.reason);
    expect(catalogInstallFacts(read.install, null).ok).toBe(false);
  });

  it('refuses a version the template does not have', () => {
    const { render } = install('redis');
    const read = readCatalogInstall(render.compose);
    if (!read.ok) throw new Error(read.reason);
    expect(renderCatalogUpdate(read.install, '99').ok).toBe(false);
  });
});

describe('catalogAcknowledged', () => {
  it('keeps the acknowledgments that match a finding of the render', () => {
    const template = { ...(findCatalogTemplate('redis') as AnyCatalogTemplate) };
    template.acknowledgments = [
      { id: 'privileged:redis', reason: 'needed' },
      { id: 'host-pid:redis', reason: 'not found' },
    ];
    const risks = [{ id: 'privileged:redis' }] as Parameters<
      typeof catalogAcknowledged
    >[1]['risks'];
    expect(catalogAcknowledged(template, { risks })).toEqual(['privileged:redis']);
  });
});
