import type { Project } from '@runova/core';

/**
 * Which of this computer's projects a container belongs to (E06 T9), until stacks deployed from
 * the app link them for real (E07). Compose names a project after its folder, lower case with
 * anything but letters, digits, dashes and underscores taken out, so a container of compose
 * project "shop" belongs to the project named "Shop" or kept in a folder called "shop". A link the
 * user picked by hand comes first.
 */

export function composeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  );
}

/** The key a hand-picked link is kept under: the compose project, or the container's name. */
export function linkKey(
  serverId: string,
  composeProject: string | undefined,
  name: string,
): string {
  return composeProject ? `${serverId}:project:${composeProject}` : `${serverId}:container:${name}`;
}

export function matchProject(
  projects: readonly Project[],
  options: { composeProject?: string; linkedProjectId?: string | null },
): Project | null {
  if (options.linkedProjectId) {
    const linked = projects.find((project) => project.id === options.linkedProjectId);
    if (linked) return linked;
  }
  if (!options.composeProject) return null;
  const wanted = composeName(options.composeProject);
  if (!wanted) return null;
  return (
    projects.find((project) => composeName(folderName(project.folderPath)) === wanted) ??
    projects.find((project) => composeName(project.name) === wanted) ??
    null
  );
}
