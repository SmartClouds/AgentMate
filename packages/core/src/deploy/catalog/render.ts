import { Document } from 'yaml';
import { type ComposeRisk, lintComposeProject, unacknowledgedRisks } from '../compose/lint.js';
import { parseComposeFile } from '../compose/parse.js';
import { renderComposeEnv } from '../env/composeEnv.js';
import { validateDomain } from '../validation.js';
import { checkCatalogSecret } from './secrets.js';
import type {
  AnyCatalogTemplate,
  CatalogEnvValue,
  CatalogServiceSpec,
  CatalogVersion,
  RenderedCatalogFact,
} from './types.js';

/**
 * Turns a template and the choices made in the install sheet into the files a stack deploys
 * with: the compose file and the .env beside it. The same inputs always give the same bytes, so a
 * reinstall with stored parameters and secrets reproduces the files exactly.
 *
 * Every service gets the same baseline: the image pinned by tag and digest, restart:
 * unless-stopped, no-new-privileges, a healthcheck, named volumes only, and its ports bound to
 * 127.0.0.1 (public access goes through the proxy). Secrets never appear in the compose file. It
 * reads them as `${KEY:?...}` from the .env, so Compose refuses to start without them rather than
 * starting with an empty password.
 */

export const CATALOG_MASKED_SECRET = '********';

const LOOPBACK = '127.0.0.1';

export interface CatalogInstallInput {
  /** A version id from the template, or its default. */
  version?: string;
  /** Values for the template's parameters; missing ones take their defaults. */
  params?: Record<string, unknown>;
  /** Every secret by env key, usually from generateCatalogSecrets. */
  secrets: Readonly<Record<string, string>>;
  /** The domain the app goes on, when it does. */
  domain?: string | null;
}

export interface RenderedCatalogPort {
  service: string;
  label: string;
  hostIp: string;
  published: number;
  target: number;
  protocol: 'tcp' | 'udp';
}

export interface CatalogRender {
  templateId: string;
  version: CatalogVersion;
  /** The parameters with defaults filled in, as they should be stored with the install. */
  params: Record<string, unknown>;
  compose: string;
  /** The secrets this install uses, by env key. Everything else is written into the compose file. */
  env: Record<string, string>;
  /** `env` as a .env file Compose reads back exactly. */
  envFile: string;
  images: { service: string; role: string; reference: string }[];
  ports: RenderedCatalogPort[];
  volumes: string[];
  web: { service: string; port: number } | null;
  publicUrl: string | null;
  facts: RenderedCatalogFact[];
  /** Every finding of the compose linter. */
  risks: ComposeRisk[];
  /** The findings the template has no acknowledgment for. Empty for every catalog template. */
  unacknowledged: ComposeRisk[];
}

export type CatalogRenderResult =
  | { ok: true; render: CatalogRender }
  | { ok: false; reason: string; field?: string };

const refuse = (reason: string, field?: string): CatalogRenderResult =>
  field === undefined ? { ok: false, reason } : { ok: false, reason, field };

/** The reference Compose pulls: repository, tag and digest. */
export function catalogImageReference(image: {
  repository: string;
  tag: string;
  digest: string;
}): string {
  return `${image.repository}:${image.tag}@${image.digest}`;
}

const secretReference = (key: string) => `\${${key}:?${key} is missing from the .env file}`;

/** Compose interpolates the file, so a literal `$` is written as `$$`. */
const literal = (text: string) => text.replaceAll('$', '$$$$');

function envValue(value: CatalogEnvValue, inUse: (key: string) => boolean): string {
  if (typeof value === 'string') return literal(value);
  if (!inUse(value.secret)) {
    throw new Error(`The secret ${value.secret} is used but not declared as in use.`);
  }
  return secretReference(value.secret);
}

function serviceYaml(
  name: string,
  spec: CatalogServiceSpec,
  version: CatalogVersion,
  inUse: (key: string) => boolean,
): Record<string, unknown> {
  const image = version.images[spec.image];
  if (!image) throw new Error(`${name} uses the image ${spec.image}, which ${version.id} lacks.`);
  const out: Record<string, unknown> = { image: catalogImageReference(image) };
  if (spec.hostname) out.hostname = spec.hostname;
  if (spec.user) out.user = spec.user;
  if (spec.command) out.command = [...spec.command];
  out.restart = 'unless-stopped';
  out.security_opt = ['no-new-privileges:true'];
  if (spec.environment) {
    out.environment = Object.fromEntries(
      Object.entries(spec.environment).map(([key, value]) => [key, envValue(value, inUse)]),
    );
  }
  if (spec.ports?.length) {
    out.ports = spec.ports.map(
      (port) =>
        `${LOOPBACK}:${port.published}:${port.target}${port.protocol === 'udp' ? '/udp' : ''}`,
    );
  }
  if (spec.volumes?.length) {
    out.volumes = spec.volumes.map(({ volume, target }) => `${volume}:${target}`);
  }
  if (spec.dependsOn?.length) {
    out.depends_on = Object.fromEntries(
      spec.dependsOn.map((service) => [service, { condition: 'service_healthy' }]),
    );
  }
  if (spec.externalNetworks?.length) out.networks = ['default', ...spec.externalNetworks];
  const { test, interval, timeout, retries, startPeriod } = spec.healthcheck;
  out.healthcheck = {
    test: [...test],
    interval: interval ?? '30s',
    timeout: timeout ?? '10s',
    retries: retries ?? 5,
    start_period: startPeriod ?? '30s',
  };
  if (spec.stopGracePeriod) out.stop_grace_period = spec.stopGracePeriod;
  if (spec.gpu) {
    out.deploy = {
      resources: {
        reservations: { devices: [{ driver: 'nvidia', count: 'all', capabilities: ['gpu'] }] },
      },
    };
  }
  return out;
}

