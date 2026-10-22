import { describe, expect, it } from 'vitest';
import { lintComposeProject, unacknowledgedRisks } from '../compose/lint.js';
import { parseComposeFile } from '../compose/parse.js';
import { analyzeComposePorts } from '../compose/ports.js';
import { validateEnvKey } from '../validation.js';
import { CATALOG_TEMPLATES, findCatalogTemplate } from './index.js';
import { catalogImageReference, renderCatalogApp } from './render.js';
import { generateCatalogSecrets } from './secrets.js';
import type { AnyCatalogTemplate } from './types.js';
import { compareCatalogTags } from './updates.js';

const EXPECTED = [
  'mysql',
  'mariadb',
  'postgres',
  'redis',
  'mongodb',
  'wordpress',
  'ghost',
  'ollama',
  'n8n',
  'uptime-kuma',
  'adminer',
  'phpmyadmin',
  'gitea',
  'grafana',
  'prometheus',
  'nextcloud',
  'meilisearch',
  'rabbitmq',
  'kafka',
];

/** Every on/off combination of a template's toggles, so each branch of its build is rendered. */
function toggleCombinations(template: AnyCatalogTemplate): Record<string, boolean>[] {
  const defaults = template.parameters.parse({}) as Record<string, unknown>;
  const toggles = Object.keys(defaults).filter((key) => typeof defaults[key] === 'boolean');
  return Array.from({ length: 2 ** toggles.length }, (_, mask) =>
    Object.fromEntries(toggles.map((key, bit) => [key, (mask & (1 << bit)) !== 0])),
  );
}

interface Case {
  template: AnyCatalogTemplate;
  version: string;
  params: Record<string, unknown>;
  domain: string | null;
  label: string;
}

const CASES: Case[] = CATALOG_TEMPLATES.flatMap((template) =>
  template.versions.flatMap((version) =>
    toggleCombinations(template).flatMap((params) =>
      [null, 'apps.example.com'].map((domain) => ({
        template,
        version: version.id,
        params,
        domain,
        label: `${template.id} ${version.id} ${JSON.stringify(params)} ${domain ?? 'no domain'}`,
      })),
    ),
  ),
);

function render(item: Case, secrets = generateCatalogSecrets(item.template.secrets)) {
  const result = renderCatalogApp(item.template, {
    version: item.version,
    params: item.params,
    secrets,
    domain: item.domain,
  });
  if (!result.ok) throw new Error(`${item.label}: ${result.reason}`);
  return { render: result.render, secrets };
}

