import { parse } from 'yaml';
import { LEGACY_CATALOG_EXTENSION_KEY } from '../deployLegacyNames.js';
import { findCatalogTemplate } from './index.js';
import { CATALOG_EXTENSION_KEY, type CatalogRender, renderCatalogApp } from './render.js';
import { generateCatalogSecrets } from './secrets.js';
import type { AnyCatalogTemplate, RenderedCatalogFact } from './types.js';
import type { InstalledCatalogApp } from './updates.js';

/**
 * An app after its install: what its compose file says it is (the `x-runova` block the
 * renderer writes), what it runs, its facts with the secrets masked or filled in, and the compose
 * file of an update. The secrets themselves stay on the server, in the stack's .env: an update
 * sends a new compose file only and keeps the .env the server has.
 */

export interface CatalogInstall {
  template: AnyCatalogTemplate;
  /** The version id it was installed with. It may no longer be listed (a retired line). */
  version: string;
  params: Record<string, unknown>;
  domain: string | null;
  /** What each image role runs, for checkCatalogUpdate. */
  installed: InstalledCatalogApp;
}

export type CatalogInstallRead =
  | { ok: true; install: CatalogInstall }
  | { ok: false; reason: string; notCatalog?: true };

const NOT_CATALOG = 'This app was not installed from the App Store.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Compose reads `$$` as `$`; the block is read raw, so it is undone here. */
const undoEscape = (value: unknown): unknown =>
  typeof value === 'string' ? value.replaceAll('$$', '$') : value;

/** `repository:tag@sha256:...` as the renderer writes it. */
function splitReference(reference: string): { tag: string; digest: string } | null {
  const match = /^[^@\s]+:([^:@/\s]+)@(sha256:[0-9a-f]{64})$/.exec(reference);
  return match ? { tag: match[1], digest: match[2] } : null;
}

/** Throwaway secrets, so a render can run without the real ones. Never shown. */
function standIns(template: AnyCatalogTemplate): Record<string, string> {
  return generateCatalogSecrets(template.secrets);
}

export function readCatalogInstall(
  compose: string,
  find: (id: string) => AnyCatalogTemplate | null = findCatalogTemplate,
): CatalogInstallRead {
  let document: unknown;
  try {
    document = parse(compose);
  } catch {
    return { ok: false, reason: 'The compose file is not valid YAML.' };
  }
  if (!isRecord(document)) return { ok: false, reason: NOT_CATALOG, notCatalog: true };
  // Apps installed before the rename carry the block under its old key.
  const block = document[CATALOG_EXTENSION_KEY] ?? document[LEGACY_CATALOG_EXTENSION_KEY];
  const catalog = isRecord(block) ? block.catalog : undefined;
  if (!isRecord(catalog)) return { ok: false, reason: NOT_CATALOG, notCatalog: true };
  const { template: id, version, params, domain } = catalog;
  if (typeof id !== 'string' || typeof version !== 'string' || !isRecord(params)) {
    return { ok: false, reason: 'The App Store block in the compose file is damaged.' };
  }
  const template = find(id);
  if (!template) {
    return { ok: false, reason: `The App Store no longer has the app ${JSON.stringify(id)}.` };
  }

  const read = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, undoEscape(value)]),
  );
  const services = isRecord(document.services) ? document.services : {};
  const images: Record<string, { tag: string; digest: string }> = {};
  // Which service runs which role comes from the template, built again with the same choices.
  const pinned = template.versions.find((candidate) => candidate.id === version);
  const parsed = template.parameters.safeParse(read);
  if (!parsed.success) {
    return { ok: false, reason: 'The App Store block in the compose file is damaged.' };
  }
  if (pinned) {
    const secrets = standIns(template);
    const roles = template.build({
      version: pinned,
      params: parsed.data,
      publicUrl: typeof domain === 'string' ? `https://${domain}` : null,
      secret: (key: string) => secrets[key] ?? '',
    }).services;
    for (const [service, spec] of Object.entries(roles)) {
      const running = services[service];
      const reference = isRecord(running) ? running.image : undefined;
      const split = typeof reference === 'string' ? splitReference(reference) : null;
      if (split) images[spec.image] = split;
    }
  }
  return {
    ok: true,
    install: {
      template,
      version,
      params: read,
      domain: typeof domain === 'string' && domain !== '' ? domain : null,
      installed: { version, images },
    },
  };
}

function renderInstall(
  install: CatalogInstall,
  version: string,
  secrets: Readonly<Record<string, string>>,
) {
  return renderCatalogApp(install.template, {
    version,
    params: install.params,
    secrets,
    domain: install.domain,
  });
}

export type CatalogInstallFacts =
  | {
      ok: true;
      facts: RenderedCatalogFact[];
      ports: CatalogRender['ports'];
      web: CatalogRender['web'];
      publicUrl: string | null;
    }
  | { ok: false; reason: string };

/**
 * The install's facts. With the secrets (revealed from the server, or still held right after an
 * install) every value is filled in; without them `value` is the masked text too, so nothing
 * made up ever reaches the screen.
 */
export function catalogInstallFacts(
  install: CatalogInstall,
  secrets: Readonly<Record<string, string>> | null,
): CatalogInstallFacts {
  const result = renderInstall(install, install.version, secrets ?? standIns(install.template));
  if (!result.ok) return { ok: false, reason: result.reason };
  const { render } = result;
  return {
    ok: true,
    facts: secrets ? render.facts : render.facts.map((fact) => ({ ...fact, value: fact.masked })),
    ports: render.ports,
    web: render.web,
    publicUrl: render.publicUrl,
  };
}

export type CatalogUpdateRender =
  | {
      ok: true;
      version: string;
      compose: string;
      /** The secrets the new compose file reads; the server's .env must have every one. */
      envKeys: string[];
      /** The template's acknowledgments that match a finding of the new file. */
      acknowledged: string[];
      unacknowledged: CatalogRender['unacknowledged'];
    }
  | { ok: false; reason: string };

/** The compose file of the same install on another version (or the same, with new digests). */
export function renderCatalogUpdate(install: CatalogInstall, version: string): CatalogUpdateRender {
  const result = renderInstall(install, version, standIns(install.template));
  if (!result.ok) return { ok: false, reason: result.reason };
  const { render } = result;
  return {
    ok: true,
    version: render.version.id,
    compose: render.compose,
    envKeys: Object.keys(render.env),
    acknowledged: catalogAcknowledged(install.template, render),
    unacknowledged: render.unacknowledged,
  };
}

/** The template's acknowledgments that match a finding of this render, as an upload sends them. */
export function catalogAcknowledged(
  template: AnyCatalogTemplate,
  render: Pick<CatalogRender, 'risks'>,
): string[] {
  const found = new Set(render.risks.map((risk) => risk.id));
  return template.acknowledgments.map((item) => item.id).filter((id) => found.has(id));
}