/**
 * The top-level extension block that says what an install is: Compose keeps `x-` keys and does
 * nothing with them. The parameters are never secrets, and strings are escaped like any other
 * literal, since Compose interpolates extension values too.
 */
export const CATALOG_EXTENSION_KEY = 'x-runova';

function catalogBlock(
  templateId: string,
  versionId: string,
  params: Record<string, unknown>,
  publicUrl: string | null,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    kept[key] = typeof value === 'string' ? literal(value) : value;
  }
  const catalog: Record<string, unknown> = {
    template: templateId,
    version: versionId,
    params: kept,
  };
  if (publicUrl) catalog.domain = new URL(publicUrl).hostname;
  return { catalog };
}

function mask(value: string, secrets: readonly string[]): string {
  let masked = value;
  for (const secret of secrets) masked = masked.split(secret).join(CATALOG_MASKED_SECRET);
  return masked;
}

export function renderCatalogApp(
  template: AnyCatalogTemplate,
  input: CatalogInstallInput,
): CatalogRenderResult {
  const versionId = input.version ?? template.defaultVersion;
  const version = template.versions.find((candidate) => candidate.id === versionId);
  if (!version) {
    return refuse(`${template.name} has no version ${JSON.stringify(versionId)}.`, 'version');
  }

  const parsed = template.parameters.safeParse(input.params ?? {});
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = String(issue.path[0] ?? '');
    const label = template.fields[field]?.label ?? field;
    return refuse(`${label}: ${issue.message}`, field);
  }
  const params = parsed.data as Record<string, unknown>;

  let publicUrl: string | null = null;
  if (input.domain !== undefined && input.domain !== null && input.domain !== '') {
    const domain = validateDomain(input.domain);
    if (!domain.ok) return refuse(domain.reason, 'domain');
    publicUrl = `https://${domain.value}`;
  }

  const inUse = (key: string) => template.secretInUse?.(key, params) ?? true;
  const env: Record<string, string> = {};
  for (const spec of template.secrets) {
    if (!inUse(spec.key)) continue;
    const value = input.secrets[spec.key];
    const problem = checkCatalogSecret(spec, value);
    if (problem) return refuse(problem, spec.key);
    env[spec.key] = value;
  }

  const build = template.build({
    version,
    params,
    publicUrl,
    secret: (key) => {
      if (!Object.hasOwn(env, key)) throw new Error(`The secret ${key} is not in use.`);
      return env[key];
    },
  });

  const services: Record<string, unknown> = {};
  const images: CatalogRender['images'] = [];
  const ports: RenderedCatalogPort[] = [];
  const volumes: string[] = [];
  const networks: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(build.services)) {
    const yaml = serviceYaml(name, spec, version, inUse);
    services[name] = yaml;
    images.push({ service: name, role: spec.image, reference: yaml.image as string });
    for (const port of spec.ports ?? []) {
      ports.push({
        service: name,
        label: port.label,
        hostIp: LOOPBACK,
        published: port.published,
        target: port.target,
        protocol: port.protocol ?? 'tcp',
      });
    }
    for (const { volume } of spec.volumes ?? [])
      if (!volumes.includes(volume)) volumes.push(volume);
    for (const network of spec.externalNetworks ?? []) {
      networks[network] = { name: network, external: true };
    }
  }

  const data: Record<string, unknown> = { services };
  if (volumes.length > 0) data.volumes = Object.fromEntries(volumes.map((name) => [name, {}]));
  if (Object.keys(networks).length > 0) data.networks = networks;
  data[CATALOG_EXTENSION_KEY] = catalogBlock(template.id, version.id, params, publicUrl);
  const document = new Document(data);
  document.commentBefore = [
    ` Written by Runova from the ${template.name} template (${version.label}).`,
    ' Passwords and keys are read from the .env file next to this one.',
  ].join('\n');
  const compose = document.toString({
    lineWidth: 0,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });

  const dotenv = renderComposeEnv(Object.entries(env).map(([key, value]) => ({ key, value })));
  if (!dotenv.ok) return refuse(dotenv.reason, dotenv.key);

  const project = parseComposeFile(compose, { environment: env });
  if (!project.ok) throw new Error(`${template.id} rendered a compose file that does not parse.`);
  const risks = lintComposeProject(project.project);
  const unacknowledged = unacknowledgedRisks(
    risks,
    template.acknowledgments.map((acknowledgment) => acknowledgment.id),
  );

  const secretValues = Object.values(env);
  return {
    ok: true,
    render: {
      templateId: template.id,
      version,
      params,
      compose,
      env,
      envFile: dotenv.text,
      images,
      ports,
      volumes,
      web: build.web,
      publicUrl,
      facts: build.facts.map((fact) => ({ ...fact, masked: mask(fact.value, secretValues) })),
      risks,
      unacknowledged,
    },
  };
}
