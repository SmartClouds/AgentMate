import { interpolateComposeValue, parseComposeFile } from '@runova/core';
import { registryOfImage } from '../../../shared/deploy/registries';

/** The registries a compose file pulls from, as far as this computer can tell them. */
export interface ComposeRegistries {
  registries: string[];
  /**
   * An image takes its registry host from a variable the revision's .env sets. Only the server
   * has that value, so the host cannot be known here.
   */
  unresolved: boolean;
}

/** Stands in for a value the .env sets but this computer does not see. No image name holds it. */
const UNKNOWN = '\u0000';

/**
 * The registries a compose file pulls from (E08): the image of every service that does not build,
 * read as docker compose pull would. Variables are filled in as Compose fills them: a variable
 * the .env does not set takes its default (`${PREFIX:-ghcr.io/acme}/app`), and one it sets is
 * unknown here, which only matters when it is part of the host.
 */
export function registriesOfCompose(
  composeText: string,
  envKeys: readonly string[] = [],
): ComposeRegistries {
  const parsed = parseComposeFile(composeText);
  if (!parsed.ok) return { registries: [], unresolved: false };
  const set = new Set(envKeys);
  const lookup = (name: string) => (set.has(name) ? UNKNOWN : undefined);
  const hosts = new Set<string>();
  let unresolved = false;
  for (const service of parsed.project.services) {
    const { image, build } = service.definition;
    if (build !== undefined || typeof image !== 'string' || image.length === 0) continue;
    const filled = interpolateComposeValue(image, lookup);
    if (!filled.ok) continue;
    const slash = filled.value.indexOf('/');
    const first = slash < 0 ? filled.value : filled.value.slice(0, slash);
    // A broken ${...} or an empty name: Compose refuses those itself, before anything is pulled.
    if (first.length === 0) continue;
    if (first.includes(UNKNOWN)) {
      unresolved = true;
      continue;
    }
    hosts.add(registryOfImage(filled.value));
  }
  return { registries: [...hosts].sort(), unresolved };
}