/** Every string anywhere in a value, functions and zod schemas left out. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'parameters') strings(item, out);
    }
  }
  return out;
}

describe('the app catalog', () => {
  it('lists the apps of the App Store epic, each once', () => {
    expect(CATALOG_TEMPLATES.map((template) => template.id)).toEqual(EXPECTED);
    expect(findCatalogTemplate('postgres')?.name).toBe('PostgreSQL');
    expect(findCatalogTemplate('nope')).toBeNull();
  });

  it('describes every app in one plain line', () => {
    for (const template of CATALOG_TEMPLATES) {
      expect(template.name.length, template.id).toBeGreaterThan(1);
      expect(template.description, template.id).toMatch(/^[A-Z][^\n]{20,140}\.$/);
      expect(template.homepage, template.id).toMatch(/^https:\/\//);
      expect(template.minMemoryMb, template.id).toBeGreaterThan(0);
      for (const [key, field] of Object.entries(template.fields)) {
        expect(field.label, `${template.id}.${key}`).not.toBe('');
        expect(field.help, `${template.id}.${key}`).toMatch(/\.$/);
      }
      for (const secret of template.secrets) {
        expect(validateEnvKey(secret.key).ok, secret.key).toBe(true);
      }
    }
  });

  it('never uses an em dash, in the templates or in what they render', () => {
    const texts = CATALOG_TEMPLATES.flatMap((template) => strings(template));
    for (const item of CASES) {
      const { render: out } = render(item);
      texts.push(out.compose, ...out.facts.flatMap((fact) => [fact.label, fact.value]));
    }
    expect(texts.filter((text) => text.includes('—'))).toEqual([]);
  });

  it('pins every image by tag and digest, from official or vendor namespaces only', () => {
    for (const template of CATALOG_TEMPLATES) {
      expect(template.versions.length, template.id).toBeGreaterThan(0);
      for (const version of template.versions) {
        for (const image of Object.values(version.images)) {
          const reference = catalogImageReference(image);
          expect(image.digest, reference).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(image.tag, reference).not.toMatch(/^(latest|stable|main|nightly)$/);
          expect(image.platforms, reference).toEqual(['linux/amd64', 'linux/arm64']);
          expect(image.resolvedAt, reference).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          if (image.source === 'docker-official') {
            expect(image.repository, reference).toMatch(/^docker\.io\/library\/[a-z0-9-]+$/);
          } else {
            expect(image.repository, reference).toMatch(/^(docker\.io|ghcr\.io)\/[a-z0-9-]+\//);
          }
        }
      }
    }
  });

  it('lists versions newest first, which the update check relies on', () => {
    for (const template of CATALOG_TEMPLATES) {
      for (let i = 1; i < template.versions.length; i++) {
        const [newer, older] = [template.versions[i - 1].id, template.versions[i].id];
        expect(
          compareCatalogTags(newer, older),
          `${template.id} ${newer} ${older}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('gives each app its own default host ports, so several can be installed side by side', () => {
    const owners = new Map<number, string>();
    for (const template of CATALOG_TEMPLATES) {
      const { render: out } = render({
        template,
        version: template.defaultVersion,
        params: {},
        domain: null,
        label: template.id,
      });
      for (const port of out.ports) {
        expect(owners.get(port.published), `${template.id} ${port.published}`).toBeUndefined();
        owners.set(port.published, template.id);
      }
    }
  });
});

describe.each(CASES.map((item) => [item.label, item] as const))('%s', (_, item) => {
  it('renders hardened compose with loopback ports, pinned images and no lint findings left', () => {
    const { render: out } = render(item);
    expect(out.unacknowledged).toEqual([]);
    const parsed = parseComposeFile(out.compose, { environment: out.env });
    if (!parsed.ok) throw new Error(parsed.reason);
    const { project } = parsed;
    expect(project.missingVariables).toEqual([]);
    const strict = lintComposeProject(project, { selinuxEnforcing: true });
    expect(
      unacknowledgedRisks(
        strict,
        item.template.acknowledgments.map((acknowledgment) => acknowledgment.id),
      ),
    ).toEqual([]);

    const version = item.template.versions.find((candidate) => candidate.id === item.version);
    const pinned = Object.values(version?.images ?? {}).map(catalogImageReference);
    for (const { name, definition } of project.services) {
      expect(pinned, name).toContain(definition.image);
      expect(definition.restart, name).toBe('unless-stopped');
      expect(definition.security_opt, name).toEqual(['no-new-privileges:true']);
      expect(definition.privileged, name).toBeUndefined();
      expect(definition.network_mode, name).toBeUndefined();
      expect(definition.cap_add, name).toBeUndefined();
      for (const volume of (definition.volumes as string[] | undefined) ?? []) {
        expect(volume, name).toMatch(/^[a-z][a-z0-9_-]*:\/[^:]*$/);
      }
    }
    for (const ports of analyzeComposePorts(project)) {
      expect(ports.problems, ports.service).toEqual([]);
      for (const binding of ports.bindings) {
        expect(binding.exposure, `${ports.service} ${binding.target}`).toBe('loopback');
      }
    }
    expect(out.web === null || out.web.service in (project.data.services as object)).toBe(true);
  });

  it('keeps every secret out of the compose file and in the env', () => {
    const { render: out, secrets } = render(item);
    for (const [key, value] of Object.entries(secrets)) {
      expect(out.compose, key).not.toContain(value);
    }
    for (const key of Object.keys(out.env)) {
      expect(out.compose, key).toContain(`\${${key}:?`);
      expect(out.env[key]).toBe(secrets[key]);
    }
    const referenced = [...out.compose.matchAll(/\$\{([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(new Set(referenced)).toEqual(new Set(Object.keys(out.env)));
    for (const fact of out.facts) {
      for (const value of Object.values(out.env)) {
        if (fact.sensitive) expect(fact.masked, fact.id).not.toContain(value);
        else expect(fact.value, fact.id).not.toContain(value);
      }
    }
    expect(out.facts.length).toBeGreaterThan(0);
  });

  it('renders the same bytes for the same inputs', () => {
    const { render: first, secrets } = render(item);
    const { render: second } = render(item, { ...secrets });
    expect(second.compose).toBe(first.compose);
    expect(second.envFile).toBe(first.envFile);
  });
});

describe('database tools', () => {
  it.each(['adminer', 'phpmyadmin'])('%s joins another app network when asked', (id) => {
    const template = findCatalogTemplate(id) as AnyCatalogTemplate;
    const result = renderCatalogApp(template, {
      secrets: {},
      params: { network: 'mysql_default', server: 'mysql' },
    });
    if (!result.ok) throw new Error(result.reason);
    const parsed = parseComposeFile(result.render.compose);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.project.data.networks).toEqual({
      mysql_default: { name: 'mysql_default', external: true },
    });
    expect(parsed.project.services[0].definition.networks).toEqual(['default', 'mysql_default']);
    expect(result.render.unacknowledged).toEqual([]);
    expect(result.render.facts.find((fact) => fact.id === 'network')?.value).toBe('mysql_default');

    const refused = renderCatalogApp(template, { secrets: {}, params: { network: 'a b' } });
    expect(refused).toMatchObject({ ok: false, field: 'network' });
  });
});

describe('generated secrets', () => {
  it('are never the same twice, across installs and within one', () => {
    const seen = new Map<string, string>();
    for (const template of CATALOG_TEMPLATES) {
      for (let install = 0; install < 3; install++) {
        for (const [key, value] of Object.entries(generateCatalogSecrets(template.secrets))) {
          const where = `${template.id}#${install}.${key}`;
          expect(seen.get(value), where).toBeUndefined();
          seen.set(value, where);
        }
      }
    }
  });

  it('render for every template, and a missing one is refused', () => {
    for (const template of CATALOG_TEMPLATES) {
      if (template.secrets.length === 0) continue;
      const result = renderCatalogApp(template, { secrets: {} });
      expect(result.ok, template.id).toBe(false);
    }
  });
});

describe('acknowledgments', () => {
  it('each match a finding a template really has, with a reason', () => {
    for (const template of CATALOG_TEMPLATES) {
      const found = new Set(
        CASES.filter((item) => item.template === template).flatMap((item) =>
          render(item).render.risks.map((risk) => risk.id),
        ),
      );
      for (const acknowledgment of template.acknowledgments) {
        expect(found.has(acknowledgment.id), `${template.id} ${acknowledgment.id}`).toBe(true);
        expect(acknowledgment.reason.length).toBeGreaterThan(20);
      }
    }
  });
});
