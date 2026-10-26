import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import {
  analyzeComposePorts,
  type ComposePortBinding,
  type ComposeProject,
  type ComposeRisk,
  type ComposeRiskSeverity,
  dockerCleanPath,
  lintComposeProject,
  MAX_COMPOSE_FILE_BYTES,
  type Project,
  parseComposeFile,
  renderComposeEnv,
  renderLoopbackOverride,
} from '@runova/core';
import type { ExplorerFileIndex } from '../../../shared/apiTypes';
import type {
  DeployComposeDiscovery,
  DeployComposeFile,
  DeployStackPreview,
  DeployStackPreviewInput,
  DeployStackServicePreview,
} from '../../../shared/deployStacksTypes';
import type { ResolvedProjectEnvironment } from '../../ipc/environments';

/**
 * The Apps wizard's view of a project (E07): which compose files it has, and what one of them
 * turns into on a server with a given environment. Everything is read here, in the main process;
 * the renderer gets service names, ports, env keys and findings, never an env value.
 */

/** compose.yaml, compose.yml, docker-compose.yml, docker-compose.prod.yaml and so on. */
const COMPOSE_FILE = /^(?:compose\.ya?ml|docker-compose[^/]*\.ya?ml)$/i;

/** More than any project has; a list past this is a folder of fixtures, not choices. */
export const MAX_DISCOVERED_FILES = 50;

const SEVERITY_ORDER: Record<ComposeRiskSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface StackSourceDeps {
  project: (projectId: string) => Promise<Project>;
  index: (folder: string) => Promise<ExplorerFileIndex>;
  environment: (projectId: string, environmentId: string) => Promise<ResolvedProjectEnvironment>;
}

/** A compose file read from a project, with everything a preview or an upload needs. */
export interface ReadStackSource {
  project: Project;
  /** The project folder, resolved. */
  root: string;
  composePath: string;
  /** The compose file's own folder: the compose project directory and the build context root. */
  composeDir: string;
  composeText: string;
  environment: ResolvedProjectEnvironment | null;
}

