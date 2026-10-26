import { parseComposeFile } from '@runova/core';
import { registryOfImage } from '../../../shared/deploy/registries';

/**
 * The registries a compose file pulls from (E08): the image of every service that does not build,
 * read as docker compose pull would. A host written as a variable (`${REGISTRY}/app`) cannot be
 * known here, so that image is left out; a variable later in the name (`app:${TAG}`) is fine.
 */
export function registriesOfCompose(composeText: string): string[] {
  const parsed = parseComposeFile(composeText);
  if (!parsed.ok) return [];
  const hosts = new Set<string>();
  for (const service of parsed.project.services) {
    const { image, build } = service.definition;
    if (build !== undefined || typeof image !== 'string' || image.length === 0) continue;
    const slash = image.indexOf('/');
    if (slash >= 0 && image.slice(0, slash).includes('$')) continue;
    if (slash < 0 && image.startsWith('$')) continue;
    hosts.add(registryOfImage(image));
  }
  return [...hosts].sort();
}
