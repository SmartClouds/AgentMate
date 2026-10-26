import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CATALOG_TEMPLATES } from './index.js';
import { catalogImageReference, renderCatalogApp } from './render.js';
import { generateCatalogSecrets } from './secrets.js';
import type { AnyCatalogTemplate } from './types.js';

/**
 * Every template, in every version and with every toggle, read by Docker Compose itself:
 * `docker compose config` checks the file the way `up` would, without pulling or starting
 * anything. Skipped where Docker Compose is not installed.
 */
const compose =
  spawnSync('docker', ['compose', 'version', '--short'], {
    encoding: 'utf8',
    timeout: 30_000,
  }).status === 0;

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** The environment Compose runs with: ours, minus anything that could change what it reads. */
function composeEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('COMPOSE_') && !Object.hasOwn(env, name)) out[name] = value;
  }
  return out;
}

function toggleCombinations(template: AnyCatalogTemplate): Record<string, boolean>[] {
  const defaults = template.parameters.parse({}) as Record<string, unknown>;
  const toggles = Object.keys(defaults).filter((key) => typeof defaults[key] === 'boolean');
  return Array.from({ length: 2 ** toggles.length }, (_, mask) =>
    Object.fromEntries(toggles.map((key, bit) => [key, (mask & (1 << bit)) !== 0])),
  );
}

const CASES = CATALOG_TEMPLATES.flatMap((template) =>
  template.versions.flatMap((version) =>
    toggleCombinations(template).map((params) => ({
      template,
      version: version.id,
      params,
      label: `${template.id} ${version.id} ${JSON.stringify(params)}`,
    })),
  ),
);

interface ConfigService {
  image: string;
  environment?: Record<string, string>;
  ports?: { host_ip?: string; target: number; published?: string }[];
}

describe.runIf(compose)('docker compose config accepts every catalog template', () => {
  it.each(CASES.map((item) => [item.label, item] as const))(
    '%s',
    { timeout: 120_000 },
    (_, item) => {
      const secrets = generateCatalogSecrets(item.template.secrets);
      const result = renderCatalogApp(item.template, {
        version: item.version,
        params: item.params,
        secrets,
        domain: 'apps.example.com',
      });
      if (!result.ok) throw new Error(result.reason);
      const { render } = result;

      const folder = mkdtempSync(join(tmpdir(), 'runova-e12-catalog-'));
      folders.push(folder);
      writeFileSync(join(folder, 'compose.yaml'), render.compose);
      writeFileSync(join(folder, '.env'), render.envFile);
      const output = execFileSync(
        'docker',
        ['compose', '--project-name', `e12-${item.template.id}`, 'config', '--format', 'json'],
        {
          cwd: folder,
          encoding: 'utf8',
          env: composeEnvironment(render.env),
          timeout: 90_000,
        },
      );
      const services: Record<string, ConfigService> = JSON.parse(output).services;

      const version = item.template.versions.find((candidate) => candidate.id === item.version);
      const pinned = Object.values(version?.images ?? {}).map(catalogImageReference);
      expect(Object.keys(services).sort()).toEqual(
        render.images.map((image) => image.service).sort(),
      );
      for (const [name, service] of Object.entries(services)) {
        expect(pinned, name).toContain(service.image);
        for (const port of service.ports ?? []) {
          expect(port.host_ip, `${name} ${port.target}`).toBe('127.0.0.1');
        }
      }
      // The secrets Compose resolved from .env are the ones generated, character for character.
      const resolved = new Set(
        Object.values(services).flatMap((service) => Object.values(service.environment ?? {})),
      );
      for (const [key, value] of Object.entries(render.env)) {
        expect(resolved.has(value), key).toBe(true);
      }
    },
  );
});