export function isComposeFileName(name: string): boolean {
  return COMPOSE_FILE.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The compose files of a project, shallowest first, each with its service count or why it cannot be read. */
export async function discoverComposeFiles(
  deps: StackSourceDeps,
  projectId: string,
): Promise<DeployComposeDiscovery> {
  const project = await deps.project(projectId);
  const index = await deps.index(project.folderPath);
  const found = index.files
    .filter((path) => isComposeFileName(posix.basename(path)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const files: DeployComposeFile[] = [];
  for (const path of found.slice(0, MAX_DISCOVERED_FILES)) {
    try {
      const text = await readComposeText(index.root, path);
      const parsed = parseComposeFile(text);
      files.push(
        parsed.ok
          ? { path, services: parsed.project.services.length }
          : { path, services: null, error: parsed.reason },
      );
    } catch (error) {
      files.push({ path, services: null, error: (error as Error).message });
    }
  }
  return {
    projectId,
    projectName: project.name,
    files,
    truncated: index.truncated || found.length > MAX_DISCOVERED_FILES,
  };
}

/** Reads a compose file by its path relative to the project, refusing anything that leaves it. */
async function readComposeText(root: string, composePath: string): Promise<string> {
  if (
    typeof composePath !== 'string' ||
    composePath === '' ||
    isAbsolute(composePath) ||
    composePath.includes('\\') ||
    composePath.split('/').includes('..')
  ) {
    throw new Error('Pick a compose file inside the project.');
  }
  if (!isComposeFileName(posix.basename(composePath))) {
    throw new Error('That is not a compose file (compose.yaml or docker-compose.yml).');
  }
  const full = resolve(root, ...composePath.split('/'));
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(full)]);
  if (!within(realRoot, realFile)) throw new Error('That compose file leads out of the project.');
  const info = await lstat(realFile);
  if (!info.isFile()) throw new Error('That compose file is not a file.');
  if (info.size > MAX_COMPOSE_FILE_BYTES) {
    throw new Error(
      `The compose file is larger than ${MAX_COMPOSE_FILE_BYTES / (1024 * 1024)} MB.`,
    );
  }
  return readFile(realFile, 'utf8');
}

export async function readStackSource(
  deps: StackSourceDeps,
  input: { projectId: string; composePath: string; environmentId: string | null },
): Promise<ReadStackSource> {
  const project = await deps.project(input.projectId);
  const root = resolve(project.folderPath);
  const composeText = await readComposeText(root, input.composePath);
  const environment = input.environmentId
    ? await deps.environment(input.projectId, input.environmentId)
    : null;
  const composeDir = dirname(resolve(root, ...input.composePath.split('/')));
  return { project, root, composePath: input.composePath, composeDir, composeText, environment };
}

const relativeSource = (value: unknown): boolean =>
  typeof value === 'string' && (value === '.' || value.startsWith('./') || value.startsWith('../'));

/**
 * Why the compose folder has to go to the server with the files, or null: a service builds, or
 * the file reads something relative to itself (env files, bind mounts, secrets and configs).
 */
export function buildContextReason(project: ComposeProject): string | null {
  for (const { name, definition } of project.services) {
    if (definition.build !== undefined) return `${name} builds from the project.`;
  }
  for (const { name, definition } of project.services) {
    const envFiles = Array.isArray(definition.env_file)
      ? definition.env_file
      : definition.env_file === undefined
        ? []
        : [definition.env_file];
    for (const entry of envFiles) {
      const path = typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined;
      if (typeof path === 'string' && !path.startsWith('/')) {
        return `${name} reads ${path} from the project.`;
      }
    }
    for (const entry of Array.isArray(definition.volumes) ? definition.volumes : []) {
      const source =
        typeof entry === 'string' ? entry.split(':')[0] : isRecord(entry) ? entry.source : null;
      if (relativeSource(source) && (typeof entry === 'string' || entry.type === 'bind')) {
        return `${name} mounts ${String(source)} from the project.`;
      }
    }
  }
  for (const kind of ['configs', 'secrets'] as const) {
    const section = project.data[kind];
    if (!isRecord(section)) continue;
    for (const [name, item] of Object.entries(section)) {
      if (isRecord(item) && typeof item.file === 'string' && !item.file.startsWith('/')) {
        return `The ${kind === 'secrets' ? 'secret' : 'config'} ${name} comes from ${item.file} in the project.`;
      }
    }
  }
  return null;
}

/**
 * Dockerfiles inside the compose folder, relative to it, that must go into the context even when
 * .dockerignore leaves them out (Docker always sends a build's own Dockerfile).
 */
export function dockerfilesOf(project: ComposeProject): string[] {
  const files = new Set<string>();
  for (const { definition } of project.services) {
    const { build } = definition;
    let context: string | null = null;
    let dockerfile = 'Dockerfile';
    if (typeof build === 'string') context = build;
    if (isRecord(build)) {
      context = typeof build.context === 'string' ? build.context : '.';
      if (typeof build.dockerfile === 'string') dockerfile = build.dockerfile;
    }
    if (context === null || /^[a-z][a-z0-9+.-]*:\/\//i.test(context)) continue;
    const path = dockerCleanPath(posix.join(context, dockerfile));
    if (path !== '..' && !path.startsWith('../') && !path.startsWith('/')) files.add(path);
  }
  return [...files];
}

function servicePreview(
  project: ComposeProject,
): Map<string, Omit<DeployStackServicePreview, 'name'>> {
  const ports = analyzeComposePorts(project);
  const services = new Map<string, Omit<DeployStackServicePreview, 'name'>>();
  project.services.forEach(({ name, definition }, index) => {
    const info = ports[index];
    services.set(name, {
      image: typeof definition.image === 'string' ? definition.image : null,
      builds: definition.build !== undefined,
      ports: info.bindings,
      publishes: info.bindings.length > 0,
      hostNetwork: info.hostNetwork,
    });
  });
  return services;
}

/** Variables compose reads from the shell when no .env sets them; never worth a warning. */
const SHELL_ONLY = new Set(['PWD', 'HOME', 'USER']);

/**
 * What a compose file and environment turn into on the server: services, the ports once the
 * loopback override applies, the override itself, the findings and what needs acknowledging,
 * the env keys (not values), and whether a build context goes too. `blocking` says why it cannot
 * be deployed at all.
 */
export async function previewStack(
  deps: StackSourceDeps,
  input: DeployStackPreviewInput,
): Promise<DeployStackPreview> {
  const source = await readStackSource(deps, input);
  // The rendered .env holds the values: it stays here, and so does the parsed file.
  const {
    envText: _envText,
    project: _project,
    ...preview
  } = previewFromSource(source, input.proxiedServices, input.selinuxEnforcing === true);
  return preview;
}

export function previewFromSource(
  source: ReadStackSource,
  proxiedServices: readonly string[] | undefined,
  selinuxEnforcing: boolean,
): DeployStackPreview & { envText: string | null; project: ComposeProject | null } {
  const entries = source.environment?.entries ?? [];
  const empty = {
    projectName: source.project.name,
    composePath: source.composePath,
    composeName: null,
    services: [],
    envKeys: entries.map((entry) => entry.key),
    envFiles: source.environment?.files.map((file) => file.fileName) ?? [],
    missingVariables: [],
    proxiedServices: [],
    bindings: [],
    overrideText: '',
    risks: [],
    requiresAcknowledgment: [],
    buildContext: null,
    envText: null,
    project: null,
  };
  const env = renderComposeEnv(entries);
  if (!env.ok) return { ...empty, blocking: env.reason };
  const parsed = parseComposeFile(source.composeText, {
    environment: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
  });
  if (!parsed.ok) {
    return {
      ...empty,
      envText: env.text,
      blocking: parsed.line ? `Line ${parsed.line}: ${parsed.reason}` : parsed.reason,
    };
  }
  const { project } = parsed;
  if (project.services.length === 0) {
    return { ...empty, envText: env.text, blocking: 'The compose file has no services.' };
  }

  const services = servicePreview(project);
  const canProxy = (name: string) => {
    const service = services.get(name);
    return !!service && service.publishes && !service.hostNetwork;
  };
  const proxied = (proxiedServices ?? [...services.keys()]).filter(canProxy);
  const override = renderLoopbackOverride(project, proxied);
  const rebound = override.ok ? override.override.rebound : [];
  const bindings: ComposePortBinding[] = [];
  for (const [name, service] of services) {
    if (proxied.includes(name)) {
      bindings.push(...rebound.filter((binding) => binding.service === name));
    } else {
      bindings.push(...service.ports);
    }
  }
  const risks = [...lintComposeProject(project, { proxiedServices: proxied, selinuxEnforcing })]
    .map((found, order) => ({ found, order }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.found.severity] - SEVERITY_ORDER[b.found.severity] || a.order - b.order,
    )
    .map(({ found }) => found);

  return {
    ...empty,
    composeName: project.name,
    services: [...services].map(([name, service]) => ({ name, ...service })),
    missingVariables: project.missingVariables.filter((name) => !SHELL_ONLY.has(name)),
    proxiedServices: proxied,
    bindings,
    overrideText: override.ok ? override.override.text : '',
    risks,
    requiresAcknowledgment: needsAcknowledgment(risks),
    buildContext: buildContextReason(project),
    blocking: override.ok ? null : override.reason,
    envText: env.text,
    project,
  };
}

/** Every finding but the low ones waits for its own acknowledgment. */
export function needsAcknowledgment(risks: readonly ComposeRisk[]): string[] {
  return risks.filter((found) => found.severity !== 'low').map((found) => found.id);
}
