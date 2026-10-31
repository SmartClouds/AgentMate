import { readFile, writeFile } from 'node:fs/promises';
import { compareVersions } from '@runova/core';
import type {
  RuntimeKind,
  RuntimeSource,
  RuntimeTarget,
  RuntimeUpdateRequest,
  RuntimeUpdateResult,
} from '../../shared/apiTypes';
import { isNewer } from './runtimeTargets';

/**
 * The shared half of a runtime update. Each adapter lists its runtime targets as candidates that
 * know how to rewrite their own file. An update lists them again rather than trusting the request,
 * so what gets written is always what the list would show right now.
 */

export interface RuntimeUpdateDeps {
  /** The version of a Dev Setup item installed on this machine, or null when it is missing. */
  installedVersion(toolchain: string): Promise<string | null>;
}

export interface RuntimeCandidate {
  target: RuntimeTarget;
  /** The file's new text, or null when the value is no longer where it was. */
  apply(source: string): string | null;
}

const TOOLCHAIN_NAMES: Record<string, string> = {
  bun: 'Bun',
  node: 'Node.js',
  'dotnet-sdk': 'the .NET SDK',
  flutter: 'Flutter',
  dart: 'Dart',
};

export function toolchainName(toolchain: string): string {
  return TOOLCHAIN_NAMES[toolchain] ?? toolchain;
}

interface CandidateInput {
  kind: RuntimeKind;
  source: RuntimeSource;
  declared: string;
  currentVersion: string;
  latestVersion: string | null;
  /** Builds the new value from the latest version. Null when the value is not rewritten. */
  next: ((latest: string) => string) | null;
  requires: ((latest: string) => RuntimeTarget['requires']) | null;
  manifestPath: string;
  projectLabel: string;
  /** Writes the new value into the file's text. */
  rewrite: (source: string, value: string) => string | null;
}

export function runtimeCandidate(input: CandidateInput): RuntimeCandidate {
  const { latestVersion: latest } = input;
  const isOutdated = latest !== null && isNewer(latest, input.currentVersion);
  const nextDeclared = isOutdated && input.next ? input.next(latest) : null;
  return {
    target: {
      kind: input.kind,
      source: input.source,
      declared: input.declared,
      currentVersion: input.currentVersion,
      latestVersion: latest,
      isOutdated,
      nextDeclared,
      requires: isOutdated && input.requires ? input.requires(latest) : null,
      manifestPath: input.manifestPath,
      projectLabel: input.projectLabel,
    },
    apply: (source) => (nextDeclared === null ? null : input.rewrite(source, nextDeclared)),
  };
}

/** Why the installed toolchain can't take the new value, or null when it can. */
export async function toolchainProblem(
  requires: RuntimeTarget['requires'],
  deps: RuntimeUpdateDeps,
): Promise<string | null> {
  if (!requires) return null;
  const name = toolchainName(requires.toolchain);
  let installed: string | null;
  try {
    installed = await deps.installedVersion(requires.toolchain);
  } catch {
    installed = null;
  }
  if (!installed) {
    return `This needs ${name} ${requires.minVersion} or newer, and it was not found on this machine. Install it from Dev Setup first.`;
  }
  if (compareVersions(installed, requires.minVersion) < 0) {
    return `This needs ${name} ${requires.minVersion} or newer, and ${installed} is installed. Upgrade ${name} first.`;
  }
  return null;
}

export async function applyRuntimeUpdate(
  request: RuntimeUpdateRequest,
  candidates: RuntimeCandidate[],
  deps: RuntimeUpdateDeps,
): Promise<RuntimeUpdateResult> {
  const match = candidates.find(
    (c) =>
      c.target.source === request.source &&
      c.target.kind === request.kind &&
      c.target.manifestPath === request.manifestPath,
  );
  if (!match) {
    return { ok: false, message: 'That setting is no longer in the file. Refresh the list.' };
  }
  const { target } = match;
  if (!target.isOutdated) return { ok: false, message: `${target.declared} is already current.` };
  if (target.latestVersion !== request.targetVersion) {
    return {
      ok: false,
      message: `The newest version is now ${target.latestVersion ?? 'unknown'}. Refresh and try again.`,
    };
  }
  if (!target.nextDeclared) {
    return {
      ok: false,
      message: `${target.declared} has a form Runova does not rewrite. Use Update with AI for this one.`,
    };
  }

  const problem = await toolchainProblem(target.requires, deps);
  if (problem) return { ok: false, message: problem };

  let source: string;
  try {
    source = await readFile(target.manifestPath, 'utf-8');
  } catch {
    return { ok: false, message: `Could not read ${target.manifestPath}.` };
  }
  const next = match.apply(source);
  if (next === null) {
    return { ok: false, message: 'The file changed since it was read. Refresh the list.' };
  }
  await writeFile(target.manifestPath, next, 'utf-8');
  return { ok: true, message: `Updated ${target.declared} to ${target.nextDeclared}.` };
}
